// 战况地图（2026-09-09 §7.13 老板拍板）：业务员实时位置三色点+静止预警+今日动态流+点人抽屉卡
const api = require('../../utils/api');
const loc = require('../../utils/loc'); // 2026-09-09 老板定：📍我的位置按钮用

// 点状态色（与后台位置监控同口径）
const P_COLOR = { ongoing: '#2F80ED', moving: '#F5531C', still: '#9CA3AF' };
const P_LABEL = { ongoing: '拜访中', moving: '在移动', still: '静止' };

Page({
  data: {
    loading: true, empty: '',
    points: [], events: [], stats: null,
    markers: [], centerLat: 28.970802, centerLng: 120.154526,
    selMan: null, warnCount: 0, updateText: '',
    refreshing: false, // ↻ 旋转动效（2026-09-09 修复：静默刷新也要视觉反馈）
    trackPolyline: [], trackOn: false, // 2026-09-09 老板定：今日轨迹（绿色折线，点地图空白清除）
    tabIdx: 2 // 战况 tab 高亮
  },

  onShow() {
    if (!getApp().globalData.bossMode) {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.load();
    this._timer = setInterval(() => this.load(true), 30000); // 30 秒自动刷（2026-09-09 老板定）
  },
  onHide() { this.clearTimer(); },
  onUnload() { this.clearTimer(); },
  clearTimer() { if (this._timer) { clearInterval(this._timer); this._timer = null; } },

  async load(silent) {
    if (!silent) this.setData({ loading: true });
    try {
      const [b, w] = await Promise.all([
        api.call('tasks', { action: 'bossBoard' }),
        api.call('tasks', { action: 'bossWar' })
      ]);
      if (!w.ok) { this.setData({ loading: false, empty: w.msg || '加载失败' }); return; }
      const allPts = w.points || [];
      const warnCount = allPts.filter(p => p && !p.noData && p.state === 'still' && p.ageMin > 40).length;
      const upd = new Date(Date.now() + 8 * 3600 * 1000);
      const updateText = `${String(upd.getUTCHours()).padStart(2, '0')}:${String(upd.getUTCMinutes()).padStart(2, '0')} 更新`;
      this._points = allPts;
      // 动态流时间格式化（毫秒 → HH:mm，wxml 直接显示）
      const events = (w.events || []).map(v => ({ ...v, t: this.fmtHM(v.t) }));
      this.setData({
        loading: false, empty: '',
        points: allPts, events, stats: b.ok ? (b.stats || null) : null,
        warnCount, updateText
      });
      this.renderMarkers();
      // 2026-09-09 老板定：只在首次进入战况地图时自动撑满一次；之后 30 秒自动刷新只更新数据不动视野
      if (!this._fitted) { this._fitted = true; this.fitAll(); }
    } catch (e) {
      this.setData({ loading: false, empty: '网络异常，请重试' });
    }
  },

  // 撑满：全部业务员点入屏（手动刷新/首次进入才调用）；2026-09-09 冲突修复：底部动态避开四栏 TAB+安全区
  fitAll() {
    const pts = (this._points || [])
      .filter(p => p && !p.noData && p.lat && p.lng)
      .map(p => ({ latitude: p.lat, longitude: p.lng }));
    if (!pts.length) return;
    let safeBottom = 0;
    try {
      const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      safeBottom = Math.max(0, (info.screenHeight - info.safeArea.bottom) || 0);
    } catch (e) { /* 静默 */ }
    const bottomPad = 55 + safeBottom + 12; // 四栏 TAB（110rpx≈55px）+ 安全区 + 空隙
    wx.createMapContext('wmp', this).includePoints({ points: pts, padding: [16, 16, bottomPad, 16] });
  },
  // ↻ 刷新：静默重拉数据 + 撑满（2026-09-09 老板定；防连点+旋转动效 2026-09-09 修复）
  async refreshMap() {
    if (this._refreshing) return;
    this._refreshing = true;
    this.setData({ refreshing: true });
    setTimeout(() => this.setData({ refreshing: false }), 800);
    try {
      await this.load(true);
      this.fitAll();
    } finally {
      this._refreshing = false;
    }
  },
  // 📍 我的位置：定位并移动视野到老板自己位置（2026-09-09 老板定；本地定位不落库）
  backToMe() {
    loc.getOne(8000).then(p => {
      if (p && p.lat) {
        this.setData({ centerLat: p.lat, centerLng: p.lng });
        api.toast('已回到我的位置', 'success');
      } else {
        api.toast('定位失败，请到开阔处重试');
      }
    }).catch(() => api.toast('定位失败，请到开阔处重试'));
  },

  // 三色点：蓝=拜访中 / 橙=在移动 / 灰=静止；静止>40 分钟=红圈预警（红底感叹号）
  renderMarkers() {
    const src = (this._points || []).filter(p => p && !p.noData);
    this._markerList = src; // 与 markers 顺序一一对应，点按事件按数字 id 取回
    const markers = src.map((p, idx) => {
      const warn = p.state === 'still' && p.ageMin > 40;
      return {
        id: idx + 1, // 微信要求 marker id 必须是数字（2026-09-09 报障修复）；salesmanId 是字符串不可用
        latitude: p.lat, longitude: p.lng,
        // 2026-09-09 报障修复：label 不可点击，点击热区=图标本体；之前 1×1 无图标导致点不中 →
        // 用 26×26 透明图标撑热区；anchor(50,50) 相对图标渲染框=label 圆标中心精确压坐标
        iconPath: '/pages/bossWar/transparent26.png',
        width: 26, height: 26,
        label: {
          content: warn ? '⚠' : String(p.name || '员').slice(0, 1),
          color: '#FFFFFF', bgColor: warn ? '#E5484D' : P_COLOR[p.state],
          borderRadius: 14, padding: 7, fontSize: 12,
          anchorX: 50, anchorY: 50
        },
        callout: {
          content: `${p.name} · ${warn ? '静止超40分钟' : P_LABEL[p.state]}`,
          color: '#333A44', fontSize: 12, borderRadius: 8, bgColor: '#FFFFFF', padding: 7, display: 'BYCLICK'
        }
      };
    });
    this.setData({ markers });
  },

  fmtHM(ts) {
    if (!ts) return '--:--';
    const d = new Date(Number(ts) + 8 * 3600 * 1000);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  },

  // 点业务员点 → 底部抽屉卡（2026-09-09 老板定：状态+最后上报+今日提交数+拨打电话/今日轨迹）
  onMarkerTap(e) {
    const id = e.detail && e.detail.markerId;
    // marker id 是数字序号（微信要求）；按顺序映射回业务员点（2026-09-09 报障修复）
    const p = (this._markerList || [])[Number(id) - 1];
    if (!p) return;
    const evs = this.data.events || [];
    const todayN = evs.filter(v => v.type === 'submit').length; // 全团队今日提交数（抽屉全局口径）
    const myN = evs.filter(v => v.salesmanName === p.name && v.type === 'submit').length;
    this.setData({
      selMan: {
        ...p,
        stateLabel: p.ageMin > 40 && p.state === 'still' ? '静止超40分钟' : P_LABEL[p.state],
        stateColor: p.ageMin > 40 && p.state === 'still' ? '#E5484D' : P_COLOR[p.state],
        lastText: p.ageMin >= 999 ? '今天暂无上报' : `${p.ageMin} 分钟前上报`,
        mySubmit: myN, allSubmit: todayN
      }
    });
  },
  closeDrawer() { this.setData({ selMan: null }); },

  // ===== 抽屉卡两个选项（2026-09-09 老板定：拨打电话 / 今日轨迹）=====
  // 📞 拨打业务员注册时填写的手机号（老板模式不打码）
  callMan() {
    const m = this.data.selMan;
    if (!m) return;
    const phone = String(m.phone || '').trim();
    if (!phone) { api.toast('该业务员未登记手机号'); return; }
    wx.makePhoneCall({ phoneNumber: phone, fail: () => api.toast('拨号未完成') });
  },
  // 📜 今日轨迹：拉当天轨迹点串 → 绿色折线画在地图上；再点一次清除
  async showTrack() {
    const m = this.data.selMan;
    if (!m) return;
    if (this.data.trackOn) { this.clearTrack(); return; }
    try {
      const res = await api.call('tasks', { action: 'bossTrack', salesmanId: m.salesmanId, day: api.today() });
      if (!res.ok) { api.toast(res.msg || '轨迹加载失败'); return; }
      const pts = res.pts || [];
      if (pts.length < 2) { api.toast('今天还没有轨迹数据'); return; }
      this.setData({
        trackOn: true,
        trackPolyline: [{ points: pts, color: '#16A34A', width: 4 }]
      });
      api.toast(`已显示今日轨迹（${pts.length} 点）`);
    } catch (e) {
      api.toast('轨迹加载失败，请重试');
    }
  },
  clearTrack() { this.setData({ trackOn: false, trackPolyline: [] }); },

  // 底部四栏导航（老板模式）
  tabHome() { wx.redirectTo({ url: '/pages/home/home' }); },
  tabMap() { wx.redirectTo({ url: '/pages/map/map' }); },
  tabMine() { wx.redirectTo({ url: '/pages/mine/mine' }); }
});
