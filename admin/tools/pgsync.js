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
  ['created_at','ca'],['updated_at','u']];
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
      await d.query(
        'INSERT INTO mall_pending (mall_key,name,phone,address,region,mall_code,added_at,imported_at) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (mall_key) DO UPDATE SET ' +
        'name=EXCLUDED.name, phone=EXCLUDED.phone, address=EXCLUDED.address, region=EXCLUDED.region, ' +
        'mall_code=EXCLUDED.mall_code, added_at=EXCLUDED.added_at',
        [String(x.k || ''), String(x.n || ''), String(x.p || ''), String(x.a || ''),
         String(x.r || ''), String(x.c || ''), String(x.t || ''), Date.now()]);
    }
    if (all.length) console.log('[sync] mall_pending 灌/更新', all.length, '家（这批共', total, '家）');
  } catch (e) { console.error('[sync] mall_pending 同步失败（下轮再试）:', e.message); }
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
  if (!_changed && !_idleTooLong) {
    const _left = Math.max(0, Math.round((IDLE_FALLBACK_MIN * 60000 - (Date.now() - _lastBusyRun)) / 60000));
    console.log('[sync] 无变动 → 只查了信号（省调用；约 ' + _left + ' 分钟后兜底跑一轮）');
    return;
  }
  _lastBusyRun = Date.now();
  _lastPollHandled = _pollSeen;
  _lastCustHandled = _custSeen;

  let since = await watermark(), got = 0, maxU = since;
  for (let i = 0; i < 40; i++) {                               // 一次最多 4 万条，防跑太久
    const r = await callCloud('custSync', { since, limit: 1000 });
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
    since = maxU;
    if (list.length < 1000) break;
    await sleep(200);
  }
  if (got) { await setWatermark(maxU); console.log(`[sync] 补了 ${got} 条，水位 → ${new Date(maxU).toLocaleString()}`); }
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
let _lastPollHandled = 0;      // 上次"跑过全套"时的 pollDirtyAt
let _lastCustHandled = 0;      // 上次"跑过全套"时的 custDirtyAt
let _lastTaskHandled = 0;      // 上次"跑过全套"时的 taskDirtyAt
let _lastBusyRun = 0;          // 上次真正跑全套的时刻（0 = 还没跑过 → 首轮必跑）
// ⚠️ 兜底：即使信号一直没变，也每 IDLE_FALLBACK_MIN 分钟无条件跑一轮 —— 防某处漏写信号造成"静默不更新"。
//   ⭐ 定 2 小时（老板 2026-10-14 定）：**计时只在"真正跑全套"时才重置**，所以只要有人在用
//      （一直有变动信号 → 一直跑全套 → 一直重置），兜底**根本轮不到**；只有真的没人用时才触发。
//      → 有信号写点覆盖的动作**都是即时反映**，兜底只当"漏信号的保险"，设长一点更省。
const IDLE_FALLBACK_MIN = Number(CFG.idleFallbackMinutes) || 120;
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
  let after = '', total = 0, lastSeen = '';
  if (full) {
    // ── 全量对账：先清空 PG 再从头拉（与旧行为一致，兜住"删除"）──
    const c0 = await conn();
    await c0.query('DELETE FROM batch_members');
    after = '';
  } else {
    // ── 增量：从上次位置接着拉（只拉新增）──
    after = await bmWatermark();
    if (!after) {                      // 水位认不出来（首次 / 表被清过）→ 这轮当全量
      const c0 = await conn();
      await c0.query('DELETE FROM batch_members');
    }
  }
  for (let i = 0; i < 240; i++) {                      // 全量 5585 条按 500/页约 12 页；240 页兜底防跑飞
    const r = await callCloud('exportBatchMembers', { after, limit: BM_PAGE });
    if (!r || !r.ok) throw new Error('exportBatchMembers 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    // ⭐⭐ 2026-10-14：改用**批量 upsert**（每页 500 条 = 1 次写）。
    //   ⚠️ 原来是**逐条 INSERT** —— 一轮全量 5585 条 = **5585 次写请求**（明明一次能写 500 条）。
    //      而 `upsert()` 这个批量函数项目里早就有（`syncVisits` / `syncCustomerBatches` 都在用），
    //      **只有这个函数漏了**。改完：**5585 次写 → 12 次写**（省 99%）。
    //   ⚠️ `batch_members` 是**复合主键** `(batch_id, customer_id)` —— 所以上面给 `upsert()` 加了 `conflictOn`。
    await upsert('batch_members',
      ['batch_id', 'customer_id', 'created_at', 'updated_at'],
      list.map(m => [String(m.b || ''), String(m.c || ''), Number(m.t) || 0, Date.now()]),
      ['batch_id', 'customer_id']);
    total += list.length;
    lastSeen = r.last || after;                        // 游标：留着更新水位（空值不会覆盖旧水位）
    after = r.last || '';
    if (!r.hasMore) break;
    await sleep(400);                                  // ⭐ 1000→500 页 + 等 400ms：压低 QPS 尖峰
  }
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
  const setCols = cols.filter(x => keyCols.indexOf(x) < 0);      // 冲突时更新「非主键列」
  for (let i = 0; i < rows.length; i += CH) {
    const part = rows.slice(i, i + CH);
    const ph = [], vals = [];
    part.forEach((r, ri) => {
      ph.push('(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')');
      vals.push.apply(vals, r);
    });
    await c.query('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES ' + ph.join(',') +
      ' ON CONFLICT (' + keyCols.join(',') + ') DO UPDATE SET ' +
      setCols.map(x => x + '=EXCLUDED.' + x).join(','), vals);
  }
  return rows.length;
}

