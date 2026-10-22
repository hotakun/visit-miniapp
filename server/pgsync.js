// 聚火拜访 · PG 同步器（2026-10-09）
// ---------------------------------------------------------------------------
// 跑在**你自己的服务器**上：每 N 分钟把云开发里"变动过的"客户拉进 PG，让 PG 保持最新。
// 用法：node pgsync.js        （需同目录 pgsync.config.json + admin/config.json）
// ⚠️ 单向：只**读**云开发（调 adminapi.custSync）、只**写**自己的 PG，不会互相污染。
// ⚠️ 成本：每次只拉变动的那几十条（不是全量！）→ 几乎不花钱。
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'pgsync.config.json'), 'utf8'));
const MIN = Number(CFG.intervalMinutes) || 1;   // ⭐ 2026-10-12 老板定：5 分钟 → **1 分钟**（后台改问服务器后，靠它把手机端建的店带过来）

// 云端简写字段 → PG 列名（必须与 admin/tools/pg_import.sql 的列顺序一致）
const MAP = [['id','i'],['name','n'],['name_raw','nr'],['code','mc'],['ctype','ct'],['source','so'],
  ['phone','ph'],['address','ad'],['city','c'],['district','d'],['biz_circle','b'],
  ['lat','la'],['lng','ln'],['coord_source','cs'],['coord_status','cst'],
  ['mall_key','mk'],['mall_joined_at','mj'],['remark','rm'],['batch_ids','bi'],
  ['created_at','ca'],['updated_at','u'],
  // ⭐⭐ 2026-10-16（老板定「这 9 列 PG 里没有…同步器也要拉」）：补齐 8 列。
  //   ⚠️ 方向是 **[PG 列名, 云端短键]**（与 admin/store.js 的 M 表**相反**，别写反）。
  //   ⚠️ 云端字段驼峰 → 短键（见 adminapi 的 custSync/custMapPoints）：region→reg · salesman→sm ·
  //      mallLevel→ml · mallSource→msrc · mallCategory→mcat ·
  //      lastOrderAt→clor · lastBrowseAt→clbr · phone2→ph2
  ['region','reg'],['salesman','sm'],['mall_level','ml'],['mall_source','msrc'],['mall_category','mcat'],
  ['last_order_at','clor'],['last_browse_at','clbr'],['phone2','ph2']];
const COLS = MAP.map(x => x[0]);
const UPSERT = 'INSERT INTO customers (' + COLS.join(',') + ') VALUES (' +
  COLS.map((_, i) => '$' + (i + 1)).join(',') + ') ON CONFLICT (id) DO UPDATE SET ' +
  COLS.filter(c => c !== 'id').map(c => c + '=EXCLUDED.' + c).join(',') +
  // ⭐⭐ 2026-10-12（老板追问「云端与服务器之间会漏信息，你弥补了吗」逼出来的**对称修复**）：
  //   `custSync` **只返回"未删"的客户** → 凡是同步过来的，就一定是"活的"。
  //   所以这里顺手把 `deleted` 设回 false —— 正好与「已删名单」那句 `UPDATE ... deleted=true` 对称：
  //   **删掉的能标上、恢复的也能自动纠回**（否则从回收站恢复的客户会被那句标删、永远卡在"已删"）。
  //   ⚠️ 两者天然互斥：同一时刻，一条客户要么出现在 custSync 的结果里、要么出现在 deletedIds 里。
  ', deleted = false';

let db = null;
const cfgPath = path.join(__dirname, 'config.json');   // 微信凭据（appid/appsecret/envId）——与脚本同级
let tk = null, tkAt = 0;

async function token(force) {
  if (!force && tk && Date.now() - tkAt < 90 * 60 * 1000) return tk;   // 微信 token 有效期 2 小时，留余量
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // ⚠️⚠️ 2026-10-10 修复（pgsync 曾因此持续停摆）：**必须用 stable_token 接口**。
  //   老接口 /cgi-bin/token 与 stable_token 拿的是同一套凭证、**会互相踢**：
  //   开发机后台（server.js）一直用 stable_token，而这里曾用老接口 → 每次刷新都把对方的 token 作废，
  //   实测现象 = pgsync 日志刷 "access_token is invalid or not latest"（微信报错原文也点名让改 stable_token），
  //   同步完全停摆。改成同一套接口后两边互不影响。
  //   ⚠️ 2026-10-13 补充：**这条只保证了"我们自己不踢"，挡不住别人踢** ——
  //       `admin/tools/` 下曾有一批脚本（run_adminapi / add_index / import_biz_* …）
  //       以及临时探针还在用老接口 → 谁跑一次，这里就失效（见下面 callCloud 的自愈）。
  const r = await (await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: c.appid, secret: c.appsecret, force_refresh: !!force })
  })).json();
  if (!r.access_token) throw new Error('取 token 失败: ' + (r.errmsg || r.errcode));
  tk = r.access_token; tkAt = Date.now();
  return tk;
}
// ⭐⭐ 2026-10-13：**token 失效必须自愈**（当天真实事故：pgsync 停摆 46 分钟、后台数据不更新）
//   现象：日志连续刷 `[sync] 这轮失败（下轮再试）: 调用云函数失败: access_token expired`，水位卡死不动。
//   两个病根：
//     ① 别处（老接口脚本 / 临时探针）取 token 会把我们这份顶掉 → 微信报 `access_token expired`（errcode 42001），
//        **而原来的自愈只认 40001 / invalid credential** → 不清缓存 → 每轮都用坏 token → 永远不恢复；
//     ② 就算清了缓存，`force_refresh:false` 也可能原样拿回同一个已失效的 token。
//   现在：token 类错误**一律清缓存 + 强制刷新重试一次**（一轮内自愈，最多损失一分钟）。
const isTokenErr = (code, msg) => [40001, 40014, 42001, 42007, 42008].indexOf(Number(code)) >= 0 ||
  /invalid credential|access_token|not latest|expired/i.test(String(msg || ''));
