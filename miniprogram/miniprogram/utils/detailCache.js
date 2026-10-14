// utils/detailCache.js —— 详情类数据的「当天有效」本地缓存（一处定义）
//
// ⭐ 2026-10-15 立（老板定「把缓存用好，省掉重复调用」）。用途：
//   · `taskSkeleton`  任务骨架（任务信息 + 客户卡片字段）—— 进任务先渲染它（秒开）
//   · `taskVisitState` 任务拜访状态（哪家打过勾 / 结果 / 时间）—— 提交拜访后就地更新，返回任务页不再拉
//   · `custOrders`    某客户最近订单 + 累计摘要 —— 按客户缓存，当天再进看缓存
//   · `custMediaUrl`  照片/录音的临时 URL（按 fileID）
//
// 🔴 三条铁律（违反就等于"改了看不到"，老板最反感的那种）：
//   ① **键必须带登录人** —— 同一台手机切身份（业务员 ↔ 老板 ↔ 老板兼业务员）绝不能串档
//      （2026-10-14 地图缓存就踩过这个，详见 utils/mapCache.js 的注释）。
//   ② **写永远先写云端，本地只是副本** —— 云端是唯一真相源；本地可丢、可重建。
//   ③ **写成功后必须就地更新本地 + 作废相关缓存** —— 这是"改完之后必须真的刷新"铁律的延伸。
//
// 过期策略：**跨天自动失效**（`day` 字段，用 +8 时区的日期串）+ 可选 `ttlMs` 更短的期限。

const DAY_MS = 24 * 60 * 60 * 1000;

// 当前登录人（键的一部分）
function uid() {
  try { const u = getApp().globalData.user; return (u && u._id) || ''; } catch (e) { return ''; }
}

// 本地日期串（+8 时区），跨天即失效
function dayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 拼 key：dc:<命名空间>:<登录人>:<业务 id>
function key(ns, id) {
  return 'dc:' + ns + ':' + uid() + ':' + (id || '');
}

// 读：跨天（或超过 ttlMs）就当没有
function get(ns, id, ttlMs) {
  try {
    const r = wx.getStorageSync(key(ns, id));
    if (!r || !r.at) return null;
    if (r.day !== dayStr()) return null;                                  // 跨天失效
    if (ttlMs && Date.now() - Number(r.at) > ttlMs) return null;           // 短期限
    return r.val;
  } catch (e) { return null; }
}

// 写：附上时间戳与日期串
function set(ns, id, val) {
  try {
    wx.setStorageSync(key(ns, id), { at: Date.now(), day: dayStr(), val });
    return true;
  } catch (e) { return false; }
}

// 删单个
function del(ns, id) {
  try { wx.removeStorageSync(key(ns, id)); } catch (e) { /* 静默 */ }
}

// 读整条记录（要拿 at 等元信息时用）
function meta(ns, id) {
  try {
    const r = wx.getStorageSync(key(ns, id));
    if (!r || !r.at || r.day !== dayStr()) return null;
    return { at: r.at, day: r.day };
  } catch (e) { return null; }
}

module.exports = { DAY_MS, uid, dayStr, key, get, set, del, meta };
