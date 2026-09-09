const api = require('../../utils/api');
const loc = require('../../utils/loc');

// 地图页（2026-09-08 二期核心：独立自取当前任务，天页签+客户点/绿色路线/下一家引导/导航）
Page({
  data: {
    loading: true, empty: '',
    task: null, days: [], curDay: 1, todayDay: 1,
    markers: [], polyline: [],
    centerLat: 28.970802, centerLng: 120.154526,
    nextCust: null, nextDist: '',
    selCust: null, selDist: '',
    canReplan: false, replanBusy: false,
    // 地图浮层控件（2026-09-09 老板定：三个小圆钮横排在横幅条下方靠右——🚦路况/📍我的位置/↻刷新）
    trafficOn: false,
    // 老板模式（2026-09-09 §7.13）：业务员下拉切换（老板拍板：重排按钮位置变业务员选择器，去掉重排）
    bossMode: false, bossMen: [], curBossIdx: 0
  },
  onShow() {
    if (getApp().globalData.bossMode) {
      this.setData({ bossMode: true });
      if (!this._loaded) this.loadBoss();
      return;
    }
    if (!this._loaded) this.loadTask();
    this.startLoc();
  },
  onHide() { this.stopLoc(); },
  onUnload() { this.stopLoc(); },

  // 老板任务地图（2026-09-09 §7.13）：任务列表全量 → 业务员下拉（默认第一个）；切换=换任务重载
  async loadBoss() {
    this.setData({ loading: true });
    try {
      const res = await api.call('tasks', { action: 'list' });
      if (!res.ok) { this.setData({ loading: false, empty: res.msg || '加载失败' }); return; }
      const tasks = (res.tasks || []).filter(t => t.status === 'published' || t.status === 'reviewing');
      const bossMen = tasks.map(t => ({ label: (t.salesmanName || '业务员') + ' · ' + t.name, salesmanId: t.salesmanId, taskId: t._id }));
      this.setData({ bossMode: true, bossMen, curBossIdx: 0 });
      if (!bossMen.length) { this.setData({ loading: false, empty: '暂无进行中的任务' }); return; }
      await this.loadTask(bossMen[0].taskId);
    } catch (e) {
      this.setData({ loading: false, empty: '网络异常，请重试' });
    }
  },

  // 切换业务员（老板模式）：重新加载该业务员的任务地图
  async onBossMen(e) {
    const idx = Number(e.detail.value) || 0;
    const m = this.data.bossMen[idx];
    if (!m || m.taskId === this.data.taskId) return;
    this.setData({ curBossIdx: idx });
    this._loaded = false;
    await this.loadTask(m.taskId);
  },

  async loadTask(taskId) {
    try {
      let t = null;
      if (taskId) {
        const d0 = await api.call('tasks', { action: 'detail', taskId });
        if (!d0.ok) { this.setData({ loading: false, empty: '任务加载失败，请重试' }); return; }
        t = d0.task;
        this.task = d0.task;
        this.customers = d0.customers || [];
      } else {
        const res = await api.call('tasks', { action: 'list' });
        t = (res.ok && res.tasks) ? res.tasks.find(x => x.status === 'published' || x.status === 'reviewing') : null;
        if (!t) {
          this.setData({ loading: false, empty: '暂无进行中的任务\n任务发布后，这里会显示拜访路线与顺序' });
          return;
        }
        const d = await api.call('tasks', { action: 'detail', taskId: t._id });
        if (!d.ok) { this.setData({ loading: false, empty: '任务加载失败，请重试' }); return; }
        this.task = d.task;
        this.customers = d.customers || [];
      }
      // 时间分层配置同步全局（2026-09-08 M2：loc.js 采集器读取）
      const app = getApp();
      if (app) app.globalData.locCfg = { workStartHour: this.task.workStartHour, workEndHour: this.task.workEndHour, offDutyTier: this.task.offDutyTier };
      const days = (this.task.dayPlan || []).map(p => p.day);
      const td = Math.max(1, Math.min(this.task.todayDay || 1, days.length || 1));
      this.setData({ loading: false, task: this.task, days, todayDay: td, curDay: td });
      this.renderDay();
    } catch (e) {
      this.setData({ loading: false, empty: '网络异常，请重试' });
    }
  },

  renderDay() {
    const task = this.task;
    const customers = this.customers || [];
    const curDay = this.data.curDay;
    const plan = (task.dayPlan || []).find(p => p.day === curDay);
    const ids = plan ? (plan.customerIds || []) : [];
    const list = ids.map(id => customers.find(c => c._id === id)).filter(c => c && c.lat && c.lng);
    const markers = list.map((c, i) => {
      const visited = !!c.visitedToday;
      const n = Math.min(i + 1, 20); // 一天 ≤15 家；越界兜底 20 号
      // 2026-09-09 老板定：圆标全部重写——弃用微信 label（真机圆角不圆、锚点相对图标渲染框导致偏移，已两次退货）。
      // 大师级方案：预生成 36×36 抗锯齿正圆 PNG（pins/ 目录，数字 5×7 点阵字体超采样绘制），
      // marker 默认锚点=图标中心(0.5,0.5) → 圆标圆心天然精确落在客户经纬度，零运行时不确定。
      const icon = visited
        ? '/pages/map/pins/pin_done.png' // 已拜访：灰底白勾
        : `/pages/map/pins/pin_${n}_${c.visitOngoing ? 'blue' : 'red'}.png`; // 拜访中蓝/待拜访橙红
      return {
        id: i + 1, // 当天顺序序号即 id
        custId: c._id,
        latitude: c.lat,
        longitude: c.lng,
        iconPath: icon,
        width: 24,   // 2026-09-09 老板定：24×24 实心圆标+细白描边（微软雅黑数字，GDI+ 抗锯齿渲染）
        height: 24
      };
    });
    // 路线：真实道路轨迹（后台规划存任务）；无轨迹 → 按顺序直线兜底
    let polyline = [];
    const route = plan && plan.route;
    if (route && Array.isArray(route.pts) && route.pts.length >= 2) {
      polyline = [{
        points: route.pts.map(p => ({ latitude: p[0], longitude: p[1] })),
        color: '#16A34A', width: 4
      }];
    } else if (list.length >= 2) {
      polyline = [{
        points: list.map(c => ({ latitude: c.lat, longitude: c.lng })),
        color: '#16A34A', width: 4
      }];
    }
    // 下一家：当前天顺序中第一家未完成
    const next = list.find(c => !c.visitedToday && !c.visitOngoing) || null;
    // 重排按钮：当天未完成（非拜访中）客户 ≥2 家才显示（1 家无需排）；老板模式去重排（2026-09-09 §7.13）
    const todoCount = list.filter(c => !c.visitedToday && !c.visitOngoing).length;
    const canReplan = !this.data.bossMode && todoCount >= 2 && task.status === 'published';
    // 视野中心：下一家 → 当前天第一个点 → 我的位置（show-location 自带）→ 仓库
    let centerLat = this.data.centerLat, centerLng = this.data.centerLng;
    if (next) { centerLat = next.lat; centerLng = next.lng; }
    else if (list.length) { centerLat = list[0].lat; centerLng = list[0].lng; }
    const nextDist = next ? this.fmtDist(next) : '';
    this.setData({ markers, polyline, centerLat, centerLng, nextCust: next, nextDist, selCust: null, selDist: '', canReplan });
  },

  switchDay(e) {
    const d = Number(e.currentTarget.dataset.d);
    if (d === this.data.curDay) return;
    this.setData({ curDay: d });
    this.renderDay();
  },

  fmtDist(c) {
    const me = this._me;
    if (!me || !me.lat || !c.lat) return '';
    const m = haversine(me.lat, me.lng, c.lat, c.lng); // haversine 返回米
    return m < 1000 ? Math.round(m) + ' 米' : (m / 1000).toFixed(1) + ' 公里';
  },
  fmtSelDist() {
    if (!this.data.selCust) return '';
    return this.fmtDist(this.data.selCust);
  },

  startLoc() {
    const throttle = (this.task && this.task.locRefresh) ? this.task.locRefresh * 1000 : 30000;
    const apply = p => {
      this._me = { lat: p.lat, lng: p.lng };
      const d1 = this.data.nextCust ? this.fmtDist(this.data.nextCust) : '';
      const d2 = this.data.selCust ? this.fmtDist(this.data.selCust) : '';
      this.setData({ nextDist: d1, selDist: d2 });
    };
    // 位置流（2026-09-08 M1）：订阅并按档位节流渲染；流不可用自动走降级轮询
    this._unsubLoc = loc.subscribe(apply, throttle);
    loc.startForeground();
    // 首次立即刷新（流尚未推送之前先显示距离）
    loc.getOne(8000).then(apply).catch(() => {});
    // 降级轮询：流 90 秒没动静（模拟器/老基础库/权限拒绝）→ getOne 兜底
    this._locTimer = setInterval(() => {
      const lp = loc.latest();
      if (lp && lp.at && Date.now() - lp.at < 90000) return;
      loc.getOne(8000).then(apply).catch(() => {});
    }, throttle);
  },
  stopLoc() {
    clearInterval(this._locTimer);
    if (this._unsubLoc) { this._unsubLoc(); this._unsubLoc = null; }
  },

  onMarkerTap(e) {
    const m = (this.data.markers || []).find(x => x.id === Number(e.detail.markerId));
    if (!m) return;
    const c = (this.customers || []).find(x => x._id === m.custId);
    if (!c) return;
    this.setData({ selCust: c, selDist: this.fmtDist(c) });
  },
  openNext() {
    if (!this.data.nextCust) return;
    this.setData({ selCust: this.data.nextCust, selDist: this.fmtDist(this.data.nextCust) });
  },
  closeCard() { this.setData({ selCust: null, selDist: '' }); },
  navSel() { this.nav(this.data.selCust); },
  nav(c) {
    if (!c) return;
    wx.openLocation({ latitude: c.lat, longitude: c.lng, name: c.name, address: c.address || '', scale: 16, fail: () => {} });
  },
  // 以我的位置重排当天未完成客户（2026-09-08 老板拍板：写回云端，老板后台同步看到）
  async replanDay() {
    if (this.data.replanBusy) return;
    const task = this.task;
    const curDay = this.data.curDay;
    const plan = (task && task.dayPlan || []).find(p => p.day === curDay);
    const ids = plan ? (plan.customerIds || []) : [];
    const customers = this.customers || [];
    const todoIds = ids.map(id => customers.find(c => c._id === id))
      .filter(c => c && !c.visitedToday && !c.visitOngoing).map(c => c._id);
    if (todoIds.length < 2) { wx.showToast({ title: '未完成客户不足 2 家，无需重排', icon: 'none' }); return; }
    this.setData({ replanBusy: true });
    let p = loc.latest(); // 流内最新点（2026-09-08 M1：免 8 秒等待）
    if (!p || !p.at || Date.now() - p.at > 60000) {
      try {
        p = await loc.getOne(8000);
      } catch (e) {
        wx.showToast({ title: '定位失败，无法重排（请到开阔处重试）', icon: 'none' });
        this.setData({ replanBusy: false });
        return;
      }
    }
    if (!p) {
      wx.showToast({ title: '定位失败，无法重排（请到开阔处重试）', icon: 'none' });
      this.setData({ replanBusy: false });
      return;
    }
    try {
      const res = await api.call('tasks', {
        action: 'replanDay', taskId: task._id, day: curDay,
        origin: { lat: p.lat, lng: p.lng }, customerIds: todoIds
      });
      if (!res.ok) { wx.showToast({ title: res.msg || '重排失败', icon: 'none' }); return; }
      const km = (res.distanceMeters || 0) / 1000;
      wx.showToast({ title: (res.msg || '已重排') + (km ? ' · ' + km.toFixed(1) + ' 公里' : ''), icon: 'none', duration: 2200 });
      this._loaded = false; // 重新拉任务（dayPlan/route/顺序刷新，页签自然切回今天）
      this.loadTask();
    } catch (e) {
      wx.showToast({ title: '网络异常，重排失败', icon: 'none' });
    } finally {
      this.setData({ replanBusy: false });
    }
  },
  goVisit() {
    const c = this.data.selCust;
    if (!c) return;
    wx.setStorageSync('curCustomer', {
      ...c, taskId: this.task._id, taskName: this.task.name,
      locCheck: this.task.locCheck, locKeyRefresh: this.task.locKeyRefresh,
      recordingDurationLimit: this.task.recordingDurationLimit,
      visitDurationLimit: this.task.visitDurationLimit
    });
    wx.navigateTo({ url: '/pages/customer/customer' });
  },
  goHome() { wx.redirectTo({ url: '/pages/home/home' }); },

  // ===== 地图小圆钮控件（2026-09-09 老板定：横幅条下方靠右横排——🚦路况/📍我的位置/↻刷新）=====
  // 路况开关：微信 map 组件原生 show-traffic（默认关省流量）
  toggleTraffic() { this.setData({ trafficOn: !this.data.trafficOn }); },
  // 手动刷新：重拉当前任务数据 + 所有客户点满屏撑满显示（不含我的位置；顶部避开横幅与天页签）
  async refreshMap() {
    if (this.data.bossMode) {
      const m = this.data.bossMen[this.data.curBossIdx];
      if (!m) { api.toast('暂无任务可刷新'); return; }
      this._loaded = false;
      await this.loadTask(m.taskId);
    } else {
      this._loaded = false;
      await this.loadTask();
    }
    if (this.data.empty) { api.toast(this.data.empty); return; }
    this.fitAllCustomers();
    api.toast('已刷新 ✓', 'success');
  },
  // 满屏撑满：视野缩放到当天全部客户点，顶部留白避开横幅条与天页签（2026-09-09 老板定）
  fitAllCustomers() {
    const task = this.task;
    const curDay = this.data.curDay;
    const plan = (task && task.dayPlan || []).find(p => p.day === curDay);
    const ids = plan ? (plan.customerIds || []) : [];
    const pts = ids.map(id => (this.customers || []).find(c => c._id === id))
      .filter(c => c && c.lat && c.lng)
      .map(c => ({ latitude: c.lat, longitude: c.lng }));
    if (!pts.length) { api.toast('当天暂无客户点'); return; }
    wx.createMapContext('mp', this).includePoints({
      points: pts,
      padding: [110, 16, 24, 16] // 上留 110px 避开天页签+横幅条；右/下/左贴边
    });
  },
  // 回到我的位置：取一次定位并把视野移过去（老板模式同样可用，本地定位不落库）
  backToMe() {
    if (this._locBusy) return;
    this._locBusy = true;
    loc.getOne(8000).then(p => {
      if (p && p.lat) {
        this.setData({ centerLat: p.lat, centerLng: p.lng });
        api.toast('已回到我的位置', 'success');
      } else {
        api.toast('定位失败，请到开阔处重试');
      }
    }).catch(() => api.toast('定位失败，请到开阔处重试')).then(() => { this._locBusy = false; });
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
