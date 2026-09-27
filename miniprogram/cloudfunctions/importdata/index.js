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
//   { action:'import', type:'customers'|'orders'|'order_items', rows:[...], username, password, mode }
//     → { ok, type, mode, total, inserted, updated, skipped, failed[], failedCount, ms }
//   { action:'stats', username, password }
//     → { ok, counts:{ customers, orders, order_items, mall_customers, visits } }
//
// 【两种写入模式】
//   （默认）/ 'overwrite' —— 商城、订单导入：非空字段照写，**空值不写**
//   'fill'               —— ⭐ 大众点评导入（2026-09-26 老板定）：**字段级取优**
//       ① 按 shopuuid 匹配已有客户（**不启用 name+phone 兜底** —— 点评里同名店太多，如沙县小吃 342 家）
//       ② 匹配上 → 只补空位（云端已有值一律让位，**冲突以商城为准**）；平台画像 plat 等照写
//       ③ 匹配不上 → **新建客户**（旧规则"匹配不上就跳过丢掉"已作废）
//
// 【幂等】同一份数据导入两次，条数不翻倍：
//   customers   → 依次尝试 mallKey → platShopUuid → (name + phone；fill 模式不走这条)
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

// 按幂等键找已存在的档案，返回 { id, doc }（找不到返回 null）
//   doc = 云端已有整条档案 —— 「点评导入」要靠它判断哪些字段已有值（有值就让位，见 upsertOne）
//   mode='fill'（点评导入）时**不启用 name+phone 兜底**：
//     点评表里同名店极多（沙县小吃有 342 个不同 shopuuid），只有 shopuuid 才是铁证。
async function findExisting(type, row, mode) {
  const pick = (r) => (r.data.length ? { id: r.data[0]._id, doc: r.data[0] } : null);
  if (type === 'customers') {
    if (row.mallKey) {
      const hit = pick(await db.collection('customers').where({ mallKey: row.mallKey }).limit(1).get());
      if (hit) return hit;
    }
    if (row.platShopUuid) {
      const hit = pick(await db.collection('customers').where({ platShopUuid: row.platShopUuid }).limit(1).get());
      if (hit) return hit;
    }
    if (row.name && mode !== 'fill') {
      const hit = pick(await db.collection('customers').where({ name: row.name, phone: row.phone || '' }).limit(1).get());
      if (hit) return hit;
    }
    return null;
  }
  if (type === 'orders') {
    if (!row.orderNo) return null;
    return pick(await db.collection('orders').where({ orderNo: row.orderNo }).limit(1).get());
  }
  // order_items
  if (!row.orderNo) return null;
  return pick(await db.collection('order_items').where({ orderNo: row.orderNo, lineNo: row.lineNo || 0 }).limit(1).get());
}

