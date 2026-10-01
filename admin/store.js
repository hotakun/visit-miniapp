// admin/store.js —— 本地缓存层（2026-09-27 新增）
//
// 依据：`_scratch/架构-本地缓存与同步方案.md`（§一 五条铁律 / §十 M1 详细设计）
//
// 用途：把云端「客户列表层」数据拉到**本地文件**，后台页面秒读；
//       地图拖动/缩放不再请求云端（这是"丝滑"的关键）。
//
// 铁律（架构文档 §一）：
//   ① 云端是唯一真相源，本地只是快照 —— 删了能重建，不影响正确性
//   ② 热数据（业务员实时位置）**不缓存**
//   ③ 缓存必须在界面显示 syncedAt，让人知道数据新旧
//
// ⚠️ 云函数调用由 server.js 通过 callApi 注入（token 在那边），本文件**不碰凭据**。

const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, 'cache');
const FILE = path.join(CACHE_DIR, 'map-points.json');
const VERSION = 5;              // ⭐ 2026-09-27 M2b：字段 12 → 18 项（店名原值/建档时间/客户类型/电话/备注/批次归属）→ 升版本，旧缓存自动作废重拉
const PAGE_LIMIT = 1000;        // 每片 1000 条（云函数单次返回上限 100KB，1000 条约 100KB 内）
const MAX_PAGES = 1000;         // 硬上限（100 万条），防死循环

let syncing = false;            // 是否正在拉取（前端显示进度用）
// ⭐ 2026-09-27 老板定：预热时前端要能看到「已准备 3.8万/6万」→ progress 里带上 total。
//   total 取「上一次缓存的条数」作参考（首次无缓存时为 0，前端就只显示已拉多少）。
let progress = { done: 0, total: 0, phase: '' };

function ensureDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* 已存在 */ }
}

// 读缓存；格式不对/不存在 → null（调用方自己决定是否重拉）
function read() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const j = JSON.parse(raw);
    if (!j || j.v !== VERSION || !Array.isArray(j.points)) return null;
    return j;
  } catch (e) { return null; }
}

// 原子写：先写 .tmp 再改名 —— 避免"写到一半进程被杀"留下半个坏文件
function write(obj) {
  ensureDir();
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, FILE);
}

