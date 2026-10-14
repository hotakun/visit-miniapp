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

// ⭐⭐ 2026-10-15 加（依《全项目审查》C01）：**身份指纹 = 登录人 + 身份模式**。
//   为什么键里已经有 uid 还要它？因为**同一个人切模式**用的是**同一个 uid** ——
//   老板兼业务员（`alsoSalesman`）、老板看板 ↔ 业务员视图来回切，都是同一个 `_id`，
//   而两份数据并不一样（最典型的是 `custDetail` 里那条 `mine`：这条拜访记录是不是"我"记的，
//   老板模式与业务员模式的答案不同）。键一样 + 数据不同 = 会串。
//   ⚠️ 另外这也能兜住"C01 描述的竞态"的大部分后果：请求在途时切了身份，
//      回包回来时 `who()` 已经变了 → 下面 `get` 的校验会认为这条缓存不属于当前身份、直接弃用。
//      （写进去的那一下仍可能落在新身份名下，但**读的时候会被拦掉**；而且窗口极窄、
//        客户详情页还有 60 秒静默更新兜底。）
function who() {
  try {
    const g = getApp().globalData || {};
    const u = g.user || {};
    const mode = g.bossMode ? 'boss' : (g.asSalesman ? 'sales' : 'me');
    return ((u && u._id) || '') + '|' + mode;
  } catch (e) { return '|'; }
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

// 读：跨天（或超过 ttlMs、或身份变了）就当没有
function get(ns, id, ttlMs) {
  try {
    const r = wx.getStorageSync(key(ns, id));
    if (!r || !r.at) return null;
    if (r.day !== dayStr()) return null;                                  // 跨天失效
    if (r.who && r.who !== who()) return null;                            // ⭐ 身份模式变了 → 弃用（见 who() 注释）
    if (ttlMs && Date.now() - Number(r.at) > ttlMs) return null;           // 短期限
    return r.val;
  } catch (e) { return null; }
}

// 写：附上时间戳、日期串与身份指纹
//   ⚠️ `expectWho`（可选）：调用方可以传"**发起请求那一刻**的 `who()`" ——
//      若与写入时的 `who()` 不一致，说明这批数据已不属于当前身份，**直接不写**。
//      （现有的调用点可以不传；传了就更严格。见 who() 注释里的竞态说明。）
function set(ns, id, val, expectWho) {
  try {
    const w = who();
    if (expectWho && expectWho !== w) return false;   // 请求期间身份变了 → 丢弃，别写到别人名下
    wx.setStorageSync(key(ns, id), { at: Date.now(), day: dayStr(), who: w, val });
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

module.exports = { DAY_MS, uid, who, dayStr, key, get, set, del, meta };