async function syncCustomerBatches() {
  const c0 = await conn();
  await c0.query('DELETE FROM customer_batches');
  const rows = [];
  let after = '';
  for (let i = 0; i < 50; i++) {
    const r = await callCloud('exportCustomerBatches', { after, limit: 200 });
    if (!r || !r.ok) throw new Error('exportCustomerBatches 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    for (const b of list) {
      rows.push([String(b.id || ''), String(b.name || ''), String(b.subtitle || ''),
        Number(b.createdAt) || 0, String(b.createdBy || ''), String(b.autoNamePrefix || ''), Date.now()]);
    }
    after = r.last || '';
    if (!r.hasMore) break;
    await sleep(150);
  }
  await upsert('customer_batches', ['id', 'name', 'subtitle', 'created_at', 'created_by', 'auto_name_prefix', 'updated_at'], rows);
  console.log('[sync] customer_batches 同步 ' + rows.length + ' 个批次');
}

async function syncTasks() {
  const c0 = await conn();
  await c0.query('DELETE FROM tasks');
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
  await upsert('tasks', ['id', 'status', 'deadline', 'customer_ids', 'updated_at'], rows);
  console.log('[sync] tasks 同步 ' + rows.length + ' 个未结束任务');
}

// ⭐ 2026-10-11 老板定：「📝 拜访记录」两个页签改走轻量服务器（点「🔄 刷新」来这里拉，不花云开发的量）。
//   把**拜访明细**同步进 PG —— 数据来自 adminapi.exportVisitsForSync（按 _id 游标分页）。
//   ⚠️ **每轮先 DELETE 再全量拉**（和 batch_members 同一道理）：老板刚要求「能删拜访」，
//      而**增量同步感知不到删除**（删掉的那条会永远留在 PG 里当幽灵）→ 全量最稳。
//   ⚠️ 用游标（after = 上一页最后一条 id），**不用 skip**（没索引时越翻越慢，踩过）。
async function syncVisits() {
  const c = await conn();
  await c.query('DELETE FROM visits');
  let after = '', total = 0;
  for (let i = 0; i < 60; i++) {                     // 一次最多 6 万条，防跑太久
    const r = await callCloud('exportVisitsForSync', { after, limit: 1000 });
    if (!r || !r.ok) throw new Error('exportVisitsForSync 返回异常: ' + JSON.stringify(r).slice(0, 160));
    const list = r.rows || [];
    if (list.length) {
      await upsert('visits',
        ['id', 'customer_id', 'salesman_id', 'salesman_name', 'visited_at', 'task_id', 'free_trip_id',
          'result', 'status', 'duration', 'remark', 'samples', 'audios', 'photos', 'created_at', 'updated_at'],
        list.map(x => [x.id, x.customerId, x.salesmanId, x.salesmanName, x.visitedAt, x.taskId, x.freeTripId,
        x.result, x.status, x.duration, x.remark, x.samples,
        JSON.stringify(x.audios || []), JSON.stringify(x.photos || []), x.createdAt, x.updatedAt]));
      total += list.length;
      after = r.last || ((list[list.length - 1] || {}).id || '');
    }
    if (!r.hasMore || !list.length) break;
    await sleep(200);
  }
  console.log(`[sync] visits 同步 ${total} 条（全量重拉）`);
}

async function syncVisitedCustomers() {
  const MIN = Number(CFG.visitSyncMinutes) || 15;
  if (_lastVisitSync && Date.now() - _lastVisitSync < MIN * 60 * 1000) return;   // 没到点，跳过（失败时不更新时间戳 → 下轮重试）
  const c0 = await conn();
  await c0.query('DELETE FROM visited_customers');
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
  await upsert('visited_customers', ['customer_id', 'n', 'updated_at'], rows);
  _lastVisitSync = Date.now();
  console.log('[sync] visited_customers 同步 ' + rows.length + ' 个客户（下次 ' + MIN + ' 分钟后）');
}

(async () => {
  console.log('[sync] 启动，每 ' + MIN + ' 分钟同步一次');
  for (;;) {
    try { await round(); } catch (e) { console.error('[sync] 这轮失败（下轮再试）:', e.message); db = null; }
    await sleep(MIN * 60 * 1000);
  }
})();