// 值算不算「空」：空串 / 空数组 / 空对象 / null / undefined 算空；数字 0、布尔 false 算**有值**
function isEmptyVal(v) {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ⭐ 2026-09-26 老板定：**平台画像永远照写**
//   点评表就是 plat 这一块的唯一来源，所以「点评导入不覆盖已有值」这条对它们**不适用**；
//   但 platManual（后台人工补录的点评字段）**不在里面** —— 那是人的成果，不能被覆盖。
const PLAT_KEYS = { plat: 1, platMatched: 1, platMergeCount: 1, platMergeFrom: 1 };
// ⭐ 2026-09-27 老板定「**谁详细用谁**」：这些**文本字段**在 fill 模式下，新值更详细（更长）就覆盖。
//   缘由：老板报障“导入了平台信息但客户详情里没地址” —— 商城写了个空/短地址，把点评的完整地址挡住了。
const DETAIL_KEYS = { address: 1 };

// 单行 upsert：有则 update，无则 add
//   mode='fill'（大众点评导入）→ **字段级取优**：云端已有值的字段一律让位（冲突以商城为准），只补空位；
//      平台画像（plat / platMatched / platMergeCount / platMergeFrom）例外，照写（见 PLAT_KEYS）。
//   其它（商城 / 订单导入）→ 非空字段照写；**空值不写**（免得把已有信息擦成空）。
//   ⭐ 2026-09-26 新规则（老板定）：点评导入**匹配不上就新建客户**（旧规则是**跳过丢掉**，已作废）。
async function upsertOne(type, row, mode) {
  const fill = mode === 'fill';
  const coll = COLL[type];
  const found = await findExisting(type, row, mode);
  const data = Object.assign({}, row);
  delete data._id; // 云开发 update 的 data 不允许带 _id

  // ⭐ 2026-09-26 多城市改造：**导入 customers 时自动算好三层骨架字段**
  //   （city / district / bizCircle）—— 往后谁导都一样，不需要任何人手动补一步。
  //   规则：分片里**明确带了就尊重它**（只补空的），没带就从 plat / region 推。
  if (type === 'customers') {
    const geo = deriveGeo(data);
    if (!data.city)      data.city      = geo.city;
    if (!data.district)  data.district  = geo.district;
    if (!data.bizCircle) data.bizCircle = geo.bizCircle;
  }

  if (found && found.id) {
    const payload = { updatedAt: Date.now() };
    for (const k of Object.keys(data)) {
      if (isEmptyVal(data[k])) continue;                                  // 空值不写
      if (fill && !PLAT_KEYS[k] && !isEmptyVal(found.doc[k])) {
        // ⭐ 2026-09-27「谁详细用谁」：address 这类文本字段，新值**更详细（更长）**就覆盖；其余字段照旧让位。
        if (DETAIL_KEYS[k] && String(data[k]).trim().length > String(found.doc[k]).trim().length) {
          payload[k] = data[k];
        }
        continue;
      }
      payload[k] = data[k];
    }
    if (Object.keys(payload).length <= 1) return 'skipped';               // 只剩 updatedAt → 不必写
    await db.collection(coll).doc(found.id).update({ data: payload });
    return 'updated';
  }
  if (!data.createdAt) data.createdAt = Date.now();
  await db.collection(coll).add({ data });
  return 'inserted';
}

// 三层骨架字段的取数规则（与 adminapi 的 deriveGeo **保持一致** —— 改一处要改两处）
//   city      ← plat.city        退化：region（"浙江省>金华市>永康市"）第 2 段
//   district  ← plat.district    退化：region 第 3 段
//   bizCircle ← plat.regionName  退化："❓ 未划分商圈"（骨架不断裂、不丢客户）
function deriveGeo(c) {
  const p = c.plat || {};
  const seg = String(c.region || '').split('>').map(s => s.trim()).filter(Boolean);
  let city = String(p.city || '').trim() || seg[1] || '';
  if (city && !/市$/.test(city)) city += '市';
  const district = String(p.district || '').trim() || seg[2] || '';
  const bizCircle = String(p.regionName || '').trim() || '❓ 未划分商圈';
  return { city, district, bizCircle };
}

async function doImport(event) {
  const admin = await verifyAdmin(event);
  if (!admin) return { ok: false, code: 'NO_AUTH', msg: '账号或密码不正确（或无权限）' };
  const type = event.type;
  if (!COLL[type]) return { ok: false, code: 'BAD_TYPE', msg: '不支持的数据类型：' + type };
  const rows = Array.isArray(event.rows) ? event.rows.filter(r => r && typeof r === 'object') : [];
  if (!rows.length) return { ok: false, code: 'BAD_ARG', msg: '本片没有数据' };

  const t0 = Date.now();
  // mode='fill' = 大众点评导入（字段级取优：只补空位，冲突以商城为准）
  const mode = event.mode === 'fill' ? 'fill' : '';
  let inserted = 0, updated = 0, skipped = 0;
  const failed = [];
  // 并发：2026-09-25 由 15 提到 30 —— 云函数 30s 超时（-601008）是导入最大的坑，
  // 并发翻倍能把单片耗时砍掉一半（157 行/片从 ~25s 降到 ~12s）。若云端报"连接数超限"，退回 20。
  await runPool(rows, 30, async (row, i) => {
    try {
      const act = await upsertOne(type, row, mode);
      if (act === 'inserted') inserted++; else if (act === 'skipped') skipped++; else updated++;
    } catch (e) {
      failed.push({
        i,
        key: String(row.mallKey || row.orderNo || row.name || '').slice(0, 40),
        err: String((e && e.message) || e).slice(0, 120)
      });
    }
  });
  return {
    ok: true, type, mode: mode || 'overwrite', total: rows.length, inserted, updated, skipped,
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
