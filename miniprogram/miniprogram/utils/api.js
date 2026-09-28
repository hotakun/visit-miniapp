// 公共工具：云函数调用 / 提示 / 日期
function call(name, data = {}) {
  // 2026-09-09 开发者（范宇琨）双身份：本地老板演示态时所有请求自动附加 boss 标志，
  // 云端对 dev 白名单（13067737286）凭此标志按老板处理（全量只读+虚拟写）；
  // 业务员身份不带标志，云端按普通业务员处理。真实老板（15055492888）云端直接认号，不受此影响。
  const app = getApp();
  if (app && app.globalData.bossMode && !data.boss) {
    data = Object.assign({}, data, { boss: true });
  }
  // 2026-09-28 实习态（实习/游客入口）：**两个字段都要带**，各云函数认的名字不同 ——
  //   · asTrial      → 业务云函数（tasks/visits/transcribe/coordfix）的"兜底认人"
  //   · asTrialVisit → login 云函数的只读实习分支
  //   ⚠️ 只带 asTrial 时 login **不认** → 会走普通流程查不到 openid 绑定 → 回 NEED_REGISTER
  //      → 首页身份复核把实习身份踢回登录页（2026-09-28 踩过：点实习入口进去马上被踢）。
  if (app && app.globalData.asTrial && !data.asTrialVisit) {
    data = Object.assign({}, data, { asTrial: true, asTrialVisit: true });
    // ⚠️ 2026-09-28 必带 trialId：实习**不绑 openid**，云端只能拿 trialId 去库里核对身份
    //   （tasks/visits/transcribe/coordfix 的"兜底认人"段）。不带 → 云端回 NO_AUTH →
    //   实习进来**任务列表是空的**（老板报的"看不到任务"就是这个，2026-09-28 踩过）。
    if (app.globalData.trialId) data.trialId = app.globalData.trialId;
  }
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
