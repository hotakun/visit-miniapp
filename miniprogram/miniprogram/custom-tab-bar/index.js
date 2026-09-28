// 自定义底部 Tab 栏（2026-09-10 老板拍板定稿：根治切页白闪——tab 页由框架常驻，切换时底部栏不再重绘）
// 口径：业务员 3 栏（任务 / 任务地图 / 我的）；老板 4 栏（首页 / 任务地图 / 战况 / 我的）。
// 「我的」页按老板要求保持原样式，不纳入 tab 体系 → 点击走 navigateTo；其余按钮走 switchTab（不销毁页面）。
// 2026-09-28 老板定：栏尾再挂一个「退出」——点了**自动解绑**（仅解 trial 游客账号）并回登录页。
const api = require('../utils/api.js');
const TABS_SALESMAN = [
  { key: 'home', ic: '🏠', label: '任务', path: '/pages/home/home', tab: true },
  { key: 'map', ic: '🗺', label: '任务地图', path: '/pages/map/map', tab: true },
  { key: 'mine', ic: '👤', label: '我的', path: '/pages/mine/mine', tab: false }
];
const TABS_BOSS = [
  { key: 'home', ic: '🏠', label: '首页', path: '/pages/home/home', tab: true },
  { key: 'map', ic: '🗺', label: '任务地图', path: '/pages/map/map', tab: true },
  { key: 'war', ic: '📡', label: '战况', path: '/pages/bossWar/bossWar', tab: true },
  { key: 'mine', ic: '👤', label: '我的', path: '/pages/mine/mine', tab: false }
];

Component({
  data: {
    selected: 0,
    tabs: TABS_SALESMAN,
    isTrial: false          // 2026-09-28：只有游客身份才显示栏尾「退出」
  },
  methods: {
    // 由各 tab 页 onShow 调用：this.getTabBar().setTab(索引, 是否老板模式)
    // ⭐ 2026-09-28 老板定：「退出」**只在游客身份显示** —— 正式业务员、老板都不显示（他们不解除绑定）
    setTab(selected, bossMode) {
      const app = getApp();
      const isTrial = !!(app && app.globalData && app.globalData.asTrial);
      this.setData({ tabs: bossMode ? TABS_BOSS : TABS_SALESMAN, selected, isTrial });
    },
    onTap(e) {
      const i = Number(e.currentTarget.dataset.i);
      const t = this.data.tabs[i];
      if (!t) return;
      // 「我的」页：非 tab 页（老板定：该页保持原样式），走普通跳转
      if (!t.tab) { wx.navigateTo({ url: t.path }); return; }
      if (i === this.data.selected) return;
      wx.switchTab({ url: t.path });
    },

    // ⭐ 2026-09-28 老板定：底部「退出」= 解绑 + 清本地 + 回登录页
    //    （"自动绑定"已去掉；这个按钮就是给**已经被绑过的微信号**解绑用的）
    onLogout() {
      wx.showModal({
        title: '退出登录',
        content: '回到登录页；若当前是游客身份，会同时解除绑定',
        confirmText: '退出',
        cancelText: '取消',
        success: (r) => { if (r.confirm) this._doLogout(); }
      });
    },
    async _doLogout() {
      wx.showLoading({ title: '退出中…', mask: true });
      // ① 云端解绑：**只解 trial 游客账号**，正式业务员账号绝不动
      try { await api.call('login', { action: 'unbindTrial' }); } catch (e) { /* 离线也允许退出 */ }
      // ② 清本地标记
      try {
        wx.removeStorageSync('as_trial');
        wx.removeStorageSync('dev_session');
      } catch (e) { /* 静默 */ }
      // ③ 清全局状态
      const app = getApp();
      const g = app.globalData || {};
      g.asTrial = false; g.bossMode = false; g.devAuthed = false;
      if (typeof app.clearUser === 'function') { try { app.clearUser(); } catch (e) { /* 静默 */ } }
      wx.hideLoading();
      // ④ 回登录页（reLaunch：清空页面栈，避免一返回又落回 tab 页）
      wx.reLaunch({ url: '/pages/login/login' });
    }
  }
});