async function callCloud(action, extra) {                     // 调云函数（与 run_adminapi.js 同一套）
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const body = Object.assign({ action, username: CFG.apiUser || 'qingyan', password: CFG.apiPassword || '123456' }, extra || {});
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const t = await token(attempt > 0);      // 第 2 次：强制刷新
    const r = await (await fetch('https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=' + t +
      '&env=' + c.envId + '&name=adminapi', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })).json();
    if (!r.errcode) {
      let out = r.resp_data;
      try { out = JSON.parse(out); } catch (e) { /* 原样 */ }
      return out;
    }
    lastErr = '调用云函数失败: ' + (r.errmsg || r.errcode);
    if (attempt === 0 && isTokenErr(r.errcode, r.errmsg)) {
      tk = null; tkAt = 0;
      console.warn('[sync] token 失效（' + (r.errmsg || r.errcode) + '）→ 强制刷新后重试一次');
      continue;
    }
    throw new Error(lastErr);
  }
  throw new Error(lastErr || '调用云函数失败');
}
async function conn() {
  if (!db) {
    db = new Client({ host: CFG.pgHost || '127.0.0.1', port: CFG.pgPort || 5432,
      database: CFG.pgDatabase || 'juhuo', user: CFG.pgUser, password: CFG.pgPassword });
    db.on('error', (e) => { console.error('[sync] PG 断开:', e.message); db = null; });
    await db.connect();
  }
  return db;
}
async function watermark() {
  try { const r = await (await conn()).query("SELECT watermark FROM sync_state WHERE name='customers'"); return Number(r.rows[0] && r.rows[0].watermark) || 0; }
  catch (e) { return 0; }
}
async function setWatermark(w) {
  await (await conn()).query("INSERT INTO sync_state (name,watermark,synced_at) VALUES ('customers',$1,$2) " +
    'ON CONFLICT (name) DO UPDATE SET watermark=$1, synced_at=$2', [w, Date.now()]);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ⭐ 2026-10-12 省调用量 ③：把云端的「变化时间戳」同步到 PG（后台据此决定"要不要叫云端"）
//   云端 `pollDirtyAt`（拜访/坐标报错/注册）与 `custDirtyAt`（加新店）—— 都存进 sync_state。
//   ⚠️ 失败只记日志（下轮再试），绝不影响其它同步。
async function syncPollDirty() {
  try {
    const r = await callCloud('pollDirty', {});
    if (!r || !r.ok) throw new Error('pollDirty 返回异常');
    const put = async (name, w) => {
      await (await conn()).query(
        'INSERT INTO sync_state (name,watermark,synced_at) VALUES ($1,$2,$3) ' +
        'ON CONFLICT (name) DO UPDATE SET watermark=$2, synced_at=$3', [name, w, Date.now()]);
    };
    // ⭐ 2026-10-14：**本轮信号值留一份给 round() 判断"要不要跑全套"**（见 round 开头的跳过逻辑）
    _pollSeen = Number(r.pollDirtyAt) || 0;
    _custSeen = Number(r.custDirtyAt) || 0;
    _taskSeen = Number(r.taskDirtyAt) || 0;
    // ⭐ 2026-10-14：**拜访同步也借这个信号** —— `pollDirtyAt` 由"拜访提交/取消、坐标报错、注册"共同写，
    //   拿它判断"这轮要不要全量对账 visits"，**零额外云端调用**（老板定：增量 + 删除名单 + 兜底）。
    _visitSeen = _pollSeen;
    await put('pollDirtyAt', _pollSeen);
    await put('custDirtyAt', _custSeen);
    await put('taskDirtyAt', _taskSeen);
    // ⭐⭐ 2026-10-14：批次成员变动信号（后台建/删批次、加/移成员时写）——
    //   同步器据此决定"这轮要不要全量对账 batch_members"：**有变动才全量，没变动纯增量**。
    //   ⚠️ 搭 pollDirty 的顺风车带回来，**不增加任何云端调用**。
    _bmDirtySeen = Number(r.batchDirtyAt) || 0;
    await put('batchDirtyAt', _bmDirtySeen);        // 顺带在 PG 留一份，方便排查
    // ⭐⭐ 2026-10-12 老板定（零额外调用）：**顺路收下"最近删掉的客户 id"写进 PG** ——
    //   云端 `pollDirty` 在同一次回答里捎带 `deletedIds`（不增加云端调用次数，老板拍板这个方案）；
    //   `pgapi /newshops` 用它排除 —— 后台「新店」列表里**删掉的店就不会再显示**。
    if (Array.isArray(r.deletedIds)) {
      const d = await conn();
      // ⚠️⚠️ 2026-10-12 实测踩坑（老板连问三次的病根）：这张表**早就存在**，真实列是 `id / tbl / deleted_at`
      //   —— 我按自己想的 `at` 写 → 每分钟报「关系 "deleted_ids" 的 "at" 字段不存在」→ **名单一条都进不去**。
      //   以后动这张表，先看一眼 `SELECT column_name FROM information_schema.columns`。
      await d.query('CREATE TABLE IF NOT EXISTS deleted_ids (id text PRIMARY KEY, tbl text, deleted_at bigint)');
      for (const id of r.deletedIds) {
        await d.query('INSERT INTO deleted_ids (id,tbl,deleted_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [String(id), 'customers', Date.now()]);
      }
      // ⭐⭐ 2026-10-12 老板实测：「我让你删掉的移动水果摊位，客户管理里还在，回收站也有一个」——
      //   根因：云端的增量同步**刻意跳过已删客户** → PG 的 `customers.deleted` 永远是 false
      //   → 所有 `WHERE deleted = false` 的查询（/points 拉缓存、/newshops、统计…）全把它当"没删"。
      //   修法：**顺手把 PG 里这些客户也标成已删** —— 一处治全（以后谁写 `deleted = false` 都自动对）。
      if (r.deletedIds.length) {
        await d.query('UPDATE customers SET deleted = true WHERE id = ANY($1::text[])', [r.deletedIds.map(String)]);
      }
    }
    // ⭐⭐ 2026-10-15 老板定（原话：「为了检测拜访历史的删除，每次耗费这么多太不合算了」）：
    //   **按"删除名单"删拜访** —— 原来增量扫不到"已消失的文档"，只能每轮 `DELETE` + 全量重拉。
    //   ① 名单里的 id → 直接从 PG 的 `visits` 删掉；② 顺手往 `deleted_ids` 留档（`tbl='visits'`），与客户那套一致。
    //   ⚠️ 名单由云端 `pollDirty` **顺路带回**（零额外云端调用）；万一漏了，靠 1 小时兜底的全量对账兜住。
    // ⭐⭐ 2026-10-14 核查补漏：名单是"近 7 天"的，而这段在 **每轮** 都跑（`syncPollDirty`）→
    //   同一批 id 会被**每 5 分钟重复删一次**（日志里「visits 按删除名单删掉 6 条」刷了一整屏）。
    //   删除本身幂等、无害，但白做无用的 DELETE + 污染日志（排查时看不到真正的新动作）。
    //   这里用内存 Set 记住"本进程已处理过的 id"，**只处理新增的**（进程重启会重删一次，无妨）。
    if (Array.isArray(r.deletedVisitIds) && r.deletedVisitIds.length) {
      const fresh = r.deletedVisitIds.map(String).filter(id => !_deletedVisitSeen.has(id));
      if (fresh.length) {
        try {
          const d2 = await conn();
          await d2.query('DELETE FROM visits WHERE id = ANY($1::text[])', [fresh]);
          await d2.query('CREATE TABLE IF NOT EXISTS deleted_ids (id text PRIMARY KEY, tbl text, deleted_at bigint)');
          for (const id of fresh) {
            await d2.query('INSERT INTO deleted_ids (id,tbl,deleted_at) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [id, 'visits', Date.now()]);
            _deletedVisitSeen.add(id);
          }
          console.log(`[sync] visits 按删除名单删掉 ${fresh.length} 条`);
        } catch (e) { console.error('[sync] visits 删除名单处理失败（下轮再试）:', e.message); }
      }
    }
  } catch (e) { console.error('[sync] pollDirty 同步失败（下轮再试）:', e.message); }
}

// ⭐⭐ 2026-10-13 老板定：**待配对池** —— 把"最近一次导入的那批商城客户"灌进 PG 的 `mall_pending`，
//   供**老板和文员两台电脑**共同处理（配对 / 新建 / 跳过）；**处理完才写云端**。
//   ⚠️ 数据源 = 云端 `exportMallPending`（读 settings.lastMallKeys，只给"那一次导入的那批"）。
//   ⚠️ 幂等：ON CONFLICT 只更新商城侧字段，**不动 status/target/handled_***（已处理过的不被覆盖）。
async function syncMallPending() {
  try {
    const d = await conn();
    let after = '', all = [], total = 0;
    for (let i = 0; i < 40; i++) {
      const r = await callCloud('exportMallPending', { after: after, limit: 200 });
      if (!r || !r.ok) throw new Error('exportMallPending 返回异常');
      total = Number(r.total) || 0;
      (r.list || []).forEach(x => all.push(x));
      if (!r.hasMore || !r.last) break;
      after = r.last;
    }
    for (const x of all) {
      // ⭐ 2026-10-18 老板定：导入文件今后有**两种**（带经纬度列 / 不带）。带坐标的要把 lat/lng 一起灌进 PG，
      //   否则「商城待配对」里那条没坐标、筛选时用不上。
      //   ⚠️ `COALESCE(EXCLUDED.lat, mall_pending.lat)` —— **新值空就保留旧值**：
      //      · 重导一份"不带坐标"的表，不会把之前（或手工填）的坐标抹掉；
      //      · 带坐标的才覆盖。
      await d.query(
        'INSERT INTO mall_pending (mall_key,name,phone,address,region,mall_code,added_at,imported_at,lat,lng) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (mall_key) DO UPDATE SET ' +
        'name=EXCLUDED.name, phone=EXCLUDED.phone, address=EXCLUDED.address, region=EXCLUDED.region, ' +
        'mall_code=EXCLUDED.mall_code, added_at=EXCLUDED.added_at, ' +
        'lat=COALESCE(EXCLUDED.lat, mall_pending.lat), lng=COALESCE(EXCLUDED.lng, mall_pending.lng)',
        [String(x.k || ''), String(x.n || ''), String(x.p || ''), String(x.a || ''),
         String(x.r || ''), String(x.c || ''), String(x.t || ''), Date.now(),
         (x.la != null && isFinite(Number(x.la))) ? Number(x.la) : null,
         (x.ln != null && isFinite(Number(x.ln))) ? Number(x.ln) : null]);
    }
    if (all.length) console.log('[sync] mall_pending 灌/更新', all.length, '家（这批共', total, '家）');
  } catch (e) { console.error('[sync] mall_pending 同步失败（下轮再试）:', e.message); }
}

// ⭐⭐ 2026-10-15 新增：**客户增量同步**（从 round() 的主干里抽出来）——
//   抽出来的唯一目的：让它可以**每轮无条件调用**（不受下面"有变动才跑"的门限制）。
//   背景见 round() 开头那段说明（老板实测：改了店名 → 详情对了、后台列表还是旧名）。
async function syncCustomers() {
  let since = await watermark(), got = 0, maxU = since;
  // ⭐⭐ 2026-10-14 修（依《全项目审查》D01，报告属实 —— 这是"后台永久漏客户"的根因）：
  //   ⚠️ 原来每页都 `since = maxU`（用"本批最大 updatedAt"当前进水位），**且从不传 cursor** ——
  //      而云端是**按 `_id` 升序分页**的。两个维度一错位：
  //      「`_id` 靠后、但 `updatedAt` 更旧」的记录会被 `updatedAt > maxU` 过滤掉，
  //      **永久漏掉、下次也不会补**（报告的例子：1500 条里后 500 条全丢）。
  //   ✅ 正确做法（本轮固定 since，只推进游标；**全部成功后才提交水位**）：
  //      · `since` **整轮不动** → 凡是 `updatedAt > since` 的记录都会被完整翻一遍，一个不漏；
  //      · 翻页靠云端返回的 `next`（本批最后一条 `_id`），它本来就返回、以前没用；
  //      · 中途任何一页失败 → 前面 `throw` 掉、**不提交水位** → 下轮从旧水位重跑（重复 upsert 无害）。
  let cursor = '';
  // ⚠️ 上限 = 300 轮（30 万条/轮）：**必须够跑一轮全量** —— 库内约 17.87 万家 ÷ 1000 = 179 页，
  //    若上限低于它，"重置水位后补历史"会在中途停下、还把水位提交上去 → 剩下的又漏。
  //    （2026-10-14 实测：分段翻页正常、零重复；旧做法在抽样 1200 条里会漏约 900 条。）
  for (let i = 0; i < 300; i++) {
    const r = await callCloud('custSync', { since, limit: 1000, cursor });
    if (!r || !r.ok) throw new Error('custSync 返回异常: ' + JSON.stringify(r).slice(0, 200));
    // ⚠️ 2026-10-09 实测：custSync 返回的字段名是 **points**（不是 list/rows）——
    //    写错会"拿不到数据但也不报错"，表现为同步器空转、水位不动（踩过一次）
    const list = r.points || r.list || r.rows || [];
    if (!list.length) break;
    for (const p of list) {
      const vals = MAP.map(x => { const v = p[x[1]]; return v === undefined || v === null ? '' : v; });
      await (await conn()).query(UPSERT, vals);
      if (Number(p.u) > maxU) maxU = Number(p.u);
      got++;
    }
    // ⚠️⚠️ 这里**绝不能**再写 `since = maxU`（那就是 D01 的 bug）；只推进游标。
    cursor = r.next || '';
    if (!cursor || list.length < 1000) break;
    await sleep(200);
  }
  if (got) {
    // ⚠️ 到上限说明"这轮没翻完"：**照旧提交水位**（否则下轮重头、永远跑不完），但要**大声记一笔**，
    //    好判断"是不是该把上限再调大 / 该换 (updatedAt,id) 复合水位"。
    if (cursor) console.warn(`[sync] ⚠️ 本轮到了翻页上限还没翻完（已补 ${got} 条），剩余留到下一轮：把上限调大或需要复合水位`);
    await setWatermark(maxU);
    console.log(`[sync] 补了 ${got} 条，水位 → ${new Date(maxU).toLocaleString()}`);
  }
}

async function round() {
  // ⭐⭐ 2026-10-14 老板定（方案 D：**有变动才跑**）——
  //   `pollDirty` 一次调用带回云端全部「变动时间戳」；**三个都没变 → 整轮只花这 1 次调用**，
  //   跳过后面 6 个同步（原来每轮无条件全跑 ≈ 7 次/轮 ≈ 2100 次/天，其中绝大多数是"没人在用"的空转）。
  //   ⚠️ **兜底**：信号一直没变也每 IDLE_FALLBACK_MIN 分钟无条件跑一轮（防漏写信号 → 静默不更新）。
  try { await syncPollDirty(); } catch (e) { console.error('[sync] pollDirty 失败（下轮再试）:', e.message); }
  const _changed = (_pollSeen && _pollSeen !== _lastPollHandled)
    || (_custSeen && _custSeen !== _lastCustHandled)
    || (_taskSeen && _taskSeen !== _lastTaskHandled)
    || (_bmDirtySeen && _bmDirtySeen !== _lastBmDirtyHandled);
  const _idleTooLong = !_lastBusyRun || (Date.now() - _lastBusyRun >= IDLE_FALLBACK_MIN * 60000);
  // ⭐⭐ 2026-10-15 修（老板实测撞上：手机端/后台改了客户 → 详情页对了，但**后台列表还是旧名**）：
  //   **客户增量同步必须【每轮都跑】**，不能等变动信号 —— 因为"会改客户"的写点太多：
  //   后台改字段(updateCustomerFields) / 手机端「更正信息」(correctCustomer) / 商城更新(applyMallMatch·refreshFromMall)
  //   / 现场提报采纳 / 删客户·恢复客户 …… **只要漏写一处 `custDirtyAt`，那条改动就要等兜底**
  //   （最长 IDLE_FALLBACK_MIN 分钟）才看得见。实测：`custDirtyAt` 停在 10-14 04:22 UTC，而客户改动在 10-14 21:43 UTC
  //   → 信号没动 → 整轮被跳过 → PG 一直停在昨天。
  //   ⚠️ 成本极低：`custSync` 是**增量**（按水位拉，通常 0~几条 upsert）——
  //      真正贵的是 `batch_members`（5585 条全量）/ `visits`（全量对账）那种**全量重拉**，
  //      那些仍然留在下面这道门之后（省调用的大头照省）。
  //   ⚠️ 单独 try/catch：客户同步万一失败，**不能连累**后面那 6 项（各自也有 try/catch）。
  try { await syncCustomers(); } catch (e) { console.error('[sync] 客户增量同步失败（下轮再试）:', e.message); }
  if (!_forceFull && !_changed && !_idleTooLong) {
    const _left = Math.max(0, Math.round((IDLE_FALLBACK_MIN * 60000 - (Date.now() - _lastBusyRun)) / 60000));
    console.log('[sync] 无变动 → 只查了信号（省调用；约 ' + _left + ' 分钟后兜底跑一轮）');
    return;
  }
  _forceFull = false;            // ⭐ 强制那一轮已经进门了，复位（别让后面每轮都全跑）
  _lastBusyRun = Date.now();
  _lastPollHandled = _pollSeen;
  _lastCustHandled = _custSeen;
  // ⭐⭐ 2026-10-14 补漏（老板要求"抱着找茬的态度逐项核查"时揪出来的）：
  //   `_lastTaskHandled` **只在上面 `_changed` 判断里被用过、从来没人给它赋值** →
  //   只要云端存在过 `taskDirtyAt`（建/改/派/撤任务都会写），`_taskSeen !== 0` **恒为真** →
  //   `_changed` 永远成立 → **「有变动才跑」彻底失效、每轮照样跑全套**（方案 D 等于没生效）。
  //   这里在"跑完全套"之后补上赋值，与 `_lastPollHandled` / `_lastCustHandled` 同级。
  //   ⚠️ 另外两个（`_lastBmDirtyHandled` / `_lastVisitDirtyHandled`）是在各自"全量对账跑完"后赋值的，
  //      语义更精确，**不要**挪到这里来。
  _lastTaskHandled = _taskSeen;

  // ⚠️ 2026-10-15：客户同步那段已抽成 `syncCustomers()`，并**提到上面那道门之前**（每轮都跑）——
  //    原因见 round() 开头处的说明。这里**不再重复跑一遍**（原来它就在这个位置）。
  // ⭐ 顺带同步批次成员（失败不影响上面 customers 的结果，下轮再试）
  // ⚠️ 2026-10-14：`syncPollDirty()` 已提到 round() 开头（信号判断要用它），这里**不再重复调**。
  try { await syncBatchMembers(); } catch (e) { console.error('[sync] batch_members 同步失败（下轮再试）:', e.message); }
  // ⭐⭐ 2026-10-10 指针表模式第 5 步：批次卡 / 任务 / 已拜访客户也进 PG ——
  //    后台「📦 批次管理」从此**彻底不再问云开发**（批次页每个数字 = 一条 SQL）。
  //    ⚠️ 三者相互独立，各自 try/catch：云端还没重传新导出接口时只是这几行报错，主同步照常。
  try { await syncCustomerBatches(); } catch (e) { console.error('[sync] customer_batches 同步失败（下轮再试）:', e.message); }
  try { await syncTasks(); } catch (e) { console.error('[sync] tasks 同步失败（下轮再试）:', e.message); }
  try { await syncVisitedCustomers(); } catch (e) { console.error('[sync] visited_customers 同步失败（下轮再试）:', e.message); }
  // ⭐ 2026-10-11 老板定：「📝 拜访记录」两页改走轻量服务器 → 拜访**明细**也进 PG
  try { await syncVisits(); } catch (e) { console.error('[sync] visits 同步失败（下轮再试）:', e.message); }
  try { await syncMallPending(); } catch (e) { console.error('[sync] mall_pending 同步失败（下轮再试）:', e.message); }
  // ⭐ 2026-10-15（《订单本地方案》第 3 块）：订单/明细同步 + 聚合重算（后台那 6 列的数据来源）
  //   ⚠️ 订单同步是**增量**（`since` 不变时通常 0 条，一次调用就回）—— 每轮跑无压力。
  //   ⚠️ 聚合重算是**全量**（17.8 万家一条 SQL，几秒）→ 加 **10 分钟节流**，别每 5 分钟都算一遍。
  try { await syncOrders(); } catch (e) { console.error('[sync] orders 同步失败（下轮再试）:', e.message); }
  try { await syncOrderItems(); } catch (e) { console.error('[sync] order_items 同步失败（下轮再试）:', e.message); }
  if (!_lastCustAgg || Date.now() - _lastCustAgg >= 10 * 60 * 1000) {
    try { await recalcCustAgg(); _lastCustAgg = Date.now(); }
    catch (e) { console.error('[sync] 聚合重算失败（下轮再试）:', e.message); }
  }
}

// ⭐⭐ 2026-10-14 老板定（省数据库读量 / 压 QPS 尖峰）：**batch_members 改成「增量 + 定期全量对账」**。
//   原来：**每 5 分钟** `DELETE FROM batch_members` + 从第一页**全量重拉 5585 条** ——
//    一天 288 轮 → 累计约 160 万次数据库读写，是「数据库请求占调用量 80%」和「QPS 冲到 460（限额 500）」的主因。
//   现在：① 平时走 **_id 游标增量**（只拉新增，通常 0~几条，云端导出接口本来就支持 `after`，不用改云函数）；
//         ② **每 15 分钟做一次全量对账**（`DELETE` 全表 + 从头发）—— 因为**增量感知不到"删除"**，
//            删成员/删批次必须靠全量兜底，否则 PG 里会留幽灵、把"未分批数"算错（这是单边记账最容易踩的坑）。
//   ⚠️ 水位存在 PG 的 `sync_state` 表（name='batch_members'），与 `custSync` 同一套路。
//   ⚠️ 水位是**字符串**（集合 `_id`），不是时间戳 —— 所以单独用下面两个函数，别复用 customers 的 Number 版。
//   ⚠️ 顺带把每页 1000 降到 500、页间等 400ms → **把 QPS 尖峰压下来一半**（离 500 红线更远）。
const BM_PAGE = 500;
// ⭐⭐ 2026-10-14：**改成"信号驱动 + 兜底"**（老板定：有变动才全量，别定时全量）——
//   · 后台建/删批次、加/移成员时会写 `settings.batchDirtyAt`（云端 adminapi 的 touchBatchDirty）
//     → `pollDirty` 顺带带回来 → 同步器发现信号变了就**做一轮全量对账**（把"删掉的"清掉）
//   · 没变化 → **纯增量**（只拉新增，通常 0 条）
//   · 这个 `BM_FALLBACK_MIN` 只是**保险**：万一某处漏写信号，最迟 6 小时也会自己对一次账。
const BM_FALLBACK_MIN = Number(CFG.batchMemberFullSyncMinutes) || 360;
let _lastBmFullSync = 0;
let _bmDirtySeen = 0;          // 本轮 pollDirty 拿到的批次变动信号（由 syncPollDirty 赋值）
let _lastBmDirtyHandled = 0;   // 上次"因信号"做过全量的信号值（进程重启归 0 → 触发一次全量，安全）

// ⭐⭐ 2026-10-14 老板定（方案 D：**有变动才跑**）：round() 用它判断"这轮要不要跑全套"
//   `pollDirty` 一次调用带回云端全部变动时间戳（pollDirtyAt / custDirtyAt / batchDirtyAt）。
//   三个都没变 → 整轮只花这 1 次调用，跳过后面 6 个同步（原来**每轮无条件全跑**，约 7 次/轮 → 约 2100 次/天）。
let _pollSeen = 0;             // 本轮 pollDirtyAt（拜访/坐标报错/注册的变动戳）
let _custSeen = 0;             // 本轮 custDirtyAt（客户建档/更正/**删·恢复**的变动戳）
let _taskSeen = 0;             // 本轮 taskDirtyAt（建/改/删/派/撤任务的变动戳）
let _visitSeen = 0;            // ⭐ 2026-10-14：本轮 pollDirtyAt —— **拜访**提交/取消的信号（给 visits 增量用）
let _lastVisitDirtyHandled = 0; // 上次"因信号"对 visits 做过全量的信号值
const _deletedVisitSeen = new Set();  // ⭐ 2026-10-14：本进程已处理过的「拜访删除名单」id
//   —— 名单是"近 7 天"的、而处理它的那段在**每轮**都跑；不记一下就每 5 分钟重复删同一批（幂等无害但白做功 + 刷日志）。
let _lastVisitFullSync = 0;    // 上次"全量对账 visits"的时刻（0 = 还没跑过 → 首轮全量，安全）
let _lastCustAgg = 0;          // ⭐ 2026-10-15：上次"重算客户聚合 cust_agg"的时刻（10 分钟节流；0 = 还没跑过 → 首轮会算）
let _forceFull = false;        // ⭐ 2026-10-15：被 /syncNow 叫醒时置 true —— 这一轮**强制跑全套**（不看信号）
let _lastPollHandled = 0;      // 上次"跑过全套"时的 pollDirtyAt
let _lastCustHandled = 0;      // 上次"跑过全套"时的 custDirtyAt
let _lastTaskHandled = 0;      // 上次"跑过全套"时的 taskDirtyAt
let _lastBusyRun = 0;          // 上次真正跑全套的时刻（0 = 还没跑过 → 首轮必跑）
// ⚠️ 兜底：即使信号一直没变，也每 IDLE_FALLBACK_MIN 分钟无条件跑一轮 —— 防某处漏写信号造成"静默不更新"。
//   ⭐ 2026-10-14 原定 2 小时；**2026-10-15 收紧到 20 分钟** —— 因为客户同步已改成"每轮都跑"，
//      这道兜底现在只当"其余 6 项（批次成员/拜访/任务/商城…）漏写信号"的保险。
//      设长一点更省（有信号时本来就是即时跑），但要能兜住"漏信号"的意外，20 分钟比较稳妥。
const IDLE_FALLBACK_MIN = Number(CFG.idleFallbackMinutes) || 20;
// ⚠️⚠️ 2026-10-14 实测（部署前用探针脚本验过，拦下一次事故）：
//   `sync_state.watermark` 的列类型是 **bigint**（它一直是给时间戳用的），
//   **存不了字符串游标**（`batch_members._id` 是 CloudBase 生成的字符串）——
//   直接往里写会报 `invalid input syntax for type bigint`，那样**每轮写水位都失败**、
//   PG 里那张表再也不更新（表面上看还在跑，数据却不刷新 —— 最阴的那种事故）。
//   → 所以另立一张 `sync_cursor`（游标列用 **text**），与 sync_state **平行、互不干扰**。
let _bmCursorTableReady = false;
async function ensureCursorTable() {
  if (_bmCursorTableReady) return;
  await (await conn()).query('CREATE TABLE IF NOT EXISTS sync_cursor (name text PRIMARY KEY, cursor text, synced_at bigint)');
  _bmCursorTableReady = true;
}
async function bmWatermark() {
  try {
    await ensureCursorTable();
    const r = await (await conn()).query("SELECT cursor FROM sync_cursor WHERE name='batch_members'");
    return String((r.rows[0] && r.rows[0].cursor) || '');
  } catch (e) { return ''; }          // 读不到 → 当作首次（这轮走全量，安全）
}
async function setBmWatermark(w) {
  if (!w) return;                     // ⚠️ 空值不写 —— 否则会把水位抹掉，下轮退化成全量
  await ensureCursorTable();
  await (await conn()).query(
    "INSERT INTO sync_cursor (name,cursor,synced_at) VALUES ('batch_members',$1,$2) " +
    'ON CONFLICT (name) DO UPDATE SET cursor=$1, synced_at=$2', [String(w), Date.now()]);
}

// ⭐⭐ 2026-10-14 老板定：**拜访同步的水位 + 兜底**（照 batch_members 那套）
//   ⚠️ 必须用 `sync_cursor` 表（cursor 列是 text）—— `sync_state.watermark` 是 **bigint**，装不下 `_id` 这种字符串游标（踩过）。
const VISIT_FALLBACK_MIN = Number(CFG.visitFullSyncMinutes) || 60;   // 老板定：**1 小时**（原「每轮全量」）
async function visitWatermark() {
  try {
    await ensureCursorTable();
    const r = await (await conn()).query("SELECT cursor FROM sync_cursor WHERE name='visits'");
    return String((r.rows[0] && r.rows[0].cursor) || '');
  } catch (e) { return ''; }          // 读不到 → 当作首次（这轮走全量，安全）
}
async function setVisitWatermark(w) {
  if (!w) return;                     // ⚠️ 空值不写 —— 否则会把水位抹掉，下轮退化成全量
  await ensureCursorTable();
  await (await conn()).query(
    "INSERT INTO sync_cursor (name,cursor,synced_at) VALUES ('visits',$1,$2) " +
    'ON CONFLICT (name) DO UPDATE SET cursor=$1, synced_at=$2', [String(w), Date.now()]);
}

// ⭐⭐ 2026-10-10 老板定（批次「指针表」模式）第 2 步：**同步 batch_members 进 PG**。
//   云端 `batch_members` 是"谁被哪个批次选中"的**唯一真相**；同步过来后，后台的
//   「批内列表 / 未分批数 / 每批家数」全部改查 PG（一条 SQL 秒出、零成本），**不用再问云端**。
//   ⚠️ 用**游标**（`after` = 上一页最后一条 _id），**不用 skip** —— skip 在没索引时会越翻越慢（我踩过）。
async function syncBatchMembers() {
  // ⭐⭐ 2026-10-14：**改成信号驱动 + 兜底**（老板定：「不是只动变动的吗？」——对，现在就是）——
  //   · 后台有"批次变动"（建/删批次、加/移成员）→ `batchDirtyAt` 变了 → **这轮做全量对账**
  //     （删掉的成员只能靠全量清，增量扫不到"已消失的文档"）
  //   · 没有变动 → **纯增量**（只拉新增，通常 0 条 → 几乎零读写）
  //   · 兜底：距上次全量超过 `BM_FALLBACK_MIN`（默认 6 小时）也全量一次（防某处漏写信号）
  const dirtyChanged = !!_bmDirtySeen && _bmDirtySeen !== _lastBmDirtyHandled;
  const staleTooLong = !_lastBmFullSync || (Date.now() - _lastBmFullSync >= BM_FALLBACK_MIN * 60 * 1000);
  const full = dirtyChanged || staleTooLong;
  let after = '', lastSeen = '';
  // ⭐⭐ 2026-10-14 修（依《全项目审查》D03）：**不再「先清表再拉」** ——
  //   原来两处（`full` 分支与"水位认不出来"分支）都是先 `DELETE FROM batch_members` 再拉；
  //   一旦拉取失败/超时、或被云端当成"空页"，**表就已经空了**，而读 API 会把它当"最新完整数据"。
  //   现在：**先把全部数据拉进内存 → （全量时）确认非空 → 才清表 → 再一次性灌**。
  if (full) {
    after = '';                        // 全量：从头拉（清表挪到拉完之后）
  } else {
    // ── 增量：从上次位置接着拉（只拉新增）──
    after = await bmWatermark();
    if (!after) { full = true; after = ''; }   // 水位认不出来（首次 / 表被清过）→ 这轮当全量
  }
  const rows = [];
  for (let i = 0; i < 240; i++) {                      // 全量 5585 条按 500/页约 12 页；240 页兜底防跑飞
    const r = await callCloud('exportBatchMembers', { after, limit: BM_PAGE });
    if (!r || !r.ok) throw new Error('exportBatchMembers 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    // ⭐⭐ 2026-10-14：改用**批量 upsert**（每页 500 条 = 1 次写）——
    //   ⚠️ 原来是**逐条 INSERT**，一轮全量 5585 条 = 5585 次写请求（明明一次能写 500 条）；
    //      而 `upsert()` 这个批量函数项目里早就有（`syncVisits` / `syncCustomerBatches` 都在用），**只有它漏了**。
    //   ⚠️ `batch_members` 是**复合主键** `(batch_id, customer_id)` —— 所以给 `upsert()` 加了 `conflictOn`。
    for (const m of list) rows.push([String(m.b || ''), String(m.c || ''), Number(m.t) || 0, Date.now()]);
    lastSeen = r.last || after;                        // 游标：留着更新水位（空值不会覆盖旧水位）
    after = r.last || '';
    if (!r.hasMore) break;
    await sleep(400);                                  // ⭐ 1000→500 页 + 等 400ms：压低 QPS 尖峰
  }
  if (full) {
    // ⚠️ 全量却拉到 0 条 = 可疑（多半云端出问题被当成空页）→ **绝不清表**，下轮再试
    if (!rows.length) {
      console.warn('[sync] ⚠️ batch_members 全量拉回 0 条 → 本轮不清表（防把表清空），下轮再试');
      return;
    }
    const c0 = await conn();
    await c0.query('DELETE FROM batch_members');
  }
  await upsert('batch_members',
    ['batch_id', 'customer_id', 'created_at', 'updated_at'], rows, ['batch_id', 'customer_id']);
  const total = rows.length;
  if (full) {
    _lastBmFullSync = Date.now();
    if (dirtyChanged) _lastBmDirtyHandled = _bmDirtySeen;   // 记下已处理的信号
  }
  await setBmWatermark(lastSeen);                      // 记住水位（空值不会覆盖）
  console.log('[sync] batch_members ' + (full ? ('**全量对账**（' + (dirtyChanged ? '有批次变动' : '兜底到期') + '）') : '增量') +
    ' ' + total + ' 条');
}

// ⭐⭐ 2026-10-10 指针表模式第 5 步 · 三张新表的同步（云端导出接口在 adminapi 里）
//   ① customer_batches：批次卡，量极小 → 每轮 DELETE + 全量重拉
//   ② tasks：**只同步未结束的**（published / reviewing）—— "任务中"统计只认它们；
//        ✅ 顺带避开大数组：一个 9448 家的任务 customerIds ≈ 300KB，全量导出会撞返回体上限
//   ③ visited_customers：已拜访客户**聚合**（云端 group by customerId），每 visitSyncMinutes 分钟一次
//        —— 批次统计属"大批量数据"（老板定三层节奏第③层），15 分钟足够，省云开发读量
let _lastVisitSync = 0;

// 批量 UPSERT（多值 INSERT，每批 500 行）—— 逐条 INSERT 在几千条时会很慢
// ⭐ 2026-10-14：加第 4 个参数 `conflictOn`（冲突键，默认第一列）——
//   因为 `batch_members` 是**复合主键** `(batch_id, customer_id)`，只认第一列会插重（原写法干脆逐条插）。
async function upsert(table, cols, rows, conflictOn) {
  if (!rows || !rows.length) return 0;
  const c = await conn();
  const CH = 500;
  const keyCols = (Array.isArray(conflictOn) && conflictOn.length) ? conflictOn : [cols[0]];
  // ⭐⭐ 2026-10-22 修（老板实测「胡库复活 / 家数对不上」的**根因之一**）：
  //   Postgres 的 `INSERT ... ON CONFLICT (...) DO UPDATE` 在**同一条语句里出现重复冲突键**时会整条失败：
  //     `ON CONFLICT DO UPDATE command cannot affect row a second time`
  //   → `batch_members` 每轮都抛这个错（日志里刷了几百次），PG 的成员表**从来没更新过** →
  //     批次家数一直是旧值、合并/删除都反映不出来。
  //   这里按冲突键**先去重**（同一键后者覆盖前者），保证每批内键唯一。
  const keyIdx = keyCols.map(k => cols.indexOf(k));
  const seen = new Map();
  for (const r of rows) {
    const k = keyIdx.map(i => String(r[i])).join('\u0001');
    seen.set(k, r);
  }
  const uniq = Array.from(seen.values());
  if (uniq.length !== rows.length) {
    console.warn('[sync] ' + table + ' 本批有重复键 ' + (rows.length - uniq.length) + ' 条，已去重（原 ' + rows.length + ' → ' + uniq.length + '）');
  }
  const setCols = cols.filter(x => keyCols.indexOf(x) < 0);      // 冲突时更新「非主键列」
  for (let i = 0; i < uniq.length; i += CH) {
    const part = uniq.slice(i, i + CH);
    const ph = [], vals = [];
    part.forEach((r, ri) => {
      ph.push('(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')');
      vals.push.apply(vals, r);
    });
    await c.query('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES ' + ph.join(',') +
      ' ON CONFLICT (' + keyCols.join(',') + ') DO UPDATE SET ' +
      setCols.map(x => x + '=EXCLUDED.' + x).join(','), vals);
  }
  return uniq.length;
}

async function syncCustomerBatches() {
  const c0 = await conn();
  // ⭐⭐ 2026-10-14 修（依《全项目审查》D03）：**先拉完、确认非空，再清表** ——
  //   原来是"先 `DELETE` 再拉"，一旦拉取失败/超时（或被云端当成空页），**表就已经被清空了**，
  //   而读 API 看到的是"空表"，还很可能是"最新完整数据"。现在顺序反过来 + 空结果不清表。
  // ⭐⭐ 2026-10-22 修（老板实测「胡库商圈·第二批合并后又在列表里出现」）：
  //   `exportCustomerBatches` 导出的是**全部**批次文档（含已合并的 `mergedInto`），
  //   而这里全量重灌时没有剔除 → 已合并批次被"复活"进 PG；`pgapi` 又没有 merged_into 列、无从过滤。
  //   做法：先问云端要"当前有效批次"（`listCustomerBatches` 已过滤 mergedInto），只灌这些 id。
  let activeIds = null;
  try {
    const lb = await callCloud('listCustomerBatches', {});
    if (lb && lb.ok && Array.isArray(lb.batches)) {
      activeIds = new Set(lb.batches.map(b => String(b._id || '')));
      console.log('[sync] customer_batches 云端有效批次 ' + activeIds.size + ' 个');
    }
  } catch (e) {
    console.warn('[sync] 取有效批次清单失败（本轮照旧全量灌）: ' + e.message);
  }
  const rows = [];
  let after = '';
  for (let i = 0; i < 50; i++) {
    const r = await callCloud('exportCustomerBatches', { after, limit: 200 });
    if (!r || !r.ok) throw new Error('exportCustomerBatches 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    for (const b of list) {
      const bid = String(b.id || '');
      if (activeIds && !activeIds.has(bid)) continue;   // 已合并/已删 → 不进 PG（否则会被"复活"）
      rows.push([bid, String(b.name || ''), String(b.subtitle || ''),
        Number(b.createdAt) || 0, String(b.createdBy || ''), String(b.autoNamePrefix || ''), Date.now()]);
    }
    after = r.last || '';
    if (!r.hasMore) break;
    await sleep(150);
  }
  if (!rows.length) {   // ⚠️ 一条都没拉到 = 可疑（多半是云端出问题被当成空页）→ **绝不清表**
    console.warn('[sync] ⚠️ customer_batches 拉回 0 条 → 本轮不清表（防把表清空），下轮再试');
    return;
  }
  await c0.query('DELETE FROM customer_batches');
  await upsert('customer_batches', ['id', 'name', 'subtitle', 'created_at', 'created_by', 'auto_name_prefix', 'updated_at'], rows);
  console.log('[sync] customer_batches 同步 ' + rows.length + ' 个批次');
}

async function syncTasks() {
  const c0 = await conn();
  // ⭐⭐ 2026-10-14 修（依《全项目审查》D03）：同 `syncCustomerBatches` —— **先拉完再清表**、空结果不清表。
  const rows = [];
  let after = '';
  for (let i = 0; i < 200; i++) {           // 未结束任务通常几个~十几个；200 兜底
    const r = await callCloud('exportTasksForSync', { after, limit: 1 });   // 每次 1 个：customerIds 可能很大
    if (!r || !r.ok) throw new Error('exportTasksForSync 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    for (const t of list) {
      rows.push([String(t.id || ''), String(t.status || ''), String(t.deadline || ''),
        JSON.stringify(Array.isArray(t.customerIds) ? t.customerIds : []), Date.now()]);
    }
    after = r.last || '';
    if (!r.hasMore) break;
    await sleep(100);
  }
  // ⚠️ 这里**允许** 0 条：正常情况就可能是"当前没有任何未结束任务"（与客户/批次那种"必然非空"不同）。
  //    但仍然**先清后灌放在拉完之后**，且失败会 throw（不会走到这里）→ 不会出现"清了却没灌"。
  await c0.query('DELETE FROM tasks');
  await upsert('tasks', ['id', 'status', 'deadline', 'customer_ids', 'updated_at'], rows);
  console.log('[sync] tasks 同步 ' + rows.length + ' 个未结束任务');
}

// ⭐ 2026-10-11 老板定：「📝 拜访记录」两个页签改走轻量服务器（点「🔄 刷新」来这里拉，不花云开发的量）。
//   把**拜访明细**同步进 PG —— 数据来自 adminapi.exportVisitsForSync（按 _id 游标分页）。
//   ⚠️ **每轮先 DELETE 再全量拉**（和 batch_members 同一道理）：老板刚要求「能删拜访」，
//      而**增量同步感知不到删除**（删掉的那条会永远留在 PG 里当幽灵）→ 全量最稳。
//   ⚠️ 用游标（after = 上一页最后一条 id），**不用 skip**（没索引时越翻越慢，踩过）。
// ⭐⭐ 2026-10-14 老板定：**拜访同步改「信号驱动 + 增量 + 1 小时兜底」**（原来每轮 `DELETE` + 全量重拉）
//   老板原话：「拜访历史因为要删除，所以每次都全量拉取…为了检测拜访历史的删除，每次耗费这么多太不合算了。」
//   做法照 `syncBatchMembers` 那套（已验证）：
//     · 有拜访变动（`pollDirtyAt` 变了）或距上次全量超过 `VISIT_FALLBACK_MIN`（默认 60 分钟）→ **全量对账**（先清表再拉，兜住"删除"）
//     · 都没变 → **纯增量**（从水位接着拉，通常 0 条 → 几乎零读写）
//   ⚠️ 增量扫不到"已删的拜访"，所以**删除靠兜底全量**（最多滞后 VISIT_FALLBACK_MIN）。
//      下一步会加「删除名单」（云端 pollDirty 顺带带回、零额外调用）把删除的滞后降到"下一轮"。
async function syncVisits() {
  const dirtyChanged = !!_visitSeen && _visitSeen !== _lastVisitDirtyHandled;
  const staleTooLong = !_lastVisitFullSync || (Date.now() - _lastVisitFullSync >= VISIT_FALLBACK_MIN * 60000);
  let full = dirtyChanged || staleTooLong;

  const c = await conn();
  let after = '', lastSeen = '';
  // ⭐⭐ 2026-10-14 修（依《全项目审查》D03）：同 `syncBatchMembers` —— **不再「先清表再拉」**，
  //   改成"先全拉进内存 → 全量时确认非空 → 才清表 → 再灌"（拉失败/被当空页时表不会被清空）。
  if (full) {
    after = '';
  } else {
    // ── 增量：从上次位置接着拉 ──
    after = await visitWatermark();
    if (!after) {                       // 水位认不出来（首次 / 表被清过）→ 这轮当全量
      full = true;
      after = '';
    }
  }

  const rows = [];
  for (let i = 0; i < 60; i++) {                     // 一次最多 6 万条，防跑太久
    const r = await callCloud('exportVisitsForSync', { after, limit: 1000 });
    if (!r || !r.ok) throw new Error('exportVisitsForSync 返回异常: ' + JSON.stringify(r).slice(0, 160));
    const list = r.rows || [];
    if (list.length) {
      for (const x of list) {
        rows.push([x.id, x.customerId, x.salesmanId, x.salesmanName, x.visitedAt, x.taskId, x.freeTripId,
          x.result, x.status, x.duration, x.remark, x.samples,
          JSON.stringify(x.audios || []), JSON.stringify(x.photos || []), x.createdAt, x.updatedAt]);
      }
      lastSeen = r.last || after;                      // 游标：留着更新水位（空值不会覆盖旧水位）
      after = r.last || '';
    }
    if (!r.hasMore || !list.length) break;
    await sleep(200);
  }
  if (full) {
    // ⚠️ 全量却 0 条：正常也可能（真的一条拜访都没有）—— 但**先清再灌**更危险（清了就真没了），
    //    所以这里**照旧清**（0 条=确实是空，清成空也是对的），关键收益是"拉取失败时不会先把表清空"。
    await c.query('DELETE FROM visits');
  }
  await upsert('visits',
    ['id', 'customer_id', 'salesman_id', 'salesman_name', 'visited_at', 'task_id', 'free_trip_id',
      'result', 'status', 'duration', 'remark', 'samples', 'audios', 'photos', 'created_at', 'updated_at'], rows);
  const total = rows.length;
  if (full) {
    _lastVisitFullSync = Date.now();
    if (dirtyChanged) _lastVisitDirtyHandled = _visitSeen;   // 记下已处理的信号
  }
  await setVisitWatermark(lastSeen);                  // 记住水位（空值不会覆盖）
  console.log(`[sync] visits 同步 ${total} 条（${full ? '全量对账' : '增量'}）`);
}

// ⭐⭐ 2026-10-15 老板定（《订单本地方案》第 3 块）：**订单 / 订单明细 同步到 PG**
//   目的：后台那 6 列改从【自己的服务器】算（不再每翻页问云端）。
//   ⚠️ 水位用 **`updatedAt`**（不是 `_id` 游标）—— 因为订单 **`_id` 是随机串**，
//      新导入的订单可能"排在任何旧 _id 之前"，用 `_id` 游标会**永久漏掉**它们（与 D01 同类错位）。
//      → `since` 整轮不动、只推进 `cursor`（cursor 只用于同一轮内翻页）。
//   ⚠️ 水位存 `sync_state`（name='orders' / 'order_items'）—— 那列的 `watermark` 是 bigint，`updatedAt` 正好是数字。
//   ⚠️ 与其它同步一样：**只 upsert，不清表**（订单是老单不变、新单追加，没有"删除"要检测）。
async function orderWatermark(name) {
  try { const r = await (await conn()).query('SELECT watermark FROM sync_state WHERE name=$1', [name]); return Number(r.rows[0] && r.rows[0].watermark) || 0; }
  catch (e) { return 0; }
}
async function setOrderWatermark(name, w) {
  if (!w) return;
  await (await conn()).query('INSERT INTO sync_state (name,watermark,synced_at) VALUES ($3,$1,$2) ' +
    'ON CONFLICT (name) DO UPDATE SET watermark=$1, synced_at=$2', [w, Date.now(), name]);
}

async function syncOrders() {
  try {
    const coll = 'orders';
    const since = await orderWatermark(coll);
    const cols = ['id', 'code', 'order_no', 'amount', 'status', 'ordered_at', 'pay_method', 'salesman', 'created_at', 'updated_at'];
    const rows = [];
    let cursor = '', maxU = since, got = 0;
    for (let i = 0; i < 60; i++) {                       // 上限 6 万条（实际 1 万出头）
      const r = await callCloud('exportOrdersForSync', { since, cursor, limit: 1000 });
      if (!r || !r.ok) throw new Error('exportOrdersForSync 返回异常: ' + JSON.stringify(r).slice(0, 160));
      const list = r.rows || [];
      if (!list.length) break;
      for (const x of list) {
        rows.push([x.id, x.code, x.orderNo, x.amount, x.status, x.orderedAt, x.payMethod, x.salesman, x.createdAt, x.updatedAt]);
        if (Number(x.updatedAt) > maxU) maxU = Number(x.updatedAt);
        got++;
      }
      cursor = r.last || '';
      if (!r.hasMore || !cursor) break;
      await sleep(150);
    }
    await upsert('orders', cols, rows, ['id']);
    await setOrderWatermark(coll, maxU);                 // 全部成功后才推进水位
    if (got) console.log('[sync] orders 同步 ' + got + ' 条（' + (since ? '增量' : '首次全量') + '）');
  } catch (e) { console.error('[sync] orders 同步失败（下轮再试）:', e.message); }
}

async function syncOrderItems() {
  try {
    const coll = 'order_items';
    const since = await orderWatermark(coll);
    const cols = ['id', 'order_no', 'goods_code', 'goods_name', 'barcode', 'brand', 'category', 'spec', 'unit', 'supplier',
      'self_code', 'line_no', 'order_qty', 'amount', 'actual_price', 'retail_price', 'sale_price', 'wholesale_price',
      'other_share', 'out_qty', 'feature', 'remark', 'created_at', 'updated_at'];
    const rows = [];
    let cursor = '', maxU = since, got = 0;
    for (let i = 0; i < 80; i++) {                       // 上限 8 万条（实际 2.1 万）
      const r = await callCloud('exportOrderItemsForSync', { since, cursor, limit: 1000 });
      if (!r || !r.ok) throw new Error('exportOrderItemsForSync 返回异常: ' + JSON.stringify(r).slice(0, 160));
      const list = r.rows || [];
      if (!list.length) break;
      for (const x of list) {
        rows.push([x.id, x.orderNo, x.goodsCode, x.goodsName, x.barcode, x.brand, x.category, x.spec, x.unit, x.supplier,
          x.selfCode, x.lineNo, x.orderQty, x.amount, x.actualPrice, x.retailPrice, x.salePrice, x.wholesalePrice,
          x.otherShare, x.outQty, x.feature, x.remark, x.createdAt, x.updatedAt]);
        if (Number(x.updatedAt) > maxU) maxU = Number(x.updatedAt);
        got++;
      }
      cursor = r.last || '';
      if (!r.hasMore || !cursor) break;
      await sleep(150);
    }
    await upsert('order_items', cols, rows, ['id']);
    await setOrderWatermark(coll, maxU);
    if (got) console.log('[sync] order_items 同步 ' + got + ' 条（' + (since ? '增量' : '首次全量') + '）');
  } catch (e) { console.error('[sync] order_items 同步失败（下轮再试）:', e.message); }
}

// ⭐⭐ 2026-10-15：《订单本地方案》第 3 块的核心 —— **把这 6 个统计算好写进 `cust_agg`**
//   ① 订单总数 / ② 订单总额 / ③ 最近下单 —— 按 `customers.code` ↔ `orders.code` 关联
//   ④ 拜访次数 / ⑤ 最近拜访 —— 按 `customer_id` 关联 `visits`（只算已提交：normal / pending_review）
//   ⑥ 全局态（visit_state）—— 这家在不在"进行中任务"里（published / reviewing 且未过期）
//   ⚠️ **全量重算**（17.8 万家一条 INSERT ... SELECT，实测几秒）—— 比"增量维护"简单可靠得多。
//   ⚠️ 幂等：`ON CONFLICT (id) DO UPDATE`，重复跑结果一样。
//   ⚠️ 失败只 log（下轮再试）—— 绝不影响别的同步。
async function recalcCustAgg() {
  try {
    const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 与云端 todayStr() 同口径（东八区）
    const sql = `
      INSERT INTO cust_agg (id, order_count, order_amount_sum, last_order_at, visit_count, last_visit_at, visit_state, visit_status, updated_at)
      SELECT c.id,
             COALESCE(o.n, 0),
             COALESCE(o.amt, 0),
             COALESCE(NULLIF(o.last_at, ''), ''),
             COALESCE(v.n, 0),
             COALESCE(NULLIF(v.last_at, ''), ''),
             CASE WHEN t.cid IS NOT NULL THEN 'in_task' ELSE 'free' END,
             CASE WHEN t.cid IS NULL THEN ''
                  WHEN COALESCE(vt.visited, false) THEN 'visited'
                  WHEN COALESCE(vt.ongoing, false) THEN 'ongoing'
                  ELSE 'pending' END,
             $1
      FROM customers c
      LEFT JOIN (SELECT code, count(*) AS n, sum(amount) AS amt, max(ordered_at) AS last_at
                   FROM orders WHERE coalesce(code,'') <> '' GROUP BY code) o ON o.code = c.code
      LEFT JOIN (SELECT customer_id, count(*) AS n, max(visited_at) AS last_at
                   FROM visits WHERE status IN ('normal','pending_review') GROUP BY customer_id) v ON v.customer_id = c.id
      LEFT JOIN (SELECT customer_id,
                        bool_or(status = 'normal' AND coalesce(task_id,'') <> '') AS visited,
                        bool_or(status = 'ongoing' AND visited_at = $2) AS ongoing
                   FROM visits GROUP BY customer_id) vt ON vt.customer_id = c.id
      LEFT JOIN (SELECT DISTINCT jsonb_array_elements_text(customer_ids) AS cid
                   FROM tasks
                  WHERE status IN ('published','reviewing')
                    AND (deadline IS NULL OR deadline = '' OR deadline > $2)) t ON t.cid = c.id
      ON CONFLICT (id) DO UPDATE SET
        order_count = EXCLUDED.order_count, order_amount_sum = EXCLUDED.order_amount_sum,
        last_order_at = EXCLUDED.last_order_at, visit_count = EXCLUDED.visit_count,
        last_visit_at = EXCLUDED.last_visit_at, visit_state = EXCLUDED.visit_state,
        visit_status = EXCLUDED.visit_status, updated_at = EXCLUDED.updated_at`;
    const c = await conn();
    const t0 = Date.now();
    await c.query(sql, [Date.now(), today]);
    const n = await c.query('SELECT count(*)::int AS n, sum(order_count)::int AS oc, sum(visit_count)::int AS vc FROM cust_agg');
    const s = n.rows[0] || {};
    console.log('[sync] 聚合重算完成：' + s.n + ' 家 · 订单合计 ' + (s.oc || 0) + ' 单 · 拜访合计 ' + (s.vc || 0) + ' 次（' + (Date.now() - t0) + 'ms）');
  } catch (e) { console.error('[sync] 聚合重算失败（下轮再试）:', e.message); }
}

async function syncVisitedCustomers() {
  const MIN = Number(CFG.visitSyncMinutes) || 15;
  if (_lastVisitSync && Date.now() - _lastVisitSync < MIN * 60 * 1000) return;   // 没到点，跳过（失败时不更新时间戳 → 下轮重试）
  const c0 = await conn();
  // ⭐⭐ 2026-10-14 修（依《全项目审查》D03）：**先拉完再清表**、空结果不清表（原来先 DELETE 再拉）。
  const rows = [];
  let skip = 0;
  for (let i = 0; i < 100; i++) {           // 最多 10 万客户，防跑飞
    const r = await callCloud('exportVisitedCustomers', { skip, limit: 1000 });
    if (!r || !r.ok) throw new Error('exportVisitedCustomers 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    for (const v of list) rows.push([String(v.c || ''), Number(v.n) || 0, Date.now()]);
    skip += list.length;
    if (!r.hasMore) break;
    await sleep(150);
  }
  if (!rows.length) {   // ⚠️ 正常情况"已拜访客户"不该为空（任务一直在跑）→ 空了就当异常，**不清表**
    console.warn('[sync] ⚠️ visited_customers 拉回 0 条 → 本轮不清表（防把表清空），下轮再试');
    return;
  }
  await c0.query('DELETE FROM visited_customers');
  await upsert('visited_customers', ['customer_id', 'n', 'updated_at'], rows);
  _lastVisitSync = Date.now();
  console.log('[sync] visited_customers 同步 ' + rows.length + ' 个客户（下次 ' + MIN + ' 分钟后）');
}

// ⭐⭐ 2026-10-15（《订单本地方案》第 4 块）：**等待可被「立刻同步」打断**
//   后台导入订单后调 pgapi 的 `/syncNow` → 它在磁盘上放一个标记文件 → 这里每秒瞄一眼，
//   有标记就立刻跑一轮（并删掉标记），**不用干等那一分钟**。
//   ⚠️ 用文件而不是数据库：`pgapi` 连的是只读账号，写不了库；而两者在同一台机器上，文件最省事。
const FORCE_FLAG = path.join(__dirname, 'sync-now.flag');
async function waitOrForce(ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (fs.existsSync(FORCE_FLAG)) {
        fs.unlinkSync(FORCE_FLAG);
        console.log('[sync] 收到「立刻同步」请求 → 不等了，马上跑一轮（强制跑全套）');
        _forceFull = true;   // ⭐ 关键：不只是"不等待"，而是"这一轮**强制跑全套**" ——
                             //   因为订单/客户导入**不写变动信号**（走的是 importdata，不经过 adminapi 的信号写口），
                             //   只看信号的话这一轮会被"无变动"跳过 → 导入的订单永远拉不进来。
        return true;
      }
    } catch (e) { /* 读/删失败就当没有，继续等 */ }
    await sleep(1000);
  }
  return false;
}

(async () => {
  console.log('[sync] 启动，每 ' + MIN + ' 分钟同步一次（支持 /syncNow 立刻同步）');
  for (;;) {
    try { await round(); } catch (e) { console.error('[sync] 这轮失败（下轮再试）:', e.message); db = null; }
    await waitOrForce(MIN * 60 * 1000);
  }
})();
