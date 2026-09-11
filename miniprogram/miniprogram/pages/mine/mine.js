const api = require('../../utils/api');
const { SUBSCRIBE_TEMPLATE_ID } = require('../../utils/config');

Page({
  // 2026-09-11 老板要求：支持转发给同事好友（标题统一、点开进首页）
  onShareAppMessage() {
    return {
      title: '聚火拜访 · 业务员拜访管理',
      path: '/pages/home/home',
      imageUrl: '/images/share.png'   // 分享封面（5:4，由 logo 生成）
    };
  },
  data: { user: {}, stats: { monthCount: 0, monthCust: 0, taskRate: 0 }, subOn: false, version: '0.9.11', bossMode: false, isDev: false, aboutShow: false, aboutText: '' },
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
  // 2026-09-10 老板定：业务员「退出身份」——清本地身份缓存回登录页（换人用机/离职时自己可退出）
  exitIdentity() {
    wx.showModal({
      title: '退出身份',
      content: '退出后需要重新登录，或重新提交注册申请等待审核。确定退出？',
      confirmText: '退出',
      confirmColor: '#E5484D',
      success: (r) => {
        if (!r.confirm) return;
        getApp().clearUser();
        wx.redirectTo({ url: '/pages/login/login' });
      }
    });
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
          api.toast('订阅成功 ✓ 有新任务会通知你');
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
  tapAbout() {
    // 2026-09-09 老板定：关于弹层按角色显示不同简介（业务员=跑店视角；老板=管理视角），按语义分行
    this.setData({
      aboutShow: true,
      aboutText: this.data.bossMode
        ? '聚火拜访，管理好帮手：\n任务进度、员工动态实时掌握，\n谁在拜访一看便知；\n注册审核、任务派发，一手把控。'
        : '聚火拜访，跑店好帮手：\n任务路线一目了然，\n导航到店、打卡拜访、拍照记录，\n每天跑了多少家清清楚楚，\n回访不遗漏。'
    });
  },
  closeAbout() { this.setData({ aboutShow: false }); },
  noop() {}, // 弹层卡片点击不冒泡到遮罩关闭（2026-09-09）
  tabHome() { wx.switchTab({ url: '/pages/home/home' }); }, // 2026-09-10：自定义 tabBar 常驻栏
  tabMap() { wx.switchTab({ url: '/pages/map/map' }); },
  tabWar() { wx.switchTab({ url: '/pages/bossWar/bossWar' }); } // 老板四栏（2026-09-09 §7.13）
});
