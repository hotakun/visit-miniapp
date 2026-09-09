// 公共工具：云函数调用 / 提示 / 日期
function call(name, data = {}) {
  return new Promise((resolve, reject) => {
    wx.cloud.callFunction({
      name,
      data,
      success: (r) => resolve(r.result),
      fail: reject
    });
  });
}

function toast(title, icon = 'none') {
  const text = String(title || '操作失败');
  // 本环境 wx.showModal 原生弹窗打开失败：一律用 wx.showToast，超长截断（重要信息放前半句）
  const t = text.length > 14 ? text.slice(0, 13) + '…' : text;
  wx.showToast({ title: t, icon, duration: icon === 'none' ? 2500 : 2000 });
}

function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 游客（实习账号）工具（2026-09-08 老板定：游客只能体验，不能提交数据/看完整电话/拨号）
function isTrialUser() {
  const u = getApp().globalData.user;
  return !!(u && u.trial);
}

// 老板模式（2026-09-09 §7.13：管理员微信专用演示态——全量只读+虚拟写，电话不打码）
function isBossMode() {
  return !!getApp().globalData.bossMode;
}

// 游客电话打码：后四位显示 ****（如 1389408****）
function maskTrialPhone(p) {
  const s = String(p || '').trim();
  return s.length >= 4 ? s.slice(0, s.length - 4) + '****' : (s || '****');
}

module.exports = { call, toast, today, isTrialUser, isBossMode, maskTrialPhone };
