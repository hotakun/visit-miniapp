// 分享配置统一出口（2026-09-24）
//
// 为什么有这个文件：9 个页面的 onShareAppMessage 原本**逐字重复**同一段配置；
// 加上「推荐人」后 path 还要带分享者的 users._id → 统一到一处，免得 9 处各写一遍、以后改一次要改 9 个文件。
//
// 用法（页面里）：
//   const share = require('../../utils/share');
//   onShareAppMessage() { return share.cfg(); }
//
// 推荐人机制：
//   · 已登录（业务员 / 老板 / 管理员）→ path 带上自己的 _id，被拉来的人就记「他」为推荐人
//   · 未登录（登录页上的分享）→ 不带 ref（不知道是谁分享的）
//   接收参数的地方在 app.js 的 captureRef()（onLaunch / onShow 两处都接了）

const SHARE_TITLE = '聚火拜访 · 业务员拜访管理';
const SHARE_IMAGE = '/images/share.png'; // 分享封面（5:4，由 logo 生成）

// 生成分享配置（每次调用时现取当前登录用户 —— 不能在模块顶层取 getApp）
function cfg() {
  let ref = '';
  try {
    const app = getApp();
    const u = (app && app.globalData && app.globalData.user) || null;
    ref = (u && u._id) ? String(u._id) : '';
  } catch (e) { ref = ''; }
  return {
    title: SHARE_TITLE,
    // 指到登录页：未登录的人打开就看到注册表单；已登录的人会被 login 页 onShow 自动送进首页
    path: '/pages/login/login' + (ref ? ('?ref=' + ref) : ''),
    imageUrl: SHARE_IMAGE
  };
}

module.exports = { cfg };
