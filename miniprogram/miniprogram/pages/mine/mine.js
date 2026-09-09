const api = require('../../utils/api');
const { SUBSCRIBE_TEMPLATE_ID } = require('../../utils/config');

Page({
  data: { user: {}, stats: { monthCount: 0, monthCust: 0, taskRate: 0 }, subOn: false, version: '0.9.04', bossMode: false, isDev: false },
  onShow() {
    const app = getApp();
    this.setData({ version: app.globalData.APP_VERSION || '0.9.00', isDev: !!app.globalData.isDev || (app.globalData.user && app.globalData.user.phone === '13067737286') }); // 版本号（2026-09-08 老板定）；isDev=开发者切换入口（2026-09-09 范宇琨，手机号兜底防冷启动未激活标志）
    // 老板模式（2026-09-09 §7.13）：无业务员数据要求，显示老板卡+退出入口
    if (app.globalData.bossMode) {
      this.setData({ bossMode: true, user: { name: '老板' } });
      return;
    }
    const u = app.globalData.user;
    if (!u || u.role !== 'salesman') {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.setData({ bossMode: false, user: u });
    this.loadStats();
  },
  // 退出老板模式（2026-09-09 §7.13）：清 bossMode → 回管理员提示页
  exitBoss() {
    getApp().setBossMode(false);
    getApp().clearUser();
    wx.redirectTo({ url: '/pages/login/login' });
  },
  // 开发者切换身份（2026-09-09 开发者范宇琨定：业务员身份下回到两按钮选择页）
  exitDev() {
    getApp().clearUser();
    wx.redirectTo({ url: '/pages/login/login' });
  },
  async loadStats() {
    try {
      const res = await api.call('visits', { action: 'mystats' });
      if (res.ok) this.setData({ stats: res });
    } catch (e) { /* 统计失败静默 */ }
    try {
      const sub = await api.call('tasks', { action: 'subStatus' });
      if (sub.ok) this.setData({ subOn: !!sub.hasSub || !!sub.mpBound, mpBound: !!sub.mpBound });
    } catch (e) { /* 静默 */ }
  },
  async subscribe() {
    try {
      const r = await new Promise((resolve, reject) => {
        wx.requestSubscribeMessage({ tmplIds: [SUBSCRIBE_TEMPLATE_ID], success: resolve, fail: reject });
      });
      const token = r[SUBSCRIBE_TEMPLATE_ID];
      if (token === 'accept') {
        const res = await api.call('subscribe', { token });
        if (res.ok) {
          this.setData({ subOn: true });
          api.toast('订阅成功 ✓ 有新任务会微信通知你');
        } else {
          api.toast(res.msg || '订阅保存失败');
        }
      } else {
        api.toast('未授权订阅（一次性订阅，每次授权可收一条）');
      }
    } catch (e) {
      api.toast('订阅失败，请重试');
    }
  },
  tapSetting() { api.toast('设置功能开发中'); },
  tapAbout() { api.toast('聚火拜访 · 客户回访管理'); },
  tabHome() { wx.redirectTo({ url: '/pages/home/home' }); },
  tabMap() { wx.redirectTo({ url: '/pages/map/map' }); },
  tabWar() { wx.redirectTo({ url: '/pages/bossWar/bossWar' }); } // 老板四栏（2026-09-09 §7.13）
});
