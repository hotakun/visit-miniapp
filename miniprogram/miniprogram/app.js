// 聚火拜访 · 小程序入口
const CLOUD_ENV = 'cloud1-d0gwlmbwp31181eb5'; // 已开通的云开发环境
const { LOGO_FILE_ID } = require('./utils/config');

App({
  globalData: {
    user: null,
    APP_VERSION: '0.9.20', // 版本号（2026-10-07：与后台 admin.html 一致；后台本轮含任务卡可滚动 + 导入支持 csv + 照片可传可删 + 战况监控三层筛选/版式）
    logoUrl: LOGO_FILE_ID || '/images/logo.png', // LOGO 优先云存储 fileID，未配置回退本地
    bossMode: false, // 老板模式（2026-09-09 §7.13：管理员微信专用演示态；storage 持久）
    // ⭐ 2026-09-30 老板兼业务员（朱小利）：声明「这次以业务员身份用」→ 所有云函数请求自动带 asSalesman，
    //   云端据此把 isBoss 降为 false（看自己的任务、拜访真落库、进统计）。与 bossMode 互斥、storage 持久。
    asSalesman: false,
    welcome: null, // 老板欢迎仪式配置（2026-09-10：login 云函数下发，缺失用默认 每天第一次/3秒/金色）
    welcomePending: false, // 欢迎仪式配置请求在途（home 页播放前短暂等待，超时用默认）
    refFrom: '' // 推荐人（2026-09-24）：从分享链接 ?ref=<分享者 users._id> 带进来，注册时随申请提交
  },
  reviewTimer: null,      // 审核观察员定时器（仅存在审核中任务时运行）
  reviewSnapshot: null,   // 上次快照 { taskId: status }
  reviewListeners: [],    // 页面注册的监听回调（状态变化时调用）

  onLaunch(options) {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    const u = wx.getStorageSync('user');
    if (u) this.globalData.user = u;
    // 老板模式持久恢复（2026-09-09 §7.13：管理员微信点「进入老板模式」后保持）
    this.globalData.bossMode = !!wx.getStorageSync('boss_mode');
    // ⭐ 2026-09-30 老板兼业务员（朱小利）：业务员身份标记同样持久（重开小程序仍是业务员视角）
    this.globalData.asSalesman = !!wx.getStorageSync('as_salesman');
    // 开发者双身份标记恢复（2026-09-09 开发者范宇琨：登录云函数确认后持久，登录页据此显示两按钮选择页）
    this.globalData.isDev = !!wx.getStorageSync('is_dev');
    // devAuthed：会话级放行标志（2026-09-09 修复：选过身份后本次运行期内 TAB 来回切换不再被弹回登录页；
    // 冷启动不恢复=每次重开小程序仍走选择页）
    this.globalData.devAuthed = false;
    // 推荐人：接分享链接带进来的 ref（2026-09-24）
    this.captureRef(options);
  },

  // 冷启动走 onLaunch、**热启动走 onShow** —— 两处都要接（否则"小程序已在后台、再点分享卡片进来"收不到 ref）
  onShow(options) {
    this.captureRef(options);
  },

  // ===== 推荐人（2026-09-24 老板定：谁分享的链接拉来的人，就记谁为推荐人）=====
  // 来源：9 个页面的 onShareAppMessage 统一生成 /pages/login/login?ref=<分享者 users._id>
  // 处理：① 本次带 ref → 记下并**持久化**（防"点链接进来但当时没注册，之后再打开就丢了"）
  //       ② 本次没带 ref 且内存里也没有 → 从 storage 恢复（若之前带过）
  // 清除：注册**成功提交**后由登录页清（见 pages/login/login.js），此后不再影响
  captureRef(options) {
    let ref = '';
    try { ref = String(((options || {}).query || {}).ref || '').trim(); } catch (e) { ref = ''; }
    if (ref) {
      this.globalData.refFrom = ref;
      try { wx.setStorageSync('ref_from', ref); } catch (e) { /* 静默 */ }
      return;
    }
    if (!this.globalData.refFrom) {
      try { this.globalData.refFrom = wx.getStorageSync('ref_from') || ''; } catch (e) { this.globalData.refFrom = ''; }
    }
  },

  setUser(u) {
    this.globalData.user = u;
    wx.setStorageSync('user', u);
  },
  clearUser() {
    this.globalData.user = null;
    wx.removeStorageSync('user');
    wx.removeStorageSync('boss_mode');
    wx.removeStorageSync('as_trial'); // 2026-09-28：退出身份时一并清「实习态」标记（pages/login 的以游客身份进入）
    wx.removeStorageSync('as_salesman'); // ⭐ 2026-09-30：一并清「老板兼业务员的业务员身份」标记
    this.globalData.bossMode = false;
    this.globalData.asTrial = false;
    this.globalData.asSalesman = false; // ⭐ 2026-09-30
    this.globalData.devAuthed = false; // 2026-09-09 修复：退出身份后放行标志一并重置
    // 2026-09-10：退出身份清欢迎仪式配置缓存（下次进老板模式必重新拉云端配置）
    this.globalData.welcome = null;
    this.globalData.welcomePending = false;
  },
  setBossMode(v) {
    this.globalData.bossMode = !!v;
    if (v) wx.setStorageSync('boss_mode', 1);
    else wx.removeStorageSync('boss_mode');
  },
  // ⭐ 2026-09-30 老板兼业务员（朱小利）：「以业务员身份进入」标记（与 bossMode 互斥；登录页选身份时设置）
  //   置位后 utils/api.js 会给每个云函数请求带 asSalesman，云端据此把 isBoss 降为 false
  setAsSalesman(v) {
    this.globalData.asSalesman = !!v;
    if (v) wx.setStorageSync('as_salesman', 1);
    else wx.removeStorageSync('as_salesman');
  },

  // ===== 审核观察员：有审核中任务才 15 秒轮询等待审批结果；无则停止（维持现状） =====
  registerReviewListener(fn) {
    if (typeof fn === 'function' && !this.reviewListeners.includes(fn)) this.reviewListeners.push(fn);
  },
  unregisterReviewListener(fn) {
    this.reviewListeners = this.reviewListeners.filter(f => f !== fn);
  },
  startReviewWatcher() {
    if (this.reviewTimer) return;
    // 2026-09-11 降频：审核观察员轮询开关（后台设置页可关；关闭后不再轮询，省调用）
    const cfg = (this.globalData && this.globalData.sysCfg) || {};
    if (cfg.reviewWatchEnabled === false) return;
    this.reviewTick();
    this.reviewTimer = setInterval(() => this.reviewTick(), 15000);
  },
  async reviewTick() {
    try {
      const res = await wx.cloud.callFunction({ name: 'tasks', data: { action: 'reviewStatus' } });
      const list = (res.result && res.result.list) || [];
      if (!list.length) {
        // 没有任何审核中任务：停止轮询，维持现状
        this.stopReviewWatcher();
        this.reviewSnapshot = null;
        this.notifyReviewChange([]);
        return;
      }
      const snap = {};
      list.forEach(x => { snap[x._id] = x.status; });
      const changed = !this.reviewSnapshot || JSON.stringify(this.reviewSnapshot) !== JSON.stringify(snap);
      this.reviewSnapshot = snap;
      if (changed) this.notifyReviewChange(list);
    } catch (e) { /* 静默，下一轮再试 */ }
  },
  notifyReviewChange(list) {
    this.reviewListeners.forEach(fn => {
      try { fn(list); } catch (e) { /* 单个页面异常不影响其他 */ }
    });
  },
  stopReviewWatcher() {
    if (this.reviewTimer) { clearInterval(this.reviewTimer); this.reviewTimer = null; }
  }
});
