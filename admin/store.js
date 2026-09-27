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
const VERSION = 2;              // ⭐ 2026-09-27 M2a：字段从 7 项扩到 12 项 → 升版本，旧缓存自动失效并重拉
const PAGE_LIMIT = 1000;        // 每片 1000 条（云函数单次返回上限 100KB，1000 条约 100KB 内）
const MAX_PAGES = 1000;         // 硬上限（100 万条），防死循环

let syncing = false;            // 是否正在拉取（前端显示进度用）
let progress = { done: 0, phase: '' };

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
  progress = { done: 0, phase: '开始' };
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
      ad: p.ad || '', cs: p.cs || '', cst: p.cst || '', mc: p.mc || '', mk: p.mk || '', u: p.u || 0
    }));
    write({ v: VERSION, syncedAt: Date.now(), count: slim.length, points: slim });
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

module.exports = { read, write, status, refresh, startAutoRefresh, isFreshToday, FILE, CACHE_DIR };
