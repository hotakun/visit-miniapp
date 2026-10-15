// utils/mapCache.js —— 地图秒开缓存（一处定义）
//
// ⭐ 2026-10-14（依《小程序云用量深度审计与优化建议》抽出来）：
//   原来 `pages/home/home.js`（首页预取·只写）与 `pages/map/map.js`（地图页·读写）
//   **各写了一份一模一样的实现、共用固定键 `'map_cache'`**，两个毛病：
//     ① **两处必须完全一致** —— 改一处忘一处，首页预取写的键与地图页读的键对不上 → **秒开链路静默断掉**；
//     ② **固定键在同一台手机上切身份（业务员 ↔ 老板 / 老板兼业务员）或换任务时串档** ——
//        首屏会先渲染「上一个身份 / 上一个任务」的缓存（即使云端随后会覆盖，首屏也不该串）。
//   现在：**只在这里定义一份**，键 = `map_cache:<模式>:<当前登录人 _id>`；
//     模式：老板看板 = `boss`；某个任务 = `task:<taskId>`（自己的当前任务 = `task:self`）。
//   ⚠️ 只用于「展示用的地图摘要」的缓存；**写操作（submit / finish / reportLocation）绝不走它**。
// ⭐⭐ 2026-10-16 老板定：「缓存从云端拉取数值的跨度还能加大一些，因为可以主动刷新了嘛」——
//   地图摘要的时效：**2 小时 → 「当天」（跨天失效）**。
//   以前"过期"是唯一让数据更新的手段、不敢放长；现在地图页有「↻ 刷新」、首页/任务页也补了下拉刷新，
//   人想立刻要最新就自己拉一下 —— 所以"当天内直接用缓存"是安全的。
//   ⚠️ **"当天"是硬天花板**：跨天必须重拉（否则第二天打开会拿昨天的地图 = 老板最反感的"改了看不到"）。
//   ⚠️ 写操作（提交 / 取消拜访）仍会**主动作废**它（见 visit.js）—— 所以"刚拜访完看到旧地图"不可能发生。
//   ⚠️ 与 utils/detailCache.js 同口径：用 +8 时区的日期串判"跨天"。
function _dayStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
// ⚠️ `TTL` 只为兼容旧导出保留 —— **2026-10-16 起过期判断已改成"跨天"（见上面 `get`），它不再参与判定**。
const TTL = 2 * 60 * 60 * 1000;

// 缓存键：把「谁在看什么」编进去，避免不同身份/任务互相污染
function key(mode) {
  let uid = '';
  try { const u = getApp().globalData.user; uid = (u && u._id) || ''; } catch (e) { /* 静默 */ }
  return 'map_cache:' + (mode || '?') + ':' + uid;
}

// 当前首页/地图页默认的「模式」：老板看板 = boss；业务员自己的当前任务 = task:self
function curMode() {
  try { return getApp().globalData.bossMode ? 'boss' : 'task:self'; } catch (e) { return 'task:self'; }
}

function get(mode) {
  try {
    const c = wx.getStorageSync(key(mode));
    // ⚠️ 2026-10-16 改：判「跨天」（原来是"2 小时内"）—— 跨天失效是硬规则，当天内直接用缓存
    if (c && c.at && c.day === _dayStr() && c.map) return c;
  } catch (e) { /* 静默 */ }
  return null;
}

function set(res, mode) {
  try {
    wx.setStorageSync(key(mode), {
      at: Date.now(),
      day: _dayStr(),                          // ⭐ 2026-10-16：记下"哪一天"，`get` 据此判"跨天"
      map: res.map || null, tasks: res.tasks || null
    });
  } catch (e) { /* 静默 */ }
}

// ⭐ 2026-10-15 老板定「写成功就作废缓存」：地图页现在"有缓存就不再拉"，
//   所以**提交/取消拜访后必须主动作废**，否则再进地图**看不到刚拜访的那家**（"改完必须真的刷新"的延伸）。
// ⭐⭐ 2026-10-14 修（依《全项目审查》C02）：**只删存储缓存不够** ——
//   地图页有个**常驻内存**的 `_loaded`，`onShow` 见到它就直接不加载（也不会去读缓存），
//   于是"提交/取消拜访 → 只删存储缓存"等于白删：**进地图看不到刚拜访的那家**。
//   做法：作废时**顺手把"缓存版本"推进一格**（存 storage）；地图页 `onShow` 比对版本，
//   一变就清 `_loaded` 强制重载。**不靠"调用方记得通知地图页"**（与 `CUST_WRITE` 同一思路）。
const VER_KEY = 'map_cache_ver';
function ver() {
  try { return Number(wx.getStorageSync(VER_KEY)) || 0; } catch (e) { return 0; }
}
function del(mode) {
  try {
    wx.removeStorageSync(key(mode));
    wx.setStorageSync(VER_KEY, ver() + 1);   // 推进版本 → 地图页 onShow 会据此强制重载
  } catch (e) { /* 静默 */ }
}

module.exports = { TTL, key, curMode, get, set, del, ver };
