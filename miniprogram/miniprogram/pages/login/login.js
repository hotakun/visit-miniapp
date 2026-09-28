const api = require('../../utils/api');
// 跳转约定（2026-09-10 自定义 tabBar 改造后，务必遵守）：
//   home / map / bossWar 是 tabBar 页 → 只能用 wx.switchTab（用 redirectTo/navigateTo 会静默失败）
//   login / task / customer / visit / mine / tasks-all 是非 tab 页 → 用 navigateTo / redirectTo

Page({
  // 2026-09-11 老板要求：支持转发给同事好友（标题统一、点开进首页）
  onShareAppMessage() {
    return require('../../utils/share').cfg(); // 统一出口（utils/share.js）：path 带当前登录用户 _id → 记录推荐人
  },
  data: {
    user: null, adminMode: false, canBoss: false, adminName: '', logoUrl: '',
    // 注册状态机（2026-09-09 老板拍板：注册→审核→免登；拒绝可重提）
    // 2026-09-28 老板反馈"进登录页还是会闪" · **B2 修法**：registerMode 初始值改成 true。
    //   原来三个 flag 初始全 false → 首屏命中 wx:else 显示"正在识别身份…"，等云函数（可能冷启动 1s+）回来
    //   才换成表单 → 看着就是"闪一下 / 像加载了两次"。
    //   改成"先按注册页渲染"，云端回来再按真实状态覆盖：新用户（绝大多数）本来就该看到注册页 → **完全不闪**；
    //   只有"审核中 / 被拒"的人会从注册页切过去（少数，且他们清楚自己在等什么）。
    registerMode: true, pendingMode: false, rejectedMode: false,
    name: '', phone: '', regBusy: false,
    trialId: '',   // 2026-09-27 恢复：游客体验入口（云函数 NEED_REGISTER 时下发）
    phoneVerified: false, // 2026-09-09 老板定：微信一键验证标记（getPhoneNumber 快速验证组件）
    pendingAt: '', rejectReason: '',
    // 开发者双身份选择页（2026-09-09 开发者范宇琨定：只他自己可见）
    devMode: false, devUser: null
  },
  // 2026-09-28 老板报"进登录页会闪一下" · **A 修法**：
  //   logoUrl 原来只在 onShow 里设，而 onShow 比首帧晚 → 第一帧 logo 是空的、下一帧才冒出来（闪一下）。
  //   onLoad 早于首帧，所以挪到这儿先填一次。
  onLoad() {
    this.setData({ logoUrl: getApp().globalData.logoUrl });
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
        // 2026-09-09 开发者范宇琨双身份 → 2026-09-28 三身份（加「游客」）
        // 2026-09-28：同时接收云端下发的 trialId，供「以游客身份进入」按钮使用
        this.setData({ devMode: true, devUser: res.user || null, trialId: res.trialId || this.data.trialId || '' });
      } else if (res.ok && res.boss && res.user) {
        // 2026-09-10 老板定：老板/管理员一律直接进老板模式，跳过登录页
        getApp().setUser(res.user);
        getApp().setBossMode(true);
        getApp().globalData.welcome = res.welcome || null; // 2026-09-10：欢迎仪式配置随登录下发
        wx.switchTab({ url: '/pages/home/home' });
      } else if (res.ok && res.user && res.user.role === 'salesman') {
        getApp().setUser(res.user);
        // 2026-09-28 老板定：把"当前是不是 trial 账号"落到全局 —— 底部栏据此决定要不要显示「退出」
        //   （老绑定进来的游客 res.trial=true → 也能看到「退出」并解绑；正式业务员 false → 不显示）
        getApp().globalData.asTrial = !!res.trial;
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
        // 2026-09-27 老板定：恢复「游客体验入口」→ 取 trialId（兼容旧云端：从 salesmen 里找 trial）
        // 未注册微信一律进注册表单，随时可自己注册
        let trialId = res.trialId || '';
        if (!trialId && Array.isArray(res.salesmen)) {
          const tr = res.salesmen.find(s => s.trial);
          trialId = tr ? tr._id : '';
        }
        this.setData({ registerMode: true, trialId });
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
        // 2026-09-28 老板定：文案里不带 ✓（success 图标本身就是大勾，重复）
        api.toast('验证成功', 'success');
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
      // 推荐人（2026-09-24）：分享链接带进来的 users._id（app.js 的 captureRef 已存好；没有就是空串）
      const ref = String(getApp().globalData.refFrom || '');
      const res = await api.call('login', { action: 'register', name, phone, phoneVerified: !!this.data.phoneVerified, ref });
      if (res.ok && res.boss) {
        // 2026-09-09 老板定：老板手机号注册免审核直接通过 → 自动进老板模式
        getApp().setUser(res.user);
        getApp().setBossMode(true);
        getApp().globalData.welcome = res.welcome || null; // 2026-09-10：欢迎仪式配置随注册下发
        this.clearRef(); // 2026-09-24：推荐人已用掉
        // 2026-09-28 老板定：文案里不带 ✓（success 图标本身就是大勾，重复）
        api.toast('老板身份已激活', 'success');
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 800);
      } else if (res.ok) {
        this.setData({ registerMode: false, pendingMode: true });
        const d = new Date(Date.now() + 8 * 3600 * 1000);
        const p = n => String(n).padStart(2, '0');
        this.setData({ pendingAt: `${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` });
        this.clearRef(); // 2026-09-24：推荐人已写进待审核申请
        api.toast('申请已提交，等待管理员审核');
      } else if (res.code === 'PENDING') {
        this.setData({ registerMode: false, pendingMode: true });
        this.clearRef();
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
  // ⭐ 2026-09-28 老板定：注册页「取消申请」= 放弃本次注册
  //   ① 撤回云端的**待审核申请**（若有）② 清掉已填 / 已验证的手机号（前端）③ 清本地标记 ④ 重进登录页
  //   ⚠️ 微信那层"手机号授权"小程序**无权撤销**（微信不提供 API）——用户若想彻底解绑，得去
  //      微信 →「我」→ 设置 → 隐私 → 授权管理 里删掉本小程序；这里只清我们自己的记录。
  cancelReg() {
    wx.showModal({
      title: '取消申请',
      content: '将放弃本次注册：已填写的手机号和验证状态都会清除，已提交的申请也会撤回。',
      confirmText: '放弃',
      cancelText: '再想想',
      success: (r) => { if (r.confirm) this._doCancelReg(); }
    });
  },
  async _doCancelReg() {
    wx.showLoading({ title: '正在取消…', mask: true });
    // ① 云端：撤回待审核申请（只删 pending，不碰"已通过 / 已拒绝"）
    try { await api.call('login', { action: 'cancelReg' }); } catch (e) { /* 离线也允许取消 */ }
    // ② 清前端：姓名、手机号、验证标记
    this.setData({ name: '', phone: '', phoneVerified: false, regBusy: false });
    // ③ 清本地标记
    try {
      wx.removeStorageSync('as_trial');
      wx.removeStorageSync('dev_session');
      wx.removeStorageSync('ref_from');
      wx.removeStorageSync('is_dev');
    } catch (e) { /* 静默 */ }
    // ④ 清全局状态
    const app = getApp();
    const g = app.globalData || {};
    g.asTrial = false; g.bossMode = false; g.devAuthed = false; g.refFrom = '';
    if (typeof app.clearUser === 'function') { try { app.clearUser(); } catch (e) { /* 静默 */ } }
    wx.hideLoading();
    // ⑤ 退出 → 重进登录页（页面栈清干净，回到最初状态）
    wx.reLaunch({ url: '/pages/login/login' });
  },
  // 推荐人已用掉 → 清本地记录（2026-09-24）。失败时不调它，保留 ref 供重试
  clearRef() {
    try {
      getApp().globalData.refFrom = '';
      wx.removeStorageSync('ref_from');
    } catch (e) { /* 静默 */ }
  },
  // 被拒绝 → 重新申请（2026-09-09 老板拍板：可重提，旧记录留痕）
  reapply() {
    this.setData({ rejectedMode: false, registerMode: true, name: '', phone: '', phoneVerified: false });
  },
  // 2026-09-28 老板定：开发者三身份的第三个 —— 「以游客身份进入」（体验与真实游客完全一致：能看、不能提交）
  // ⚠️ 依赖 this.data.trialId（云端在 dev 登录时一并下发；后台必须已建一个 trial 游客账号）
  // ⚠️ 2026-09-28 老板定：**入口只读、不再绑定**（原来传 bindUserId 会把当前微信自动绑死，属违规，已去掉）
  async enterAsGuest() {
    if (!this.data.trialId) {
      api.toast('还没有游客账号：后台「人员管理」新增业务员时勾上"游客(试用)"即可');
      return;
    }
    try {
      const res = await api.call('login', { asTrialVisit: true, trialId: this.data.trialId });
      if (res.ok) {
        getApp().setUser(res.user);
        // 2026-09-28 老板定：文案里**不再带 ✓** —— success 图标本身就是个大勾，右边再跟一个 ✓ 是重复
        api.toast('已进入游客身份', 'success'); const _a = getApp(); _a.globalData.asTrial = true; _a.globalData.trialId = this.data.trialId; _a.setBossMode(false); _a.globalData.devAuthed = true; try { wx.setStorageSync('as_trial', 1); wx.setStorageSync('trial_id', this.data.trialId); wx.setStorageSync('dev_session', 1); } catch (e2) { /* 静默 */ }
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 700);
      } else {
        api.toast(res.msg || '进入失败');
      }
    } catch (err) {
      api.toast('进入失败，请重试');
    }
  },
  // 游客体验入口（2026-09-27 老板定：恢复；审核/演示用）
  // ⚠️ 2026-09-28 老板定：**只读不绑定** —— 原来是"一键绑实习账号"，会把当前微信**自动绑定**、
  //    而且绑定后再也回不到注册页（老板判为违规）。现在改成"只看不绑"：云端不写库，本地只留
  //    as_trial 标记，退出游客即失效 —— 微信始终未被绑定，随时能正常注册。
  async enterTrial() {
    if (!this.data.trialId) { api.toast('游客入口暂不可用'); return; }
    try {
      const res = await api.call('login', { asTrialVisit: true, trialId: this.data.trialId });
      if (res.ok) {
        getApp().setUser(res.user);
        // 2026-09-28 老板定：文案里**不再带 ✓**（success 图标已是大勾）—— 这是老板实际点的那条路径
        api.toast('已进入游客身份', 'success'); const _a = getApp(); _a.globalData.asTrial = true; _a.globalData.trialId = this.data.trialId; _a.setBossMode(false); _a.globalData.devAuthed = true; try { wx.setStorageSync('as_trial', 1); wx.setStorageSync('trial_id', this.data.trialId); wx.setStorageSync('dev_session', 1); } catch (e2) { /* 静默 */ }
        setTimeout(() => wx.switchTab({ url: '/pages/home/home' }), 600);
      } else {
        api.toast(res.msg || '进入失败');
        this.check();
      }
    } catch (err) {
      api.toast('进入失败，请重试');
    }
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
