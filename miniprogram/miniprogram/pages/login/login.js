const api = require('../../utils/api');

Page({
  data: { user: null, binding: false, salesmen: [], hasTrial: false, adminMode: false, adminName: '', logoUrl: '' },
  onShow() {
    const app = getApp();
    this.setData({ logoUrl: app.globalData.logoUrl });
    if (app.globalData.user && app.globalData.user.role === 'salesman') {
      wx.redirectTo({ url: '/pages/home/home' });
      return;
    }
    this.check();
  },
  async check() {
    try {
      const res = await api.call('login');
      if (res.ok && res.user.role === 'salesman') {
        getApp().setUser(res.user);
        wx.redirectTo({ url: '/pages/home/home' });
      } else if (res.ok) {
        // 管理员微信打开了业务员小程序：仅提示使用 Web 后台
        this.setData({ adminMode: true, adminName: res.user.name || '管理员' });
      } else if (res.code === 'NEED_BIND') {
        this.setData({ binding: true, salesmen: res.salesmen || [], hasTrial: !!(res.salesmen || []).some(s => s.trial) });
      } else {
        api.toast(res.msg || '登录失败');
      }
    } catch (e) {
      api.toast('云函数调用失败，请确认已部署 login');
    }
  },
  refresh() {
    getApp().clearUser();
    this.setData({ adminMode: false });
    this.check();
  },
  // LOGO 云端加载失败 → 回退本地图，避免白板
  onLogoError() {
    if (this.data.logoUrl !== '/images/logo.png') {
      this.setData({ logoUrl: '/images/logo.png' });
    }
  },
  async bind(e) {
    const id = e.currentTarget.dataset.id;
    try {
      const res = await api.call('login', { bindUserId: id });
      if (res.ok) {
        getApp().setUser(res.user);
        api.toast('绑定成功 ✓', 'success');
        setTimeout(() => wx.redirectTo({ url: '/pages/home/home' }), 600);
      } else {
        api.toast(res.msg || '绑定失败');
        this.check();
      }
    } catch (err) {
      api.toast('绑定失败，请重试');
    }
  }
});
