// 聚火拜访 · 小程序入口
const CLOUD_ENV = 'cloud1-d0gwlmbwp31181eb5'; // 已开通的云开发环境
const { LOGO_FILE_ID } = require('./utils/config');

App({
  globalData: {
    user: null,
    APP_VERSION: '0.9.04', // 版本号（2026-09-08 老板定：双方必须统一口径的改动才 bump；界面级改动不动）
    logoUrl: LOGO_FILE_ID || '/images/logo.png', // LOGO 优先云存储 fileID，未配置回退本地
    bossMode: false // 老板模式（2026-09-09 §7.13：管理员微信专用演示态；storage 持久）
  },
  reviewTimer: null,      // 审核观察员定时器（仅存在审核中任务时运行）
  reviewSnapshot: null,   // 上次快照 { taskId: status }
  reviewListeners: [],    // 页面注册的监听回调（状态变化时调用）

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({ env: CLOUD_ENV, traceUser: true });
    const u = wx.getStorageSync('user');
    if (u) this.globalData.user = u;
    // 老板模式持久恢复（2026-09-09 §7.13：管理员微信点「进入老板模式」后保持）
    this.globalData.bossMode = !!wx.getStorageSync('boss_mode');
    // 开发者双身份标记恢复（2026-09-09 开发者范宇琨：登录云函数确认后持久，登录页据此显示两按钮选择页）
    this.globalData.isDev = !!wx.getStorageSync('is_dev');
  },

  setUser(u) {
    this.globalData.user = u;
    wx.setStorageSync('user', u);
  },
  clearUser() {
    this.globalData.user = null;
    wx.removeStorageSync('user');
    wx.removeStorageSync('boss_mode');
    this.globalData.bossMode = false;
  },
  setBossMode(v) {
    this.globalData.bossMode = !!v;
    if (v) wx.setStorageSync('boss_mode', 1);
    else wx.removeStorageSync('boss_mode');
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
