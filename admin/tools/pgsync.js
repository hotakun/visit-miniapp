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
  COLS.filter(c => c !== 'id').map(c => c + '=EXCLUDED.' + c).join(',');

let db = null;
const cfgPath = path.join(__dirname, 'config.json');   // 微信凭据（appid/appsecret/envId）——与脚本同级
let tk = null, tkAt = 0;

async function token() {
  if (tk && Date.now() - tkAt < 90 * 60 * 1000) return tk;   // 微信 token 有效期 2 小时，留余量
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  // ⚠️⚠️ 2026-10-10 修复（pgsync 曾因此持续停摆）：**必须用 stable_token 接口**。
  //   老接口 /cgi-bin/token 与 stable_token 拿的是同一套凭证、**会互相踢**：
  //   开发机后台（server.js）一直用 stable_token，而这里曾用老接口 → 每次刷新都把对方的 token 作废，
  //   实测现象 = pgsync 日志刷 "access_token is invalid or not latest"（微信报错原文也点名让改 stable_token），
  //   同步完全停摆。改成同一套接口后两边互不影响。
  const r = await (await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credential', appid: c.appid, secret: c.appsecret, force_refresh: false })
  })).json();
  if (!r.access_token) throw new Error('取 token 失败: ' + (r.errmsg || r.errcode));
  tk = r.access_token; tkAt = Date.now();
  return tk;
}
async function callCloud(action, extra) {                     // 调云函数（与 run_adminapi.js 同一套）
  const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const t = await token();
  const body = Object.assign({ action, username: CFG.apiUser || 'qingyan', password: CFG.apiPassword || '123456' }, extra || {});
  const r = await (await fetch('https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=' + t +
    '&env=' + c.envId + '&name=adminapi', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) })).json();
  if (r.errcode) {
    // ⚠️ 2026-10-10：token 被别处刷新顶掉（40001 / invalid credential）→ 清缓存让下轮重取，自愈
    const em = String(r.errmsg || '');
    if (r.errcode === 40001 || em.indexOf('invalid credential') >= 0) { tk = null; tkAt = 0; }
    throw new Error('调用云函数失败: ' + (r.errmsg || r.errcode));
  }
  let out = r.resp_data;
  try { out = JSON.parse(out); } catch (e) { /* 原样 */ }
  return out;
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
    await put('pollDirtyAt', Number(r.pollDirtyAt) || 0);
    await put('custDirtyAt', Number(r.custDirtyAt) || 0);
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

async function round() {
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
  // ⭐ 2026-10-12 省调用量 ③：先把云端「变化时间戳」同步进 PG（后台据此决定"要不要叫云端"，0 成本）
  try { await syncPollDirty(); } catch (e) { console.error('[sync] pollDirty 失败（下轮再试）:', e.message); }
  try { await syncBatchMembers(); } catch (e) { console.error('[sync] batch_members 同步失败（下轮再试）:', e.message); }
  // ⭐⭐ 2026-10-10 指针表模式第 5 步：批次卡 / 任务 / 已拜访客户也进 PG ——
  //    后台「📦 批次管理」从此**彻底不再问云开发**（批次页每个数字 = 一条 SQL）。
  //    ⚠️ 三者相互独立，各自 try/catch：云端还没重传新导出接口时只是这几行报错，主同步照常。
  try { await syncCustomerBatches(); } catch (e) { console.error('[sync] customer_batches 同步失败（下轮再试）:', e.message); }
  try { await syncTasks(); } catch (e) { console.error('[sync] tasks 同步失败（下轮再试）:', e.message); }
  try { await syncVisitedCustomers(); } catch (e) { console.error('[sync] visited_customers 同步失败（下轮再试）:', e.message); }
  // ⭐ 2026-10-11 老板定：「📝 拜访记录」两页改走轻量服务器 → 拜访**明细**也进 PG
  try { await syncVisits(); } catch (e) { console.error('[sync] visits 同步失败（下轮再试）:', e.message); }
}

// ⭐⭐ 2026-10-10 老板定（批次「指针表」模式）第 2 步：**同步 batch_members 进 PG**。
//   云端 `batch_members` 是"谁被哪个批次选中"的**唯一真相**；同步过来后，后台的
//   「批内列表 / 未分批数 / 每批家数」全部改查 PG（一条 SQL 秒出、零成本），**不用再问云端**。
//   ⚠️ **每轮先 `DELETE` 再全量拉** —— 否则"删掉的批次成员"会一直留在 PG 里，
//      「未分批数」会把那些客户**错误地算成"已入批"**（这是单边记账后最容易踩的坑）。
//   ⚠️ 用**游标**（`after` = 上一页最后一条 _id），**不用 skip** —— skip 在没索引时会越翻越慢（我踩过）。
async function syncBatchMembers() {
  const c0 = await conn();
  await c0.query('DELETE FROM batch_members');
  let after = '', total = 0;
  for (let i = 0; i < 60; i++) {                       // 最多 6 万条，防跑飞
    const r = await callCloud('exportBatchMembers', { after, limit: 1000 });
    if (!r || !r.ok) throw new Error('exportBatchMembers 返回异常: ' + JSON.stringify(r).slice(0, 200));
    const list = r.list || [];
    if (!list.length) break;
    const c = await conn();
    for (const m of list) {
      await c.query(
        'INSERT INTO batch_members (batch_id,customer_id,created_at,updated_at) VALUES ($1,$2,$3,$4) ' +
        'ON CONFLICT (batch_id,customer_id) DO UPDATE SET updated_at=EXCLUDED.updated_at',
        [String(m.b || ''), String(m.c || ''), Number(m.t) || 0, Date.now()]
      );
      total++;
    }
    after = r.last || '';
    if (!r.hasMore) break;
    await sleep(200);
  }
  console.log('[sync] batch_members 同步 ' + total + ' 条');
}

// ⭐⭐ 2026-10-10 指针表模式第 5 步 · 三张新表的同步（云端导出接口在 adminapi 里）
//   ① customer_batches：批次卡，量极小 → 每轮 DELETE + 全量重拉
//   ② tasks：**只同步未结束的**（published / reviewing）—— "任务中"统计只认它们；
//        ✅ 顺带避开大数组：一个 9448 家的任务 customerIds ≈ 300KB，全量导出会撞返回体上限
//   ③ visited_customers：已拜访客户**聚合**（云端 group by customerId），每 visitSyncMinutes 分钟一次
//        —— 批次统计属"大批量数据"（老板定三层节奏第③层），15 分钟足够，省云开发读量
let _lastVisitSync = 0;

// 批量 UPSERT（多值 INSERT，每批 500 行）—— 逐条 INSERT 在几千条时会很慢
async function upsert(table, cols, rows) {
  if (!rows || !rows.length) return 0;
  const c = await conn();
  const CH = 500;
  for (let i = 0; i < rows.length; i += CH) {
    const part = rows.slice(i, i + CH);
    const ph = [], vals = [];
    part.forEach((r, ri) => {
      ph.push('(' + cols.map((_, ci) => '$' + (ri * cols.length + ci + 1)).join(',') + ')');
      vals.push.apply(vals, r);
    });
    await c.query('INSERT INTO ' + table + ' (' + cols.join(',') + ') VALUES ' + ph.join(',') +
      ' ON CONFLICT (' + cols[0] + ') DO UPDATE SET ' +
      cols.slice(1).map(x => x + '=EXCLUDED.' + x).join(','), vals);
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
