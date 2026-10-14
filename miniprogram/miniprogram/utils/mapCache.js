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
const TTL = 10 * 60 * 1000; // 缓存 10 分钟（地图打开先渲染缓存，云端数据到达后静默更新）

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
    if (c && c.at && Date.now() - Number(c.at) < TTL && c.map) return c;
  } catch (e) { /* 静默 */ }
  return null;
}

function set(res, mode) {
  try {
    wx.setStorageSync(key(mode), { at: Date.now(), map: res.map || null, tasks: res.tasks || null });
  } catch (e) { /* 静默 */ }
}

module.exports = { TTL, key, curMode, get, set };
