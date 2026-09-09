// 战况地图（2026-09-09 §7.13 老板拍板）：业务员实时位置三色点+静止预警+今日动态流+点人抽屉卡
const api = require('../../utils/api');

// 点状态色（与后台位置监控同口径）
const P_COLOR = { ongoing: '#2F80ED', moving: '#F5531C', still: '#9CA3AF' };
const P_LABEL = { ongoing: '拜访中', moving: '在移动', still: '静止' };

Page({
  data: {
    loading: true, empty: '',
    points: [], events: [], stats: null,
    markers: [], includePoints: [], centerLat: 28.970802, centerLng: 120.154526,
    selMan: null, onlyId: '', warnCount: 0, updateText: '',
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
      const points = (w.points || []).filter(p => p && !p.noData && p.lat && p.lng);
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
        warnCount, updateText, includePoints: points.map(p => ({ latitude: p.lat, longitude: p.lng }))
      });
      this.renderMarkers();
    } catch (e) {
      this.setData({ loading: false, empty: '网络异常，请重试' });
    }
  },

  // 三色点：蓝=拜访中 / 橙=在移动 / 灰=静止；静止>40 分钟=红圈预警（红底感叹号）
  renderMarkers() {
    const onlyId = this.data.onlyId;
    const src = (this._points || []).filter(p => p && !p.noData && (!onlyId || p.salesmanId === onlyId));
    const markers = src.map(p => {
      const warn = p.state === 'still' && p.ageMin > 40;
      return {
        id: p.salesmanId,
        latitude: p.lat, longitude: p.lng,
        width: 1, height: 1,
        label: {
          content: warn ? '⚠' : String(p.name || '员').slice(0, 1),
          color: '#FFFFFF', bgColor: warn ? '#E5484D' : P_COLOR[p.state],
          borderRadius: 14, padding: 7, fontSize: 12
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

  // 点业务员点 → 底部抽屉卡（2026-09-09 老板定：状态+最后上报+今日提交数+只看他）
  onMarkerTap(e) {
    const id = e.detail && e.detail.markerId;
    const p = (this._points || []).find(x => x.salesmanId === id);
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

  // 只看他：地图过滤为单个业务员（再点同一人取消）
  toggleOnly() {
    const id = this.data.selMan && this.data.selMan.salesmanId;
    const onlyId = this.data.onlyId === id ? '' : id;
    this.setData({ onlyId, selMan: null });
    this.renderMarkers();
  },
  clearOnly() { this.setData({ onlyId: '' }); this.renderMarkers(); },

  // 底部四栏导航（老板模式）
  tabHome() { wx.redirectTo({ url: '/pages/home/home' }); },
  tabMap() { wx.redirectTo({ url: '/pages/map/map' }); },
  tabMine() { wx.redirectTo({ url: '/pages/mine/mine' }); }
});