// 是否"今天拉的"（按自然日 —— 老板口径："当天第一次进系统就初始化，今天之内就用缓存"）
function isFreshToday(c) {
  if (!c || !c.syncedAt) return false;
  const a = new Date(c.syncedAt), b = new Date();
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function status() {
  const c = read();
  return {
    ok: true,
    exists: !!c,
    syncing: syncing,
    progress: progress,
    syncedAt: c ? c.syncedAt : 0,
    count: c ? c.points.length : 0,
    fresh: isFreshToday(c),
    version: VERSION
  };
}

// 分片循环拉全量 → 写文件。callApi 由 server.js 注入（带 token）
// ⚠️ **cred 必须带**（username/password）—— adminapi 需要认证，不带会返回“登录失效”（2026-09-27 踩过）
async function refresh(callApi, cred) {
  if (syncing) return { ok: false, msg: '正在拉取中，请稍候' };
  syncing = true;
  let expected = 0;
  try { const old = read(); if (old && Array.isArray(old.points)) expected = old.points.length; } catch (e) { /* 忽略 */ }
  progress = { done: 0, total: expected, phase: '开始' };
  const auth = cred || {};
  const t0 = Date.now();
  try {
    const points = [];
    let cursor = '';
    for (let i = 0; i < MAX_PAGES; i++) {
      const res = JSON.parse(await callApi(Object.assign({ action: 'custMapPoints', cursor: cursor, limit: PAGE_LIMIT }, auth)));
      if (!res || !res.ok) throw new Error((res && res.msg) || '云函数返回异常');
      const got = res.points || [];
      points.push.apply(points, got);
      progress.done = points.length;
      progress.phase = '拉取中';
      if (!res.next || !got.length) break;
      cursor = res.next;
    }
    // 只留列表层需要的字段（压体积；详情走 getCustomerDetail 实时拉）
    // ⭐ 2026-09-27 M2a：扩到 12 项（含地址/坐标来源/坐标状态/编号/商城Key/updatedAt）——
    //   客户管理页的表格要用；一条约 180 字节 → 5 万家 ≈ 9MB，仍可控。
    const slim = points.map(p => ({
      i: p.i, n: p.n, la: p.la, ln: p.ln, c: p.c, d: p.d, b: p.b,
      ad: p.ad || '', cs: p.cs || '', cst: p.cst || '', mc: p.mc || '', mk: p.mk || '', u: p.u || 0,
      // ⭐ M2b 新增 6 项（本地列表渲染用）
      nr: p.nr || '', ca: p.ca || 0, ct: p.ct || '', ph: p.ph || '', rm: p.rm || '', bi: p.bi || '', mj: p.mj || '',
      // ⭐ 2026-09-27 老板定：「列表这几列今后都要做排序」→ 聚合结果也要进缓存，否则本地排不了序。
      //   ⚠️ 这里必须与云函数 custMapPoints/custSync 下发的字段**逐一对齐** —— 少写一个就会被"瘦身"筛掉，
      //   表现为"云函数明明返回了、界面却拿不到"（本次踩过一次）。
      oc: p.oc || 0, oa: p.oa || 0, lo: p.lo || '', vc: p.vc || 0, lv: p.lv || '', vs: p.vs || 'free', vt: p.vt || ''
    }));
    // ⭐ 2026-09-29【方案 C】记下"同步水位"maxU —— 增量同步（custSync 的 since）用它，
    //   比用本地时钟打点更可靠（本地时钟与云端不一定严丝合缝，会漏几秒）。
    let maxU = 0;
    slim.forEach(p => { if (Number(p.u) > maxU) maxU = Number(p.u); });
    write({ v: VERSION, syncedAt: Date.now(), maxU: maxU, count: slim.length, points: slim });
    progress.phase = '完成';
    console.log(`[store] 全量刷新完成：${slim.length} 家，耗时 ${Date.now() - t0}ms`);
    return { ok: true, count: slim.length, ms: Date.now() - t0 };
  } catch (e) {
    // ⚠️ 失败**不清空**旧缓存（架构文档：拉取失败也要能看到地图）
    progress.phase = '失败：' + (e && e.message ? e.message : e);
    console.error('[store] 全量刷新失败：', e && e.message);
    return { ok: false, msg: (e && e.message) || '拉取失败' };
  } finally {
    syncing = false;
  }
}

// ⭐ 2026-09-27 M3：**写后回写**（架构文档 §四）—— 前端改完（备注/坐标/字段/删除/建批次）把**那几条**
//   同步进本地缓存，不用等下次全量刷新。写路径不变：**永远先写云端，成功后才调这里**。
//   patches: [{ id, set: { 短键: 值 } }] ｜ removeIds: ['_id', ...]
function patch(patches, removeIds) {
  const c = read();
  if (!c || !Array.isArray(c.points)) return { ok: false, msg: '本地缓存还不存在（没预热过）', patched: 0, removed: 0 };
  const byId = {};
  (patches || []).forEach(p => { if (p && p.id) byId[p.id] = p.set || {}; });
  const rm = {};
  (removeIds || []).forEach(id => { if (id) rm[id] = 1; });
  let patched = 0, removed = 0;
  const points = [];
  c.points.forEach(p => {
    if (rm[p.i]) { removed++; return; }
    const set = byId[p.i];
    if (set) { Object.keys(set).forEach(k => { p[k] = set[k]; }); patched++; }
    points.push(p);
  });
  // syncedAt 保持不动（它表示“上次全量同步时间”，界面的「数据截至」用它）
  write({ v: VERSION, syncedAt: c.syncedAt, count: points.length, points: points });
  return { ok: true, patched: patched, removed: removed, count: points.length };
}

// ⭐⭐ 2026-09-29【方案 C】客户数据"变动检测 + 增量补"
//   背景：手机端「加新店」建了客户 → 后台看不到（客户管理页读的是**本地缓存快照**）。
//        老板实测：建了「菲菲杂粮煎饼」，后台「客户管理」里找不到。
//   做法：云端建店时写 settings.custDirtyAt；这里读缓存时顺手比一下，比缓存新就拉**增量**补上。
//   ⚠️ 全程**不阻塞**前端：由 server.js 在返回缓存**之后**异步调用，前端下次取就是新的。
let _dirtyBusy = false;
let _lastDirtyAt = 0;                    // 上次云端报的变动时间（避免重复处理同一个信号）

// 缓存里的"同步水位"：上次已经同步到哪个 updatedAt
function watermark(c) {
  if (!c) return 0;
  if (Number(c.maxU)) return Number(c.maxU);
  return Math.max(0, Number(c.syncedAt || 0) - 5000);   // 老缓存没 maxU：留 5 秒余量，宁可多拉几条
}

// 增量补：走 custSync（只拉 updatedAt > since 的），按 _id 覆盖 / 追加
async function syncIncremental(callApi, cred, since) {
  const c = read();
  if (!c || !Array.isArray(c.points)) return { ok: false, msg: '本地缓存还不存在' };
  const t0 = Date.now();
  const got = [];
  let cursor = '', maxU = since;
  for (let i = 0; i < 50; i++) {          // 最多 50 片 × 1000 条，防死循环
    const res = JSON.parse(await callApi(Object.assign(
      { action: 'custSync', since: since, cursor: cursor, limit: 1000 }, cred || {})));
    if (!res || !res.ok) throw new Error((res && res.msg) || '云函数返回异常');
    const arr = res.points || [];
    got.push.apply(got, arr);
    if (Number(res.maxUpdatedAt) > maxU) maxU = Number(res.maxUpdatedAt);
    if (!res.next || !arr.length) break;
    cursor = res.next;
  }
  // merge：云端返回的覆盖本地同名条；其余原样保留；云端多出来的**追加**（这正是"新建的店"）
  const byId = {};
  got.forEach(p => { if (p && p.i) byId[p.i] = p; });
  const merged = [];
  const seen = {};
  c.points.forEach(p => {
    if (byId[p.i]) { merged.push(byId[p.i]); seen[p.i] = 1; } else { merged.push(p); }
  });
  got.forEach(p => { if (p && p.i && !seen[p.i]) merged.push(p); });
  // syncedAt 保持不动（界面「数据截至」显示的仍是上次全量时间）
  write({ v: VERSION, syncedAt: c.syncedAt, maxU: maxU, count: merged.length, points: merged });
  console.log(`[store] 增量补完成：云端 ${got.length} 条变动，缓存 ${c.points.length} → ${merged.length} 家，耗时 ${Date.now() - t0}ms`);
  return { ok: true, changed: got.length, count: merged.length };
}

// 检查云端有没有变动；有就拉增量补进缓存。返回 true = 这次补了数据（前端据此重取列表）
async function checkDirty(callApi, cred) {
  if (_dirtyBusy) return false;                        // 正在处理，别叠
  _dirtyBusy = true;
  try {
    const res = JSON.parse(await callApi(Object.assign({ action: 'custDirty' }, cred || {})));
    const at = (res && res.ok && Number(res.at)) || 0;
    if (!at || at <= _lastDirtyAt) return false;       // 没变动 / 同一个信号
    _lastDirtyAt = at;
    const since = watermark(read());
    if (at > since) {                                  // 云端比缓存的"水位"新 → 补
      const r = await syncIncremental(callApi, cred, since);
      return !!(r && r.ok);
    }
    return false;
  } catch (e) {
    console.error('[store] 变动检测失败（不影响使用）：', e && e.message);
    return false;
  } finally {
    _dirtyBusy = false;
  }
}

// 启动时自动预热：当天没拉过就静默拉一次（**不阻塞服务启动**）
function startAutoRefresh(callApi, cred) {
  const c = read();
  if (isFreshToday(c)) {
    console.log(`[store] 缓存是今天的（${c.points.length} 家），跳过预热`);
    return;
  }
  console.log('[store] 缓存不存在或已过期 → 后台静默预热…');
  refresh(callApi, cred).catch(() => null);
}

module.exports = { read, write, status, refresh, patch, checkDirty, syncIncremental, startAutoRefresh, isFreshToday, FILE, CACHE_DIR };
