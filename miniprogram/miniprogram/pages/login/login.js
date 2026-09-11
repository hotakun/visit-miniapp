const api = require('../../utils/api');
// 跳转约定（2026-09-10 自定义 tabBar 改造后，务必遵守）：
//   home / map / bossWar 是 tabBar 页 → 只能用 wx.switchTab（用 redirectTo/navigateTo 会静默失败）
//   login / task / customer / visit / mine / tasks-all 是非 tab 页 → 用 navigateTo / redirectTo

Page({
  // 2026-09-11 老板要求：支持转发给同事好友（标题统一、点开进首页）
  onShareAppMessage() {
    return {
      title: '聚火拜访 · 业务员拜访管理',
      path: '/pages/home/home',
      imageUrl: '/images/share.png'   // 分享封面（5:4，由 logo 生成）
    };
  },
  data: {
    user: null, adminMode: false, canBoss: false, adminName: '', logoUrl: '',
    // 注册状态机（2026-09-09 老板拍板：注册→审核→免登；拒绝可重提）
    registerMode: false, pendingMode: false, rejectedMode: false,
    name: '', phone: '', regBusy: false,
    phoneVerified: false, // 2026-09-09 老板定：微信一键验证标记（getPhoneNumber 快速验证组件）
    pendingAt: '', rejectReason: '',
    // 开发者双身份选择页（2026-09-09 开发者范宇琨定：只他自己可见）
    devMode: false, devUser: null
  },
  onShow() {
    const app = getApp();
    this.setData({ logoUrl: app.globalData.logoUrl });
    // 2026-09-09 开发者范宇琨双身份：dev 永远走选择页（不自动进业务员首页）
    if (app.globalData.isDev) { this.check(); return; }
    if (app.globalData.user && app.globalData.user.role === 'salesman') {
      wx.switchTab({ url: '/pages/home/home' });
      return;
    }
    this.check();
  },
  async check() {
    try {
      const res = await api.call('login');
      if (res.ok && res.dev) {
        // 2026-09-09 开发者范宇琨双身份：显示「业务员/老板」两按钮选择页；持久化 dev 标记
        try { wx.setStorageSync('is_dev', 1); } catch (e) { /* 静默 */ }
        getApp().globalData.isDev = true;
        this.setData({ devMode: true, devUser: res.user || null });
      } else if (res.ok && res.boss && res.user) {
        // 2026-09-10 老板定：老板/管理员一律直接进老板模式，跳过登录页
        getApp().setUser(res.user);
        getApp().setBossMode(true);
        getApp().globalData.welcome = res.welcome || null; // 2026-09-10：欢迎仪式配置随登录下发
        wx.switchTab({ url: '/pages/home/home' });
      } else if (res.ok && res.user && res.user.role === 'salesman') {
        getApp().setUser(res.user);
        wx.switchTab({ url: '/pages/home/home' });
      } else if (res.ok) {
        // 兜底（仅旧版 login 云函数会走到）：业务员小程序内的管理员提示
        this.setData({ adminMode: true, adminName: (res.user || {}).name || '管理员', canBoss: !!res.canBoss });
      } else if (res.code === 'PENDING') {
        const d = new Date(Number(res.createdAt || Date.now()) + 8 * 3600 * 1000);
        const p = n => String(n).padStart(2, '0');
        this.setData({ pendingMode: true, pendingAt: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` });
      } else if (res.code === 'REJECTED') {
        this.setData({ rejectedMode: true, rejectReason: res.reason || '' });
      } else if (res.code === 'NEED_REGISTER' || res.code === 'NEED_BIND') {
        // 2026-09-10 老板定：实习角色永远不能绑定——不再取 trialId（游客入口已移除），
        // 未注册微信一律进注册表单，随时可自己注册
        this.setData({ registerMode: true });
      } else {
        api.toast(res.msg || '登录失败');
      }
    } catch (e) {
      api.toast('云函数调用失败，请确认已部署 login');
    }
  },
  refresh() {
    getApp().clearUser();
    this.setData({ adminMode: false, pendingMode: false, rejectedMode: false, registerMode: false });
    this.check();
  },
  // 注册表单（2026-09-09 老板拍板）
  onName(e) { this.setData({ name: e.detail.value }); },
  onPhone(e) {
    // 手输手机号覆盖验证结果 → 清除已验证标记（2026-09-09 老板定）
    this.setData({ phone: e.detail.value, phoneVerified: false });
  },
  // 微信一键验证手机号（2026-09-09 老板定：getPhoneNumber 快速验证组件，微信代发验证码短信）
  async onGetPhone(e) {
    const code = e.detail && e.detail.code;
    if (!code) { api.toast('未授权验证，可手动输入手机号'); return; }
    api.toast('正在验证…');
    try {
      const res = await api.call('login', { action: 'verifyPhone', code });
      if (res.ok && res.phone) {
        this.setData({ phone: res.phone, phoneVerified: true });
        api.toast('验证成功 ✓', 'success');
      } else {
        api.toast(res.msg || '验证失败，请手动输入手机号');
      }
    } catch (err) {
      api.toast('验证失败，请手动输入手机号');
    }
  },
  async submitReg() {
    if (this.data.regBusy) return; // 2026-09-09 核验加固：防连点并发提交产生重复申请
    const name = (this.data.name || '').trim();
    const phone = (this.data.phone || '').trim();
    if (!name) { api.toast('请填写姓名'); return; }
    if (!/^1\d{10}$/.test(phone)) { api.toast('请填写正确的 11 位手机号'); return; }
    this.setData({ regBusy: true });
    try {
      const res = await api.call('login', { action: 'register', name, phone, phoneVerified: !!this.data.phoneVerified });
      if (res.ok && res.boss) {
        // 2026-09-09 老板定：老板手机号注册免审核直接通过 → 自动进老板模式
        getApp().setUser(res.user);
        getApp().setBossMode(true);
        getApp().globalData.welcome = res.welcome || null; // 2026-09-10：欢迎仪式配置随注册下发
        api.toast('老板身份已激活 ✓', 'success');
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 800);
      } else if (res.ok) {
        this.setData({ registerMode: false, pendingMode: true });
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        const p = n => String(n).padStart(2, '0');
        this.setData({ pendingAt: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` });
        api.toast('申请已提交，等待管理员审核');
      } else if (res.code === 'PENDING') {
        this.setData({ registerMode: false, pendingMode: true });
        api.toast(res.msg || '申请已提交');
      } else {
        api.toast(res.msg || '提交失败');
      }
    } catch (err) {
      api.toast('提交失败，请重试');
    } finally {
      this.setData({ regBusy: false });
    }
  },
  // 被拒绝 → 重新申请（2026-09-09 老板拍板：可重提，旧记录留痕）
  reapply() {
    this.setData({ rejectedMode: false, registerMode: true, name: '', phone: '', phoneVerified: false });
  },
  // 老板模式（2026-09-09 §7.13）：boss 白名单管理员入口——全量只读+虚拟写，storage 持久
  enterBoss() {
    const app = getApp();
    // 2026-09-10：手动进老板模式时拉取欢迎仪式配置（异步，home 页播放前等待兜底）
    if (!app.globalData.welcome) {
      app.globalData.welcomePending = true;
      api.call('login', { action: 'welcomeCfg' })
        .then(r => { if (r && r.ok && r.welcome) app.globalData.welcome = r.welcome; })
        .catch(() => { /* 失败用默认 */ })
        .then(() => { app.globalData.welcomePending = false; });
    }
    app.setBossMode(true);
    wx.switchTab({ url: '/pages/home/home' });
  },
  // 开发者双身份入口（2026-09-09 开发者范宇琨定：只有他的微信可见此页）
  enterAsSalesman() {
    const u = this.data.devUser;
    if (!u) { this.check(); return; }
    const app = getApp();
    app.setBossMode(false);
    app.setUser(u);
    app.globalData.devAuthed = true; // 会话级放行：本次运行期 TAB 来回切换不弹回登录页
    try { wx.setStorageSync('dev_session', 1); } catch (e) { /* 静默 */ }
    wx.switchTab({ url: '/pages/home/home' });
  },
  enterAsBoss() {
    const u = this.data.devUser;
    if (!u) { this.check(); return; }
    const app = getApp();
    // 2026-09-10：进老板模式拉取欢迎仪式配置（异步，home 页播放前等待兜底）
    if (!app.globalData.welcome) {
      app.globalData.welcomePending = true;
      api.call('login', { action: 'welcomeCfg' })
        .then(r => { if (r && r.ok && r.welcome) app.globalData.welcome = r.welcome; })
        .catch(() => { /* 失败用默认 */ })
        .then(() => { app.globalData.welcomePending = false; });
    }
    app.setUser(u);
    app.setBossMode(true);
    app.globalData.devAuthed = true; // 会话级放行：本次运行期 TAB 来回切换不弹回登录页
    try { wx.setStorageSync('dev_session', 1); } catch (e) { /* 静默 */ }
    wx.switchTab({ url: '/pages/home/home' });
  },
  // LOGO 云端加载失败 → 回退本地图，避免白板
  onLogoError() {
    if (this.data.logoUrl !== '/images/logo.png') {
      this.setData({ logoUrl: '/images/logo.png' });
    }
  }
});
