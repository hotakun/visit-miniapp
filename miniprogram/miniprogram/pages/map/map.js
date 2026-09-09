const api = require('../../utils/api');
const loc = require('../../utils/loc');

// 仓库坐标（2026-09-09 老板定：线路起点=仓库时显示小五角星标记）
const WH = { lat: 28.970802, lng: 120.154526 };

// ===== 地图秒开缓存（2026-09-09 提速 A 方案：首页预取 → 地图打开先渲染缓存，云端到达后静默更新）=====
const MAP_CACHE_KEY = 'map_cache';
const MAP_CACHE_TTL = 10 * 60 * 1000;

function getMapCache() {
  try {
    const c = wx.getStorageSync(MAP_CACHE_KEY);
    if (c && c.at && Date.now() - Number(c.at) < MAP_CACHE_TTL && c.map) return c;
  } catch (e) { /* 静默 */ }
  return null;
}

function setMapCache(res) {
  try {
    wx.setStorageSync(MAP_CACHE_KEY, { at: Date.now(), map: res.map || null, tasks: res.tasks || null });
  } catch (e) { /* 静默 */ }
}

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
    // 地图小圆钮控件（2026-09-09 老板定：横幅条下方靠右横排——📍我的位置/↻刷新；路况已移除）
    refreshing: false, // ↻ 按钮旋转动效（2026-09-09：静默刷新也要有视觉反馈）
    whStarOn: false, // 2026-09-09 老板定：仓库开关（横幅下方左侧小开关；开=显示仓库星+重排以仓库为起点；默认关）
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
    // 2026-09-09 提速 A：缓存先行秒开（首页已静默预取：任务下拉+第一个任务地图）
    const c = getMapCache();
    if (c && c.map) {
      const bossMen = (c.tasks || []).map(t => ({ label: (t.salesmanName || '业务员') + ' · ' + t.name, salesmanId: t.salesmanId, taskId: t._id }));
      this.setData({ bossMode: true, bossMen, curBossIdx: 0 });
      this.applyMapData(c.map);
    } else {
      this.setData({ loading: true });
    }
    try {
      const res = await api.call('tasks', { action: 'mapData' }); // 2026-09-09 提速 B：轻量接口一次拿全
      if (!res.ok) { this.setData({ loading: false, empty: res.msg || '加载失败' }); return; }
      setMapCache(res);
      const bossMen = (res.tasks || []).map(t => ({ label: (t.salesmanName || '业务员') + ' · ' + t.name, salesmanId: t.salesmanId, taskId: t._id }));
      this.setData({ bossMode: true, bossMen, curBossIdx: 0 });
      if (!bossMen.length) { this.setData({ loading: false, empty: '暂无进行中的任务' }); return; }
      this.applyMapData(res.map);
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

  async loadTask(taskId, keepDay) {
    // 2026-09-09 提速 A：业务员首载先渲染缓存（老板模式由 loadBoss 处理缓存）；之后云端数据到达静默更新
    if (!taskId && !this._cacheTried) {
      this._cacheTried = true;
      const c = getMapCache();
      if (c && c.map) this.applyMapData(c.map);
    }
    try {
      const res = await api.call('tasks', { action: 'mapData', taskId }); // 2026-09-09 提速 B：轻量接口
      if (!res.ok) { this.setData({ loading: false, empty: '任务加载失败，请重试' }); return; }
      if (!res.map) {
        this.setData({ loading: false, empty: '暂无进行中的任务\n任务发布后，这里会显示拜访路线与顺序' });
        return;
      }
      setMapCache(res);
      this.applyMapData(res.map, keepDay);
    } catch (e) {
      this.setData({ loading: false, empty: '网络异常，请重试' });
    }
  },

  // 应用地图摘要数据（缓存/云端同路径，2026-09-09 提速 B）：设置数据 → 渲染 → 撑满
  applyMapData(map, keepDay) {
    this.task = map.task;
    this.customers = map.customers || [];
    const app = getApp();
    if (app) app.globalData.locCfg = { workStartHour: map.task.workStartHour, workEndHour: map.task.workEndHour, offDutyTier: map.task.offDutyTier };
    const days = (map.task.dayPlan || []).map(p => p.day);
    const td = Math.max(1, Math.min(map.task.todayDay || 1, days.length || 1));
    // 2026-09-09 老板定：刷新保持用户所选天（换天后点刷新不再跳回今天）；首次加载默认今天
    const cd = (keepDay && days.includes(keepDay)) ? keepDay : td;
    this.setData({ loading: false, task: map.task, days, todayDay: td, curDay: cd });
    this.renderDay();
    this.fitAllCustomers(); // 数据就位后撑满当天客户点（刷新=满屏；首次进入=看到全部点；不把单店居中）
  },

  renderDay() {
    const task = this.task;
    const customers = this.customers || [];
    const curDay = this.data.curDay;
    const plan = (task.dayPlan || []).find(p => p.day === curDay);
    const ids = plan ? (plan.customerIds || []) : [];
    const list = ids.map(id => customers.find(c => c._id === id)).filter(c => c && c.lat && c.lng);
    // 先定下一家：当前天顺序中第一家未完成（未拜访且非拜访中）——它的圆标用黄描边高亮（2026-09-09 老板定）
    const next = list.find(c => !c.visitedToday && !c.visitOngoing) || null;
    // 2026-09-09 老板定：按状态分层组装（markers 数组越靠后渲染越在上层）——
    // 自底到顶：已拜访 → 仓库星 → 未拜访（序号大的在下、数字小的在上）→ 拜访中 → 业务员蓝点（show-location 系统层，天然最顶）
    const grpVisited = [], grpTodo = [], grpOngoing = [];
    list.forEach((c, i) => {
      const visited = !!c.visitedToday;
      const n = Math.min(i + 1, 20); // 一天 ≤15 家；越界兜底 20 号
      // 2026-09-09 老板定：圆标全部重写——弃用微信 label（真机圆角不圆、锚点相对图标渲染框导致偏移，已两次退货）。
      // 大师级方案：预生成 24×24 抗锯齿正圆 PNG（pins/ 目录），marker 中心锚点 → 圆标圆心精确落在客户经纬度。
      const isNext = next && c._id === next._id;
      const icon = visited
        ? '/pages/map/pins/pin_done.png' // 已拜访：灰底白勾
        : isNext
          ? `/pages/map/pins/pin_${n}_red_hl.png` // 下一家：红底白数字 + 黄色描边（比别家白描边粗 1px）
          : `/pages/map/pins/pin_${n}_${c.visitOngoing ? 'blue' : 'red'}.png`; // 拜访中蓝/待拜访橙红
      const m = {
        id: i + 1, // 当天顺序序号即 id
        custId: c._id,
        latitude: c.lat,
        longitude: c.lng,
        iconPath: icon,
        width: 24,   // 2026-09-09 老板定：24×24 实心圆标+细白描边（微软雅黑数字，GDI+ 抗锯齿渲染）
        height: 24,
        // 2026-09-09 老板核查定稿：微信 marker 默认锚点是 {0.5, 1}（图标底部中心）——
        // 不显式声明会整体偏上半图标高，必须声明中心锚点让圆心精确压在经纬度上
        anchor: { x: 0.5, y: 0.5 },
        // 2026-09-09 老板定：点圆标 → 弹出店家名字气泡；点气泡 → 再出底部详情卡（导航/去拜访）
        callout: {
          content: c.name,
          color: '#333A44', fontSize: 12, borderRadius: 8, bgColor: '#FFFFFF', padding: 7,
          display: 'BYCLICK'
        }
      };
      if (visited) grpVisited.push(m);
      else if (c.visitOngoing) grpOngoing.push(m);
      else grpTodo.push(m);
    });
    grpTodo.sort((a, b) => b.id - a.id); // 未拜访：序号大的先入数组（下层），数字小的后入（上层）
    let markers = [...grpVisited, ...grpTodo, ...grpOngoing];
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
    // 2026-09-09 老板定：仓库星显示两条件——①仓库开关打开（星在仓库坐标）②线路起点是仓库（星在起点，距仓库 300 米内）；
    // z 序不变：已拜访（底）→ 仓库星 → 未拜访 → 拜访中（顶）
    let starPt = null;
    if (this.data.whStarOn) {
      starPt = { lat: WH.lat, lng: WH.lng };
    } else if (route && Array.isArray(route.pts) && route.pts.length >= 2) {
      const sp = route.pts[0];
      if (sp && sp.length >= 2 && haversine(Number(sp[0]), Number(sp[1]), WH.lat, WH.lng) < 300) {
        starPt = { lat: Number(sp[0]), lng: Number(sp[1]) };
      }
    }
    if (starPt) {
      const star = {
        id: 999, // 特殊 id：无 custId，点按不弹客户卡
        latitude: starPt.lat, longitude: starPt.lng,
        iconPath: '/pages/map/pins/star.png',
        width: 20, height: 20, // 比客户圆标（24）小一号
        anchor: { x: 0.5, y: 0.5 } // 中心锚点精确压仓库点
      };
      markers = [...grpVisited, star, ...grpTodo, ...grpOngoing];
    }
    // 重排按钮：当天未完成（非拜访中）客户 ≥2 家才显示（1 家无需排）；老板模式去重排（2026-09-09 §7.13）
    const todoCount = list.filter(c => !c.visitedToday && !c.visitOngoing).length;
    const canReplan = !this.data.bossMode && todoCount >= 2 && task.status === 'published';
    const nextDist = next ? this.fmtDist(next) : '';
    // 2026-09-09 老板定：renderDay 永不自动移动视野——刷新/切换天数不再把第一家拉到屏幕中心；
    // 视野只由用户操作驱动（点↻=撑满 / 点「下一家」=该店居中 / 点📍=我的位置居中）
    this.setData({ markers, polyline, nextCust: next, nextDist, selCust: null, selDist: '', canReplan });
  },

  switchDay(e) {
    const d = Number(e.currentTarget.dataset.d);
    if (d === this.data.curDay) return;
    this.setData({ curDay: d });
    this.renderDay();
    this.fitAllCustomers(); // 2026-09-09 老板定：切换天数卡后自动撑满当天客户点（相当于自动刷新，但不动到单店）
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
    // 2026-09-09 老板定：点圆标=店家名字气泡（callout BYCLICK 自动弹出）；此处只负责收起旧详情卡
    this.setData({ selCust: null, selDist: '' });
  },
  onCalloutTap(e) {
    // 点店名气泡 → 出底部详情卡（导航/去拜访）
    const m = (this.data.markers || []).find(x => x.id === Number(e.detail.markerId));
    if (!m) return;
    const c = (this.customers || []).find(x => x._id === m.custId);
    if (!c) return;
    this.setData({ selCust: c, selDist: this.fmtDist(c) });
  },
  openNext() {
    // 2026-09-09 老板定：点「下一家」→ 该店滑动到屏幕中心 + 弹出底部店家卡片
    const c = this.data.nextCust;
    if (!c) return;
    this.setData({ centerLat: c.lat, centerLng: c.lng, selCust: c, selDist: this.fmtDist(c) });
  },
  closeCard() { this.setData({ selCust: null, selDist: '' }); },
  navSel() { this.nav(this.data.selCust); },
  nav(c) {
    if (!c) return;
    wx.openLocation({ latitude: c.lat, longitude: c.lng, name: c.name, address: c.address || '', scale: 16, fail: () => {} });
  },
  // 以我的位置重排当天未完成客户（2026-09-08 老板拍板：写回云端，老板后台同步看到）
  // 2026-09-09 老板定：仓库开关打开 → 以仓库为起点重排（不取定位）
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
    let p;
    if (this.data.whStarOn) {
      p = { lat: WH.lat, lng: WH.lng }; // 仓库开关开：以仓库为起点重排
    } else {
      p = loc.latest(); // 流内最新点（2026-09-08 M1：免 8 秒等待）
      if (!p || !p.at || Date.now() - p.at > 60000) {
        try {
          p = await loc.getOne(8000);
        } catch (e) {
          wx.showToast({ title: '定位失败，无法重排（请到开阔处重试）', icon: 'none' });
          this.setData({ replanBusy: false });
          return;
        }
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
  tabWar() { wx.redirectTo({ url: '/pages/bossWar/bossWar' }); }, // 老板四栏：战况（2026-09-09）
  tabMine() { wx.redirectTo({ url: '/pages/mine/mine' }); },

  // ===== 地图小圆钮控件（2026-09-09 老板定：横幅条下方靠右横排——📍我的位置/↻刷新）=====
  // 仓库开关（2026-09-09 老板定：横幅下方左侧小开关；开=显示仓库星+重排以仓库为起点；默认关；不要任何弹窗）
  toggleWhStar() {
    this.setData({ whStarOn: !this.data.whStarOn });
    this.renderDay();
  },
  // 手动刷新（老板定：静默刷新不弹窗）：先用现有数据立即撑满（秒响应），再后台拉新数据更新（保持所选天，不跳回今天）
  async refreshMap() {
    if (this._refreshing) return;
    this._refreshing = true;
    // 2026-09-09 修复：按钮旋转 0.8 秒动效（静默刷新也要有视觉反馈，否则老板点了几次像没反应）
    this.setData({ refreshing: true });
    setTimeout(() => this.setData({ refreshing: false }), 800);
    try {
      this.fitAllCustomers();
      const keepDay = this.data.curDay;
      if (this.data.bossMode) {
        const m = this.data.bossMen[this.data.curBossIdx];
        if (!m) { api.toast('暂无任务可刷新'); return; }
        await this.loadTask(m.taskId, keepDay);
      } else {
        await this.loadTask(null, keepDay);
      }
    } finally {
      this._refreshing = false;
    }
    // 静默刷新：成功后不再弹「已刷新」提示（老板 2026-09-09 定）
  },
  // 满屏撑满：视野缩放到当天全部客户点，四边留白避开横幅条/天页签/矮TAB/安全区/店名气泡（2026-09-09 老板定）
  fitAllCustomers() {
    const task = this.task;
    const curDay = this.data.curDay;
    const plan = (task && task.dayPlan || []).find(p => p.day === curDay);
    const ids = plan ? (plan.customerIds || []) : [];
    const pts = ids.map(id => (this.customers || []).find(c => c._id === id))
      .filter(c => c && c.lat && c.lng)
      .map(c => ({ latitude: c.lat, longitude: c.lng }));
    if (!pts.length) return; // 静默：当天无客户点不打扰（2026-09-09 老板定）
    // 2026-09-09 冲突修复：底部必须动态算（矮TAB 40px + 手机安全区 + 14 空隙）——
    // 之前写死 36 是在加 TAB 栏之前定的，TAB 加高后底部客户点被压住，撑满限制形同失效
    let safeBottom = 0;
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      safeBottom = Math.max(0, (info.screenHeight - info.safeArea.bottom) || 0);
    } catch (e) { /* 静默 */ }
    const bottomPad = 40 + safeBottom + 14;
    wx.createMapContext('mp', this).includePoints({
      points: pts,
      // 上 132 避开天页签+横幅（含老板模式下拉）；左右 44 给店名气泡留空间；底=动态避开 TAB+安全区
      padding: [132, 44, bottomPad, 44]
    });
  },
  // 回到我的位置：切回当天 + 视野居中到定位坐标（2026-09-09 老板定：蓝点用微信自带 show-location，
  // 自带方向扇叶样式；此处只负责把视野移过去）
  backToMe() {
    if (this._locBusy) return;
    this._locBusy = true;
    // 点「我的位置」自动切回今天的天页签（换了天数也能一键回当天）
    if (this.data.todayDay && this.data.curDay !== this.data.todayDay) {
      this.setData({ curDay: this.data.todayDay });
      this.renderDay();
    }
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
