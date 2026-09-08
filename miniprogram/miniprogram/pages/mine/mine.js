const api = require('../../utils/api');
const { SUBSCRIBE_TEMPLATE_ID } = require('../../utils/config');

Page({
  data: { user: {}, stats: { monthCount: 0, monthCust: 0, taskRate: 0 }, subOn: false, version: '0.9.02' },
  onShow() {
    const app = getApp();
    this.setData({ version: app.globalData.APP_VERSION || '0.9.00' }); // 版本号（2026-09-08 老板定）
    const u = app.globalData.user;
    if (!u || u.role !== 'salesman') {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.setData({ user: u });
    this.loadStats();
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
  tabMap() { wx.redirectTo({ url: '/pages/map/map' }); }
});
