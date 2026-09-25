// ============================================================================
// importdata —— 客户数据「分片导入」专用云函数（2026-09-24 新建）
//
// 【为什么要独立一个云函数】
//   导入是重活（几千~几万行），要独立超时预算；adminapi 已经 3000+ 行、还挂着定时器
//   与通知职责，不该再往里塞导入。
//
// ⚠️ 云函数之间**不能共享代码** —— 下面的 verifyAdmin / runPool 是从 adminapi 复制的，
//    改 adminapi 里那两份时记得同步这里（鉴权口径必须一致）。
//
// 【调用方式】（后台 admin.html 调用；**分片由前端按字节切好**，每片 60~70KB）
//   { action:'import', type:'customers'|'orders'|'order_items', rows:[...], username, password }
//     → { ok, type, total, inserted, updated, failed[], failedCount, ms }
//   { action:'stats', username, password }
//     → { ok, counts:{ customers, orders, order_items, mall_customers, visits } }
//
// 【幂等】同一份数据导入两次，条数不翻倍：
//   customers   → 依次尝试 mallKey → platShopUuid → (name + phone)
//   orders      → orderNo
//   order_items → orderNo + lineNo（行号，阶段 3 的合并脚本负责生成）
// ============================================================================
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// —— 鉴权（复制自 adminapi/index.js 的 verifyAdmin，保持完全一致：账号+密码 sha256 逐次校验）——
async function verifyAdmin(event) {
  const { username, password } = event;
  if (!username || !password) return null;
  const res = await db.collection('users')
    .where({ username, role: _.in(['super_admin', 'admin']), active: true })
    .get();
  if (!res.data.length) return null;
  const u = res.data[0];
  if (!u.passwordHash || u.passwordHash !== sha256(password)) return null;
  return u;
}

// —— 并发池（逐行查/写，串行会超时；15 并发沿用项目里既有的安全档位）——
async function runPool(items, size, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.min(size, items.length || 1);
  await Promise.all(new Array(n).fill(0).map(worker));
  return out;
}

const COLL = { customers: 'customers', orders: 'orders', order_items: 'order_items' };

// 按幂等键找已存在的档案，返回 _id（找不到返回 null）
async function findExisting(type, row) {
  if (type === 'customers') {
    if (row.mallKey) {
      const r = await db.collection('customers').where({ mallKey: row.mallKey }).limit(1).get();
      if (r.data.length) return r.data[0]._id;
    }
    if (row.platShopUuid) {
      const r = await db.collection('customers').where({ platShopUuid: row.platShopUuid }).limit(1).get();
      if (r.data.length) return r.data[0]._id;
    }
    if (row.name) {
      const r = await db.collection('customers').where({ name: row.name, phone: row.phone || '' }).limit(1).get();
      if (r.data.length) return r.data[0]._id;
    }
    return null;
  }
  if (type === 'orders') {
    if (!row.orderNo) return null;
    const r = await db.collection('orders').where({ orderNo: row.orderNo }).limit(1).get();
    return r.data.length ? r.data[0]._id : null;
  }
  // order_items
  if (!row.orderNo) return null;
  const r = await db.collection('order_items').where({ orderNo: row.orderNo, lineNo: row.lineNo || 0 }).limit(1).get();
  return r.data.length ? r.data[0]._id : null;
}

// 单行 upsert：有则 update（只覆盖带过来的字段，不动其它），无则 add
async function upsertOne(type, row) {
  const coll = COLL[type];
  const existId = await findExisting(type, row);
  const data = Object.assign({}, row);
  delete data._id; // 云开发 update 的 data 不允许带 _id
  if (existId) {
    data.updatedAt = Date.now();
    await db.collection(coll).doc(existId).update({ data });
    return 'updated';
  }
  if (!data.createdAt) data.createdAt = Date.now();
  await db.collection(coll).add({ data });
  return 'inserted';
}

async function doImport(event) {
  const admin = await verifyAdmin(event);
  if (!admin) return { ok: false, code: 'NO_AUTH', msg: '账号或密码不正确（或无权限）' };
  const type = event.type;
  if (!COLL[type]) return { ok: false, code: 'BAD_TYPE', msg: '不支持的数据类型：' + type };
  const rows = Array.isArray(event.rows) ? event.rows.filter(r => r && typeof r === 'object') : [];
  if (!rows.length) return { ok: false, code: 'BAD_ARG', msg: '本片没有数据' };

  const t0 = Date.now();
  let inserted = 0, updated = 0;
  const failed = [];
  // 并发：2026-09-25 由 15 提到 30 —— 云函数 30s 超时（-601008）是导入最大的坑，
  // 并发翻倍能把单片耗时砍掉一半（157 行/片从 ~25s 降到 ~12s）。若云端报"连接数超限"，退回 20。
  await runPool(rows, 30, async (row, i) => {
    try {
      const act = await upsertOne(type, row);
      if (act === 'inserted') inserted++; else updated++;
    } catch (e) {
      failed.push({
        i,
        key: String(row.mallKey || row.orderNo || row.name || '').slice(0, 40),
        err: String((e && e.message) || e).slice(0, 120)
      });
    }
  });
  return {
    ok: true, type, total: rows.length, inserted, updated,
    failed: failed.slice(0, 20), failedCount: failed.length,
    by: admin.name, ms: Date.now() - t0
  };
}

async function stats(event) {
  const admin = await verifyAdmin(event);
  if (!admin) return { ok: false, code: 'NO_AUTH', msg: '未授权' };
  const one = async (c) => { try { const r = await db.collection(c).count(); return r.total; } catch (e) { return -1; } };
  // 条件计数（阶段 5 导入后校验用：已加入商城的家数 / 没坐标的家数）
  const cond = async (where) => {
    try { const r = await db.collection('customers').where(where).count(); return r.total; } catch (e) { return -1; }
  };
  return {
    ok: true,
    counts: {
      customers: await one('customers'),
      customersMall: await cond({ mallKey: _.exists(true) }), // 其中「已加入商城」
      customersNoCoord: await cond({ lat: _.eq(null) }),      // 其中没坐标的（导入后应为 0）
      orders: await one('orders'),
      order_items: await one('order_items'),
      mall_customers: await one('mall_customers'),
      visits: await one('visits')
    }
  };
}

exports.main = async (event) => {
  const action = (event && event.action) || 'import';
  try {
    if (action === 'import') return await doImport(event);
    if (action === 'stats') return await stats(event);
    return { ok: false, code: 'BAD_ACTION', msg: '未知 action：' + action };
  } catch (e) {
    return { ok: false, code: 'EXCEPTION', msg: String((e && e.message) || e) };
  }
};
