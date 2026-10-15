const api = require('../../utils/api');
const loc = require('../../utils/loc');
// ⭐ 2026-10-16：天数卡每张的**横向占位**（卡宽 64 + 右距 6）——
//   只用于"刚进页面时把那一排滚到当前页"：偏移 = (第几页 − 1) × 这个值。
//   ⚠️ 改 task.wxss 里 `.day` 的 `width` / `margin-right` 时，**这里要同步改**（否则滚偏）。
const DAY_CARD_W = 70;

Page({
  // 2026-09-11 老板要求：支持转发给同事好友（标题统一、点开进首页）
  onShareAppMessage() {
    return require('../../utils/share').cfg(); // 统一出口（utils/share.js）：path 带当前登录用户 _id → 记录推荐人
  },
  data: {
    task: null, customers: [], showCustomers: [], activeDay: 1, loading: true, dayScrollLeft: 0,
    dayDone: {}, dayVisited: {}, ongoingDays: {}, nextSeq: 0, allDone: false, confirmShow: false, confirmMsg: ''
  },
  onLoad(options) {
    this.taskId = options.taskId;
    this._loaded = false;
    this.distMap = {};
    // ⭐⭐ 2026-10-16 老板定：**刚进页面时，把天数卡那一排自动滚到"当前高亮那张"** ——
    //   背景：天数卡是横向滚动的，业务员干到第 6、7 页时，高亮那张跑到屏幕右边外面 → 看不到自己在第几页。
    //   ⚠️ 老板定的口径：**只在刚进页面这一刻滚一次**（手动点卡 / 从拜访页返回时不滚，
    //      免得把用户自己滑到的位置拉回去）。
    //   ⚠️ 用实例标记、而不是直接设值：渲染有两条路（骨架缓存先到 / 云端后到），两次都会渲染，
    //      标记在"云端数据到位（_afterDetail）"时才清 —— 这样两条路都能滚到正确的那张。
    this._needDayScroll = true;
  },
  // ⭐⭐ 2026-10-10 老板定：**任务心跳回调**（`app.js` 每 15 秒问一次，变了才叫到这里）
  //   任务详情页比首页更需要"说一声"：**后台把任务结束了**、或改了截止日 —— 业务员正看着这一页呢。
  //   ⚠️ 只轻提示一句 + 刷新，**不弹窗打断**（他可能正在填东西）。
  onTaskVerChanged() {
    try { wx.showToast({ title: '任务有更新', icon: 'none', duration: 1500 }); } catch (e) { /* 静默 */ }
    try { this.load(); } catch (e) { /* 静默：刷新失败不能让页面崩 */ }
  },

  onShow() {
    const app = getApp();
    if (!this._revFn) {
      // 注册审核观察员：当前任务审核结果变化 → 自动刷新并提示
      this._revFn = (list) => this.onReviewChange(list);
      app.registerReviewListener(this._revFn);
    }
    this._shown = true;
    // 首次进入完整加载；从拜访页返回时静默刷新（打勾/状态即时更新）
    if (!this._loaded) {
      this._loaded = true;
      this.load();
    } else {
      this.lightRefresh();
      this.tryLocate();     // 回页面立即刷一次（人可能已移动）
      this.startLocTimer(); // 重启定时器
    }
  },
  onHide() {
    this._shown = false;
    this.stopLocTimer(); // 切后台停止刷新
    if (this._revFn) { getApp().unregisterReviewListener(this._revFn); this._revFn = null; }
  },
  onUnload() {
    this.stopLocTimer(); // 离页停止
    if (this._revFn) { getApp().unregisterReviewListener(this._revFn); this._revFn = null; }
  },
  // 审核观察员回调：当前任务从"审核中"消失 = 结果已出 → 刷新详情 + toast
  onReviewChange(list) {
    const ids = list.map(x => x._id);
    const prev = this._reviewIds || [];
    this._reviewIds = ids;
    const cur = this.taskId;
    if (!prev.length) {
      // 首次同步快照：若当前任务在审核中，确保观察员在运行
      if (ids.includes(cur)) getApp().startReviewWatcher();
      return;
    }
    if (prev.includes(cur) && !ids.includes(cur)) {
      this.checkReviewResult();
    }
  },
  async checkReviewResult() {
    try {
      const res = await api.call('tasks', { action: 'detail', taskId: this.taskId });
      if (!res.ok) return;
      const st = res.task.status;
      if (st === 'done') api.toast('审核已通过，任务已完成', 'success'); // 2026-09-28 老板定：文案不带 ✓（success 图标已是勾）
      else if (st === 'published') api.toast('审核未通过，任务继续执行', 'none');
      if (this._shown) this.load();
    } catch (e) { /* 静默，下次刷新再试 */ }
  },
  async lightRefresh() {
    try {
      // ⭐⭐ 2026-10-15 老板定：「进任务只拉取卡片上显示的状态就行」——**不再调完整 `detail`**
      //   （完整 `detail` 会读"任务里每家客户的整篇文档"+翻该任务全部历史拜访；这里只要状态那一小块）。
      const res = await api.call('tasks', { action: 'taskCardStatus', taskId: this.taskId });
      if (!res.ok) return;
      const st = res.states || {};
      // 把状态**贴到现有列表上**（name / address 这些静态字段一个字不动）
      const customers = (this.allCustomers || []).map(c => (st[c._id] ? Object.assign({}, c, st[c._id]) : c));
      this.allCustomers = customers;
      this.setData({ customers });
      this.refreshShow();
    } catch (e) { /* 静默：下一轮进入再刷 */ }
  },
  // ⭐ 2026-10-15：把「拿到的数据 → 渲染」抽出来，**云端数据与本地骨架共用**（老板定「进任务先用缓存」）。
  //   `opts.keepDay=true` 时**不重算当前页签** —— 从拜访页返回的刷新不该把用户切到的天重置。
  _renderDetail(res, opts) {
    const keepDay = !!(opts && opts.keepDay);
    const customers = (res.customers || []).map(c => ({ ...c, typeName: c.customerType === 'new' ? 'new' : 'mall' }));
    // 天页签带月日：第 N 天日期 = 开始日期 + N-1（老任务用创建日推算；都缺失则不显示日期）
    const fmtMD = s => {
      const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
      return m ? `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日` : '';
    };
    const addDays = (s, n) => {
      const d = new Date(s + 'T00:00:00');
      d.setDate(d.getDate() + n);
      const p = x => String(x).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };
    const baseDate = res.task.startDate || (res.task.createdAt ? new Date(res.task.createdAt + 8 * 3600 * 1000).toISOString().slice(0, 10) : '');
    const rawPlan = res.task.dayPlan && res.task.dayPlan.length ? res.task.dayPlan : [{ day: 1, customerIds: customers.map(c => c._id) }];
    const dayPlan = rawPlan.map(p => ({ ...p, dateLabel: baseDate ? fmtMD(addDays(baseDate, p.day - 1)) : '' }));
    // ⭐⭐ 2026-10-16 老板定（原话）：「进入任务详情卡片时候，请按已拜访客户**所在**的最大天数卡默认显示。」
    //   追问确认两点：① 按「**客户所在的天数卡**」算（不是"哪天拜访的"）；② 口径与**页面卡片上那个 ✓**一致。
    //   ⚠️ 旧算法是"按日历推"：拿 `lastVisit.visitedAt` 减任务开始日算"第几天"——
    //      **跨天补跑**时就会停错页。例：第 1 天没跑完、第 2 天回来把第 1 天剩下的跑完
    //      → 旧算法算出"第 2 天"、进来跳到第 2 页，**可他其实还在第 1 页的名单里跑**。
    //   ✅ 现在：**从 dayPlan 反查"这个客户属于第几天"**，再取"已拜访客户"里这个值的最大者。
    //   ⚠️ 口径：`c.lastVisit`（有拜访记录，含"无需拜访 / 休息中"）—— 与下面 `refreshShow()` 里
    //      算「N 家 ✓ / x/y 家」用的 `map[id].visitedToday` 同源，两处天然一致。
    const dayOfCust = {};                       // 客户id → 所属天数卡（若出现在多天里，取【最小】那天）
    dayPlan.forEach(p => {
      (p.customerIds || []).forEach(id => {
        const k = String(id);
        if (dayOfCust[k] === undefined || p.day < dayOfCust[k]) dayOfCust[k] = p.day;
      });
    });
    let maxVisitedDay = 0;
    customers.forEach(c => {
      const at = c.lastVisit && c.lastVisit.visitedAt;
      if (!at) return;                          // 没拜访过的不算（与卡片 ✓ 同口径）
      const d = dayOfCust[String(c._id)];
      if (d && d > maxVisitedDay) maxVisitedDay = d;
    });
    let activeDay = this.data.activeDay;
    if (!keepDay) {
      const td = Number(res.task.todayDay);
      if (maxVisitedDay > 0) {
        // ⚠️ 夹在计划范围内：万一记录落在计划之外（延期/加天）也不会选中一个不存在的页签
        const cands = dayPlan.filter(p => p.day <= maxVisitedDay).map(p => p.day);
        activeDay = cands.length ? Math.max.apply(null, cands) : dayPlan[0].day;
      } else if (td >= 1 && td <= dayPlan.length) {
        activeDay = td;
      } else if (td < 1) {
        activeDay = dayPlan.length ? dayPlan[0].day : 1;
      } else {
        activeDay = dayPlan[dayPlan.length - 1].day;
      }
    }
    this.allCustomers = customers;
    const patch = {
      task: { ...res.task, dayPlan, deadline: fmtMD(res.task.deadline) || res.task.deadline || '' },
      customers, activeDay, loading: false
    };
    // ⭐ 2026-10-16：刚进页面时，让天数卡那一排滚到"当前高亮那张"（老板定的「自动显示在画面之内」）。
    //   ⚠️ **不用 `scroll-into-view`** —— 它对"只露一半"的卡**不保证滚**
    //      （老板实测：有的手机第 5 张只露一半，就未必会滚）。
    //   ✅ 改成**精确算偏移**：目标卡左边缘 = (第几页 − 1) × DAY_CARD_W
    //      （每张 = 卡宽 64px + 右距 6px = 70px；卡宽在 wxss 里是**固定值**，所以算得准）→
    //      无论它原来露 1% 还是 99%，都会**整张滚进来、贴左**。
    //   ⚠️ `scroll-left` 也只在值变化时才动 → 值相同就不设（省一次无用的 setData）。
    if (this._needDayScroll) {
      const left = Math.max(0, (Number(activeDay) - 1) * DAY_CARD_W);
      if (this.data.dayScrollLeft !== left) patch.dayScrollLeft = left;
    }
    this.setData(patch);
  },
  // 只有"云端数据"才做的侧效应（配置同步 / 审核观察员 / 定位）—— 缓存渲染不碰这些
  _afterDetail(res) {
    // ⭐ 2026-10-16：云端数据到位 = 这次「进页面」的渲染结束 → 关掉"滚天数卡"的标记
    //   （之后的心跳 / 审核刷新再渲染就不会去滚了 —— 符合老板定的"只在刚进页面滚一次"）
    this._needDayScroll = false;
    // 时间分层配置同步全局（loc.js 采集器依赖）
    const app = getApp();
    if (app) {
      app.globalData.locCfg = {
        workStartHour: res.task.workStartHour, workEndHour: res.task.workEndHour, offDutyTier: res.task.offDutyTier,
        locTrackEnabled: res.task.locTrackEnabled, locLatestEnabled: res.task.locLatestEnabled,
        locWorkTier: res.task.locWorkTier, locMoveThreshold: res.task.locMoveThreshold
      };
      app.globalData.sysCfg = res.task;
    }
    // 任务在审核中：启动全局审核观察员，15 秒被动等待审批结果
    if (res.task.status === 'reviewing') getApp().startReviewWatcher();
    this.refreshShow();
    this.tryLocate();
    this.startLocTimer();
  },
  // ⭐⭐ 2026-10-16 老板定：**补「下拉刷新」**（他在新店页看到"刷新 / 下拉"很有用，问能不能推广到别处）。
  //   口径与新店页一致：**平时用缓存 / 静默更新；下拉 = 主动要最新**。
  //   ⚠️ 任务详情本来就是"先渲染骨架缓存 → 再拉云端覆盖"，所以**再调一次 `load()` 就等于是刷新**
  //      （云端那趟会把最新数据盖上去）。
  //   ⚠️ "刚进页面自动滚到当前天数卡"那个标记只在 `onLoad` 里设，所以下拉刷新**不会**把天数卡乱滚。
  async onPullDownRefresh() {
    try { await this.load(); } catch (e) { /* 静默：刷新失败保留原样，不打断 */ }
    wx.stopPullDownRefresh();
  },
  async load() {
    // ⭐ 2026-10-15 老板定「进任务先用缓存」：**有本地骨架就先渲染（秒开）**，云端回来再覆盖上面那层。
    try {
      const sk = require('../../utils/detailCache').get('taskSkeleton', this.taskId);
      if (sk && sk.task && sk.customers && sk.customers.length) this._renderDetail(sk);
    } catch (e) { /* 静默：没有缓存就走云端 */ }
    try {
      const res = await api.call('tasks', { action: 'detail', taskId: this.taskId });
      if (!res.ok) { api.toast(res.msg || '任务加载失败'); wx.navigateBack(); return; }
      this._renderDetail(res);
      // ⭐ 2026-10-15：**把骨架存本地**（老板定「客户没被业务员改过的信息，每天拉一次就够」）。
      //   ⚠️ 存原始 res.customers（不带 typeName），跨天自动失效。
      try { require('../../utils/detailCache').set('taskSkeleton', this.taskId, { task: res.task, customers: res.customers }); } catch (e) { /* 静默 */ }
      this._afterDetail(res);
    } catch (e) {
      api.toast('加载失败，请检查云函数部署');
      this.setData({ loading: false });
    }
  },
  // 静默定位（§7.9 A）：成功则计算各客户直线距离，指纹对比只更新有变化的卡片数字；失败完全静默保留旧值
  tryLocate() {
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      success: (r) => {
        loc.setCache(r.latitude, r.longitude); // 全局缓存：提交拜访弹窗直接复用最近坐标
        const newMap = {};
        this.allCustomers.forEach(c => {
          if (c.lat && c.lng) newMap[c._id] = Math.round(haversine(r.latitude, r.longitude, c.lat, c.lng));
        });
        // 指纹对比：只 setData 距离文案发生变化的卡片（无变化零重绘）
        const list = this.data.showCustomers || [];
        const patch = {};
        list.forEach((sc, i) => {
          const nv = newMap[sc._id];
          if (nv === undefined) return;
          const nt = nv < 1000 ? nv + 'm' : (nv / 1000).toFixed(1) + 'km';
          if (sc.distText !== nt) patch['showCustomers[' + i + '].distText'] = nt;
        });
        this.distMap = newMap;
        if (Object.keys(patch).length) this.setData(patch);
      },
      fail: () => { /* 静默：保留旧数字，下一轮自动重试 */ }
    });
  },
  // 定时器生命周期：进页面/回前台启动（并立即刷一次），切后台/离页停止
  startLocTimer() {
    this.stopLocTimer();
    const sec = (this.data.task && this.data.task.locRefresh) || 15;
    this._locTimer = setInterval(() => this.tryLocate(), sec * 1000);
  },
  stopLocTimer() {
    if (this._locTimer) { clearInterval(this._locTimer); this._locTimer = null; }
  },
  switchDay(e) {
    const day = Number(e.currentTarget.dataset.day);
    this.setData({ activeDay: day });
    this.refreshShow();
    // 2026-09-06 老板定：点天页签不触发定位刷新（仅进入页面与定时器刷）
  },
  refreshShow() {
    const plan = this.data.task.dayPlan.find(d => d.day === this.data.activeDay);
    if (!plan) return;
    const map = {};
    this.allCustomers.forEach(c => { map[c._id] = c; });
    const list = plan.customerIds.map(id => map[id]).filter(Boolean);
    const showCustomers = list.map((c, i) => {
      // ⭐ 2026-10-13 老板定：「任务详情页那行『最近一次拜访结果』按结果上色 ——
      //   **关门·休息中 → 蓝色**，**闭店 / 搬迁 → 红色**」。
      //   ⚠️ 拜访结果是**可多选**的（存成逗号串，如「闭店,搬迁」）→ 必须用"包含"判断，不能严格相等。
      //   ⚠️ 只给这三项上色；其余结果保持原来那套（已拜访=灰绿 / 拜访中=蓝 / 未拜访=灰）。
      const _r = String(c.lastResult || '');
      // ⭐ 2026-10-13 老板补：**「无需拜访」→ 玫红色**（`st-rose`），跟"闭店/搬迁"的正红区分开。
      //   多选组合时按"越需要注意越优先"：闭店·搬迁(红) → 无需拜访(玫红) → 关门·休息中(蓝)。
      const resCls = /闭店|搬迁/.test(_r) ? 'st-red'
        : (/无需拜访/.test(_r) ? 'st-rose'
          : (/休息中/.test(_r) ? 'st-blue' : ''));
      return {
        ...c,
        seq: i + 1,
        resCls: resCls,
        distText: this.distMap[c._id] !== undefined && this.distMap[c._id] !== null
          ? (this.distMap[c._id] < 1000 ? Math.round(this.distMap[c._id]) + 'm' : (this.distMap[c._id] / 1000).toFixed(1) + 'km')
          : ''
      };
    });
    // 每天完成态：该天客户全部已拜访
    const dayDone = {};
    // ⭐ 2026-10-11 老板定：每页下面还要显示**已拜访家数**（页面显示成「X/15 家」；
    //   **全部完成**时保持原来的「N 家 ✓」样式）—— 与 dayDone 同源算，避免两处口径漂移
    const dayVisited = {};
    this.data.task.dayPlan.forEach(p => {
      const ids = p.customerIds || [];
      const n = ids.filter(id => map[id] && map[id].visitedToday).length;
      dayDone[p.day] = ids.length > 0 && n === ids.length;
      dayVisited[p.day] = n;
    });
    // 拜访中客户所在的天：天页签加蓝色对勾角标（老板 2026-09-06 定）
    const ongoingDays = {};
    const ongIds = this.allCustomers.filter(c => c.visitOngoing).map(c => c._id);
    this.data.task.dayPlan.forEach(p => {
      ongoingDays[p.day] = ongIds.length > 0 && (p.customerIds || []).some(id => ongIds.includes(id));
    });
    // 当天第一个未拜访客户的序号（打开地图用）
    const firstTodo = showCustomers.find(c => !c.visitedToday && !c.visitOngoing);
    const allDone = this.allCustomers.length > 0 && this.allCustomers.every(c => c.visitedToday);
    this.setData({ showCustomers, dayDone, dayVisited, ongoingDays, nextSeq: firstTodo ? firstTodo.seq : 0, allDone });
  },
  // 交任务（全部完成或提前交）：页内确认弹层；提前交与开关开启时进入审核中
  finishTask() {
    console.log('[task] finishTask tapped');
    if (this.finishing) return;
    // 游客（实习账号）：交任务弹窗提示（2026-09-08 老板定：游客不能提交数据；云端硬拦兜底）
    if (api.isTrialUser()) {
      this.setData({ confirmShow: true, confirmMsg: '游客不能提交数据' });
      return;
    }
    if (!this.allCustomers || !this.allCustomers.length) {
      api.toast('数据加载中，请稍候再试');
      return;
    }
    // 制约（2026-09-05 老板定）：有客户拜访中不能交任务，先完成或取消
    const ong = this.allCustomers.find(c => c.visitOngoing);
    if (ong) {
      api.toast(`「${ong.name}」正在拜访中，请先完成或取消拜访`);
      return;
    }
    const left = this.allCustomers.filter(c => !c.visitedToday).length;
    const msg = left > 0
      ? `还有 ${left} 家未拜访，是否向管理员提前提交任务？管理员同意后任务将提前结束。`
      : '全部客户已拜访完成，确认交任务？';
    this.setData({ confirmShow: true, confirmMsg: msg });
  },
  hideFinishConfirm() {
    this.setData({ confirmShow: false });
  },
  async doFinish() {
    if (this.finishing) return;
    if (api.isTrialUser()) { this.setData({ confirmShow: false }); api.toast('游客不能提交数据'); return; }
    this.setData({ confirmShow: false });
    this.finishing = true;
    wx.showLoading({ title: '提交中…' });
    try {
      const res = await api.call('tasks', { action: 'finish', taskId: this.taskId });
      wx.hideLoading();
      this.finishing = false;
      if (res.ok) {
        api.toast(res.status === 'reviewing' ? '已提交，等待管理员审核' : '任务已结束 ✓', res.status === 'reviewing' ? 'none' : 'success');
        loc.beacon(); // 状态信标：交任务后任务内客户状态变化（2026-09-08 老板定）
        // 提交进入审核中：立即启动全局审核观察员（15 秒轮询等审批结果）
        if (res.status === 'reviewing') getApp().startReviewWatcher();
        this.load();
      } else {
        api.toast(res.msg || '操作失败，请重试');
      }
    } catch (e) {
      console.error('[task] finish error:', e);
      wx.hideLoading();
      this.finishing = false;
      api.toast('提交失败，请确认云函数已部署');
    }
  },
  openMap() {
    const first = this.data.showCustomers.find(c => !c.visitedToday && c.lat && c.lng);
    if (!first) {
      const allDone = this.data.showCustomers.every(c => c.visitedToday);
      api.toast(allDone ? '当天客户已全部拜访完成 🎉' : '未拜访客户暂无坐标，无法打开地图');
      return;
    }
    wx.openLocation({ latitude: first.lat, longitude: first.lng, name: first.name, address: first.address, fail: () => {} });
  },
  goCustomer(e) {
    const c = this.allCustomers.find(x => x._id === e.currentTarget.dataset.id);
    if (!c || !c._id) return;
    wx.setStorageSync('curCustomer', { ...c, taskId: this.taskId, taskName: this.data.task.name, locCheck: this.data.task.locCheck, locKeyRefresh: this.data.task.locKeyRefresh, recordingDurationLimit: this.data.task.recordingDurationLimit, visitDurationLimit: this.data.task.visitDurationLimit });
    // ⚠️⚠️ 2026-10-12 串档根除：**身份必须走 URL**（详情页已改成"只认 URL 的 id"）；
    //   storage 只负责带"任务设置"这类辅助信息（它仍会被 goVisit 接力）。
    wx.navigateTo({ url: '/pages/customer/customer?id=' + c._id });
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
