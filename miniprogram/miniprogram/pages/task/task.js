const api = require('../../utils/api');
const loc = require('../../utils/loc');

Page({
  data: {
    task: null, customers: [], showCustomers: [], activeDay: 1, loading: true,
    dayDone: {}, ongoingDays: {}, nextSeq: 0, allDone: false, confirmShow: false, confirmMsg: ''
  },
  onLoad(options) {
    this.taskId = options.taskId;
    this._loaded = false;
    this.distMap = {};
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
      if (st === 'done') api.toast('审核已通过，任务已完成 ✓', 'success');
      else if (st === 'published') api.toast('审核未通过，任务继续执行', 'none');
      if (this._shown) this.load();
    } catch (e) { /* 静默，下次刷新再试 */ }
  },
  async lightRefresh() {
    try {
      const res = await api.call('tasks', { action: 'detail', taskId: this.taskId });
      if (!res.ok) return;
      const customers = res.customers.map(c => ({ ...c, typeName: c.customerType === 'new' ? 'new' : 'mall' }));
      this.allCustomers = customers;
      this.setData({ customers });
      this.refreshShow();
    } catch (e) { /* 静默：下一轮进入再刷 */ }
  },
  async load() {
    try {
      const res = await api.call('tasks', { action: 'detail', taskId: this.taskId });
      if (!res.ok) { api.toast(res.msg || '任务加载失败'); wx.navigateBack(); return; }
      const customers = res.customers.map(c => ({ ...c, typeName: c.customerType === 'new' ? 'new' : 'mall' }));
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
      // 进入任务自动定位天页签（2026-09-05 老板定）：当天在排期内→当天；未开始→第 1 天；已过排期→最后一天（最近的一天）
      const td = Number(res.task.todayDay);
      let activeDay;
      if (td >= 1 && td <= dayPlan.length) {
        activeDay = td;
      } else if (td < 1) {
        activeDay = dayPlan.length ? dayPlan[0].day : 1;
      } else {
        activeDay = dayPlan[dayPlan.length - 1].day;
      }
      this.allCustomers = customers;
      this.setData({
        task: { ...res.task, dayPlan, deadline: fmtMD(res.task.deadline) || res.task.deadline || '' },
        customers, activeDay, loading: false
      });
      // 时间分层配置同步全局（2026-09-08 M2 审查修复：task 页也要同步，loc.js 采集器依赖）
      const app = getApp();
      if (app) app.globalData.locCfg = { workStartHour: res.task.workStartHour, workEndHour: res.task.workEndHour, offDutyTier: res.task.offDutyTier };
      // 任务在审核中：启动全局审核观察员，15 秒被动等待审批结果
      if (res.task.status === 'reviewing') getApp().startReviewWatcher();
      this.refreshShow();
      this.tryLocate();
      this.startLocTimer();
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
    const showCustomers = list.map((c, i) => ({
      ...c,
      seq: i + 1,
      distText: this.distMap[c._id] !== undefined && this.distMap[c._id] !== null
        ? (this.distMap[c._id] < 1000 ? Math.round(this.distMap[c._id]) + 'm' : (this.distMap[c._id] / 1000).toFixed(1) + 'km')
        : ''
    }));
    // 每天完成态：该天客户全部已拜访
    const dayDone = {};
    this.data.task.dayPlan.forEach(p => {
      const ids = p.customerIds || [];
      dayDone[p.day] = ids.length > 0 && ids.every(id => map[id] && map[id].visitedToday);
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
    this.setData({ showCustomers, dayDone, ongoingDays, nextSeq: firstTodo ? firstTodo.seq : 0, allDone });
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
    wx.setStorageSync('curCustomer', { ...c, taskId: this.taskId, taskName: this.data.task.name, locCheck: this.data.task.locCheck, locKeyRefresh: this.data.task.locKeyRefresh, recordingDurationLimit: this.data.task.recordingDurationLimit, visitDurationLimit: this.data.task.visitDurationLimit });
    wx.navigateTo({ url: '/pages/customer/customer' });
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
