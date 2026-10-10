// 自由拜访地图页（2026-10-03）
// 口径详见 _scratch/自由拜访-方案与口径.md：
//   · 圈心跟着我的定位走（跟随态）；「📌 固定范围」后圈心/客户点/档位全锁死、刷新禁用，可「📍 解除固定」
//   · **只有手动「🔄 刷新」才拉点**（不自动跟走动）—— 省电省流量
//   · 切档位 = 重新拉点 + 视野对准整圈；右上角 `⛶` 只调视野不拉数据
//   · 三种针：橙=没去过 / 蓝=拜访中 / 灰=去过（⚠️ 去过但**出了圈也要画**）
//   · 出圈震动提醒：**只在"圈内→出圈"跳变时震一次**，另加冷却 —— 否则蓝点在边界晃会一直震
const api = require('../../utils/api');
const loc = require('../../utils/loc');

const ORANGE = '/images/pin.png';
const BLUE = '/images/pin-blue.png';
const GRAY = '/images/pin-gray.png';
const RED = '/images/pin-red.png';      // ⭐ 2026-10-04 选中的那个点（老板要放大变红跳最上层）

const RANGE_TEXT = { 200: '200 米', 500: '500 米', 1000: '1 公里', 2000: '2 公里' };

Page({
  data: {
    centerLat: 29.0785, centerLng: 119.6550,   // 地图中心（先给个默认，定位回来即覆盖）
    mapScale: 16,
    markers: [],
    circles: [],
    polyline: [],          // 🧭 路径（我 → 某家店的连线；点 ✕ 或换目标时清掉）
    radius: 500,            // 档位（米）
    locked: false,          // 固定态
    showName: false,        // 店名开关
    nearCount: 0,           // 附近家数
    visitedCount: 0,        // 其中去过几家家
    areaText: '定位中…',
    outOfRange: false,
    sel: null               // 点中的客户（弹小卡）
  },

  onLoad(options) {
    // ⚠️ 卡片页会带 tripId 过来 —— 指定「当前跟的是哪张卡」（去哪 / 去过都按它算）
    this._optTripId = (options && options.tripId) || '';
    this._pts = [];          // 本次拉回来的附近点
    this._visitedIds = {};   // 本卡去过的客户 id（用于灰针判断）
    this._visitedPts = [];   // 本卡去过、但可能不在圈内的点（额外画出来）
    this._tripId = '';       // 当前"最新在用卡"的 id（新拜访归到它）
    this._lastOut = false;   // 上一次是否在圈外（震动去重）
    this._lastShakeAt = 0;   // 上次震动时间（冷却 60 秒）
    this._busy = false;
    this._startLoc();
    this._loadTrips();
    this._locateThenLoad(true);
  },

  // ⚠️ 2026-10-04【对抗性检查修】原来只在 onUnload 停定时器 → **切到后台/别的页面还在每 6 秒定位一次**（费电）
  onHide() {
    if (this._locTimer) { clearInterval(this._locTimer); this._locTimer = null; }
  },
  onShow() {
    if (!this._locTimer) this._locTimer = setInterval(() => this._tickLoc(), 6000);
  },
  onUnload() {
    if (this._locTimer) { clearInterval(this._locTimer); this._locTimer = null; }
  },

  // ── 定位：拿一次中心 + 起持续订阅（蓝点用系统 show-location，实时更新）──────
  _startLoc() {
    // 持续订阅：只用于「出圈判断」与中心跟随，**不触发拉点**
    this._locTimer = setInterval(() => this._tickLoc(), 6000);
  },

  // 定时器体（提出来是为了 onHide/onShow 能干净地停开 —— 2026-10-04）
  // ⚠️⚠️ 2026-10-04【修体验问题】老板问"过一会儿就切回以自己为中心，是系统自动还是你规定的"
  //   —— 原来这里**每 6 秒 setData({centerLat, centerLng})**，把**地图视野**也重置回我的位置 →
  //      老板**手一拖地图，最多 6 秒就被弹回去**。那是我的设计缺陷，不是系统行为。
  //   现在的口径：**只让「圈」跟着我走**（circles 的中心），**绝不去动地图视野**。
  //   （地图视野只在三种时候才动：进页面首次定位、点右上角 ⌖ 我的位置、点 ⛶ 全部显示。）
  //   ⚠️ 跟随态下圈心 = 我，所以"我永远在圈中心"，不存在出圈；固定态才判出圈（见 _checkOut）。
  _tickLoc() {
    loc.getOne(6000).then(p => {
      if (!p || !p.lat) return;
      const prev = this._me;
      this._me = p;
      if (!this.data.locked) {
        // ⚠️ 2026-10-04 老板反馈"看着像隔几分钟刷新一次" → 加**位移门槛**：
        //   人没走动时**不挪圈**（原来每 6 秒无条件 setData 一次 = 费电 + 视觉上像在闪）。
        //   只有**位移超过 20 米**才更新圈的位置。
        const moved = !prev || this._dist(prev.lat, prev.lng, p.lat, p.lng) > 20;
        if (moved) {
          this._drawCircle(p.lat, p.lng, this.data.radius);
        }
      }
      this._checkOut(p);
    }).catch(() => {});
  },

  _locateThenLoad(first) {
    loc.getOne(8000).then(p => {
      if (!p || !p.lat) {
        wx.showToast({ title: '还没拿到定位，请检查定位权限', icon: 'none' });
        return;
      }
      this._me = p;
      if (!this.data.locked) this.setData({ centerLat: p.lat, centerLng: p.lng });
      this._loadPoints(p.lat, p.lng, this.data.radius, first);
    }).catch(() => {
      wx.showToast({ title: '还没拿到定位，请检查定位权限', icon: 'none' });
    });
  },

  // ── 拉点（唯一取点入口）────────────────────────────────────────────
  _loadPoints(lat, lng, radius, fit) {
    if (this._busy) return;
    this._busy = true;
    wx.showLoading({ title: '取附近客户…', mask: false });
    api.call('tasks', { action: 'nearbyCustomers', lat: lat, lng: lng, radius: radius })
      .then(r => {
        wx.hideLoading();
        this._busy = false;
        if (!r || !r.ok) {
          wx.showToast({ title: (r && r.msg) || '取点失败', icon: 'none' });
          return;
        }
        // ⭐ 2026-10-05 老板要的：**把云函数顺手带回来的「现场证据/定位」配置写进全局** ——
        //   自由拜访没有 taskId，走不了「tasks.detail / mapData」那条路（见 AGENTS.md 那条"已知取舍"），
        //   于是拜访页会退回默认值。现在从 nearbyCustomers 的返回里补上。
        if (r.cfg) {
          const _app = getApp();
          _app.globalData.sysCfg = Object.assign({}, _app.globalData.sysCfg || {}, r.cfg);
        }
        this._pts = r.points || [];
        this.setData({ nearCount: r.count || this._pts.length });
        // ⭐ 2026-10-04【对抗性检查修】areaText 原来初始化成定位中后就**再没更新过** → 永远显示定位中
        //   现在按附近点的众数推「区域 · 商圈」（取不到就给兜底文案）
        const _cnt = (key) => { const mp = {}; this._pts.forEach(x => { const v = String(x[key] || '').trim(); if (v) mp[v] = (mp[v] || 0) + 1; });
          let best = '', n = 0; Object.keys(mp).forEach(k => { if (mp[k] > n) { n = mp[k]; best = k; } }); return best; };
        const _d = _cnt('d'), _b = _cnt('b');
        this.setData({ areaText: [_d, _b].filter(Boolean).join(' · ') || (this._pts.length ? '附近' : '附近暂无客户') });
        if (r.truncated) wx.showToast({ title: '附近店很多，只显示最近 500 家', icon: 'none' });
        this._drawCircle(lat, lng, radius);
        this._render();
        if (fit) this._fitCircle(lat, lng, radius);   // 切档位/打开时把视野对准整圈
      })
      .catch(e => {
        wx.hideLoading();
        this._busy = false;
        console.error('[自由拜访] 取点失败', e);   // ⚠️ 原始异常只进 console
        wx.showToast({ title: '取附近店铺失败，请下拉刷新重试', icon: 'none' });
      });
  },

  // ── 卡：找"最新在用卡"（新拜访归到它）+ 拿它去过的店（含圈外的）────────
  _loadTrips() {
    api.call('tasks', { action: 'freeTripList', limit: 50 }).then(r => {
      if (!r || !r.ok || !r.list || !r.list.length) return;
      const active = r.list.filter(t => t.status === 'active');
      const want = this._optTripId ? r.list.filter(t => t.id === this._optTripId)[0] : null;
      const cur = want || active[0] || r.list[0];   // 指定卡优先；否则最新建的在最前
      if (cur && cur.status === 'active') this._tripId = cur.id;
      if (cur) this._loadTripCustomers(cur.id);
    }).catch(() => {});
  },

  _loadTripCustomers(tripId) {
    api.call('tasks', { action: 'freeTripDetail', tripId: tripId }).then(r => {
      if (!r || !r.ok) return;
      const m = {};
      const extra = [];
      (r.customers || []).forEach(c => {
        if (!c.lat || !c.lng) return;
        m[c.id] = true;
        // ⚠️ 统一成 nearbyCustomers 那套**简写字段**（i/n/nr/la/ln/ad/ds），
        //   否则 _render 读不到名字、也反查不到 id（2026-10-04 老板真机踩到：小窗全显示"客户"、三按钮无反应）
        extra.push({ i: c.id, n: c.name || '', nr: c.nameRaw || '', ad: c.address || '',
                     d: c.district || '', b: c.bizCircle || '',
                     la: Number(c.lat) || 0, ln: Number(c.lng) || 0, ds: 0 });
      });
      this._visitedIds = m;
      this._visitedPts = extra;
      // ⚠️⚠️ 2026-10-05【检查修】这里**不要**再 setData `visitedCount`！
      //   它跟 `_render` 里的 setData 会**互相覆盖**，而且语义不一致：
      //   · 这里算的是"本卡去过的**总数**"（含圈外）
      //   · `_render` 算的是"**圈内**去过的"
      //   UI 写的是「附近 N 家 · 其中去过 X 家」→ X 必须跟"附近这批"配套，
      //   所以**只由 `_render` 说了算**（它每次渲染都会重算并 setData）。
      this._render();
    }).catch(() => {});
  },

  // ── 画圈（原生 circles）──────────────────────────────────────────
  _drawCircle(lat, lng, radius) {
    this.setData({
      circles: [{
        latitude: lat, longitude: lng, radius: radius,
        // ⚠️⚠️ 小程序 map 的 circles：**描边色字段名是 `color`，不是 `strokeColor`**！
        //   写成 strokeColor 不报错、只是**不生效** → 圈会显示成默认的**黑色**（2026-10-04 老板实测发现）
        strokeWidth: 2,
        color: '#F5531C',            // 描边（品牌橙）
        fillColor: '#F5531C14'       // 填充（约 8% 透明）
      }]
    });
  },

  // ── 视野对准整圈（⛶ 与 切档位/打开时用）────────────────────────────
  _fitCircle(lat, lng, radius) {
    const dLat = radius / 111000;
    const dLng = radius / (111000 * Math.cos(lat * Math.PI / 180) || 1);
    const pts = [
      { latitude: lat + dLat, longitude: lng },
      { latitude: lat - dLat, longitude: lng },
      { latitude: lat, longitude: lng + dLng },
      { latitude: lat, longitude: lng - dLng }
    ];
    wx.createMapContext('mp', this).includePoints({ points: pts, padding: [70, 56, 250, 56] });
  },

  // ── 渲染 markers：圈内的点 + 圈外的"去过"点 ────────────────────────
  _render() {
    const out = [];
    let visited = 0;
    let seq = 0;
    this._markerMap = {};                     // ⚠️ 必须在 push 调用之前清空
    const push = (p, isVisited) => {
      const id = ++seq;
      const nm = p.nr || p.n || '客户';
      const isSel = !!(this.data.sel && this.data.sel.id && p.i === this.data.sel.id);   // ⭐ 是不是被点中的那家
      out.push({
        id: id,
        latitude: p.la, longitude: p.ln,
        // ⭐ 2026-10-04 老板要："选中的标点要跳到最上面一层、稍微放大、变成红色"
        //   → iconPath 换红针 + 尺寸放大到 34×44 + zIndex 999 压住其它点
        iconPath: isSel ? RED : (isVisited ? GRAY : ORANGE),
        width: isSel ? 34 : 26, height: isSel ? 44 : 34,
        zIndex: isSel ? 999 : 1,
        _isSel: isSel,               // ⚠️ 内部标记：渲染前把它挪到数组最后（数组越靠后越在上层）
        anchor: { x: 0.5, y: 1 },
        // ⚠️ 2026-10-05 老板定稿（第 7 版，**最终**）：**只有选中的用实色，其他的保持半透明**。
        //   老板原话："只有选中的是实色显示，其他还是保持透明度显示。"
        //   · 选中的：纯白字 + 纯深灰底（实色，最醒目，配合红针/放大/置顶）
        //   · 其他的：浅白字 + 半透明深灰底（**不遮地图**，密集时才看得见底下）
        //   ⚠️ 两个坑记着：① `label.color` **不认 8 位 hex**（`bgColor` 认）→ 文字用 6 位、底色才敢用 8 位；
        //                  ② 选中的那个即使没开「店名」开关也显示（`showName || isSel`）。
        label: (this.data.showName || isSel) ? {
          content: nm,
          color: isSel ? '#FFFFFF' : '#E8E8E8',        // 选中=纯白 / 其他=浅白（6 位 hex）
          fontSize: isSel ? 12 : 11,                    // 选中的略大
          bgColor: isSel ? '#333333' : '#3333334D',      // 选中=实底 / 其他=30% 透明底
          borderWidth: 0,
          borderRadius: 3,
          padding: 2,                  // ⚠️ 刚好装下文字，不要大
          textAlign: 'center',
          anchorX: 0,                  // 0 = 水平居中
          // ⚠️ 2026-10-05 老板要的：**选中的图标放大了（34→44），文字要跟着往上挪**，否则压住针尖。
          //   未选中的高度 34 → 留 8px 间隙 = -42；选中的高度 44 → 留 8px 间隙 = **-52**。
          //   ⚠️ **只动选中的**，其他点保持 -42（老板原话："只针对选中的点，其他点不要动"）。
          anchorY: isSel ? -52 : -42   // 负值 = 浮在针尖上方
        } : undefined
      });
      // ⚠️ 存**客户 id**（i），不是名字 —— 名字可能有重名/为空，反查必须靠 id
      this._markerMap[id] = { i: p.i, name: nm, address: p.ad || '', dist: p.ds || 0, visited: isVisited };
    };
    (this._pts || []).forEach(p => {
      const isV = !!this._visitedIds[p.i];
      if (isV) visited++;
      push(p, isV);
    });
    // ⚠️ 本卡去过、但**不在当前圈内**的店也要画出来（老板 2026-10-03 定）
    const inSet = {};
    (this._pts || []).forEach(p => { inSet[p.i] = true; });
    (this._visitedPts || []).forEach(p => {
      if (inSet[p.i]) return;
      push(p, true);
    });
    // ⚠️⚠️ 2026-10-04【关键】小程序的 `markers` **数组越靠后 = 渲染越在上层**
    //   （项目既有经验，见 `pages/map/map.js` 2026-09-09 那条注释）。
    //   只设 `zIndex` 不够 —— 必须把**选中的那个点挪到数组最后**，才真的压在最上面。
    //   老板要的循环效果：点 A → A 到顶层（红针放大）；再点 B → A 自动回原层、B 上顶层。
    const _selIdx = out.findIndex(x => x._isSel);
    if (_selIdx >= 0) out.push(out.splice(_selIdx, 1)[0]);
    out.forEach(x => { if ('_isSel' in x) delete x._isSel; });   // ⚠️ 私有字段别传给小程序
    this.setData({ markers: out, visitedCount: visited });
  },

  // ── 出圈判断（震动提醒：只在"圈内→出圈"跳变时震，另加 60 秒冷却）──────
  _checkOut(me) {
    if (!this.data.locked) {                 // 跟随态圈心就是我，不存在出圈
      if (this.data.outOfRange) this.setData({ outOfRange: false });
      this._lastOut = false;
      return;
    }
    const c = this._fixedCenter;
    if (!c) return;
    const d = this._dist(me.lat, me.lng, c.lat, c.lng);
    const out = d > this.data.radius;
    if (out !== this.data.outOfRange) this.setData({ outOfRange: out });
    // ⚠️ 只有 false → true 才震，避免蓝点在圈边来回晃被连环震
    if (out && !this._lastOut) {
      const now = Date.now();
      if (now - this._lastShakeAt > 60000) {
        this._lastShakeAt = now;
        for (let i = 0; i < 3; i++) {
          setTimeout(() => { wx.vibrateShort({ type: 'medium' }); }, i * 200);
        }
      }
    }
    this._lastOut = out;
  },

  _dist(lat1, lng1, lat2, lng2) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  },

  // ── 交互 ────────────────────────────────────────────────────────
  // 档位：重新拉点 + 视野对准整圈（固定态被锁）
  onRange(e) {
    if (this.data.locked) {
      wx.showToast({ title: '已固定范围，档位已锁定\n先解除固定再来', icon: 'none' });
      return;
    }
    const r = Number(e.currentTarget.dataset.r) || 500;
    this.setData({ radius: r, sel: null });
    // ⚠️ 2026-10-04 修：这里原来是 `false`（不对准视野）—— 与口径「切档位 = 拉点 + **视野对准整圈**」不符。
    //   老板实测反馈"切了档位圈跑到屏幕外/看不见整圈"就是它。
    this._locateThenLoad(true);
    wx.showToast({ title: '已切到 ' + RANGE_TEXT[r] + '\n已重新拉点 · 视野对准整圈', icon: 'none' });
  },

  // 🔄 刷新：重新拉点（唯一取点方式）
  onRefresh() {
    if (this.data.locked) {
      wx.showToast({ title: '已固定范围，不能再刷新\n解除固定后才能刷新', icon: 'none' });
      return;
    }
    this.setData({ sel: null });
    this._locateThenLoad(true);
  },

  // ⛶ 全部显示：只调视野，不拉数据
  onFit() {
    const c = this.data.locked && this._fixedCenter ? this._fixedCenter
      : { lat: this.data.centerLat, lng: this.data.centerLng };
    this._fitCircle(c.lat, c.lng, this.data.radius);
    wx.showToast({ title: '视野已对准整个范围圈', icon: 'none' });
  },

  // ⌖ 我的位置
  onLoc() {
    loc.getOne(6000).then(p => {
      if (!p || !p.lat) { wx.showToast({ title: '还没拿到定位', icon: 'none' }); return; }
      this._me = p;
      this.setData({ centerLat: p.lat, centerLng: p.lng, mapScale: 16 });
      if (!this.data.locked) this._drawCircle(p.lat, p.lng, this.data.radius);
    }).catch(() => { wx.showToast({ title: '还没拿到定位', icon: 'none' }); });
  },

  // 🏷 店名开关
  onToggleName() {
    const v = !this.data.showName;
    this.setData({ showName: v });
    this._render();
    wx.showToast({ title: v ? '已显示店名' : '已隐藏店名', icon: 'none' });
  },

  // 📌 固定 / 📍 解除固定
  onLock() {
    if (!this.data.locked) {
      const c = { lat: this.data.centerLat, lng: this.data.centerLng };
      wx.showModal({
        title: '固定范围',
        content: '固定后，范围与客户点都不再变化，也不能再刷新。确定固定吗？',
        confirmText: '固定',
        success: (res) => {
          if (!res.confirm) return;
          this._fixedCenter = c;
          this.setData({ locked: true, sel: null });
          wx.showToast({ title: '已固定 · 范围与客户点都锁住了', icon: 'none' });
        }
      });
      return;
    }
    this._fixedCenter = null;
    this._lastOut = false;
    this.setData({ locked: false, outOfRange: false, sel: null });
    this._locateThenLoad(true);
    wx.showToast({ title: '已解除固定 · 圈心回到我的定位', icon: 'none' });
  },

  // ➕ 建立自由任务
  onMakeTrip() {
    const me = this._me || { lat: this.data.centerLat, lng: this.data.centerLng };
    const c = this.data.locked && this._fixedCenter ? this._fixedCenter : me;
    wx.showLoading({ title: '建立中…', mask: true });
    api.call('tasks', {
      action: 'freeTripCreate',
      lat: c.lat, lng: c.lng, radius: this.data.radius, district: '', bizCircle: ''
    }).then(r => {
      wx.hideLoading();
      if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '建立失败', icon: 'none' }); return; }
      this._tripId = r.id || '';
      // ⭐ 新卡是空的 —— 重置「去过」标记，否则界面上还留着旧卡的灰针（2026-10-04 对抗性检查修）
      this._visitedIds = {}; this._visitedPts = [];
      this._render(); this.setData({ visitedCount: 0 });
      wx.showToast({ title: '已建立自由拜访卡\n去「卡片页」看看', icon: 'none' });
    }).catch(e => {
      wx.hideLoading();
      console.error('[自由拜访] 建卡失败', e);   // ⚠️ 2026-10-04：原来把英文异常直接弹给业务员了
      wx.showToast({ title: '建立失败，请稍后再试', icon: 'none' });
    });
  },

  // 点客户点 → 弹小卡（不直接导航）
  onMarkerTap(e) {
    const id = Number(e.detail.markerId);
    const m = (this._markerMap || {})[id];
    if (!m || !m.i) return;                    // ⚠️ 必须有真实客户 id，否则三个按钮点了也没用
    const p = (this._pts || []).find(x => x.i === m.i) ||
              (this._visitedPts || []).find(x => x.i === m.i) || {};
    this.setData({
      sel: {
        id: m.i,
        name: m.name,
        address: m.address,
        dist: (typeof p.ds === 'number' && p.ds) ? p.ds : (p.ds || 0),
        stateText: m.visited ? '已拜访' : '未去过'
      }
    }, () => {
      // ⚠️⚠️ 2026-10-04【修 bug】必须放在 setData 的**回调**里！
      //   `setData` 是**异步**的 —— 原来紧跟其后直接调 `_render()`，
      //   那时 `this.data.sel` 可能还是**旧值** → 表现为"选中变红/显店名时灵时不灵"。
      this._render();   // 重画：让选中的那个点变红、放大、跳到最上层、并显示店名
    });
  },

  // ✕ 关掉客户小卡（⭐ 2026-10-04 老板要的：否则这张卡没处关）
  closeCard() {
    // ⚠️ 同 onMarkerTap：`_render()` 必须放 setData 回调里（setData 是异步的，
    //   否则可能读到旧的 sel，那个点不会恢复成普通的针）
    this.setData({ sel: null, polyline: [] }, () => {
      this._render();
    });
  },

  // 🧭 路径（⭐ 2026-10-04 老板要的）：在**当前地图上**画一条「我 → 这家」的**真实步行路线**
  //   ⚠️ 路线是**云函数**调腾讯 walking 接口算的（`tasks.walkRoute`）—— 云函数不受小程序域名白名单限制，
  //      所以**不需要去微信后台配 request 域名**（任务地图 / 后台的路线也是这么调的）。
  //   ⚠️ 腾讯接口失败时云端返回**直线兜底**，这里照画并提示"（近似直线）"，不会"点了没反应"。
  onRoute() {
    const s = this.data.sel;
    if (!s || !s.id) return;
    const me = this._me;
    const p = (this._pts || []).find(x => x.i === s.id) ||
              (this._visitedPts || []).find(x => x.i === s.id) || {};
    const la = Number(p.la) || 0, ln = Number(p.ln) || 0;
    if (!me || !me.lat) { wx.showToast({ title: '还没拿到我的定位', icon: 'none' }); return; }
    if (!la || !ln) { wx.showToast({ title: '这家没有坐标，画不了路线', icon: 'none' }); return; }
    wx.showLoading({ title: '规划路线…', mask: false });
    api.call('tasks', {
      action: 'walkRoute',
      fromLat: me.lat, fromLng: me.lng, toLat: la, toLng: ln
    }).then(r => {
      wx.hideLoading();
      if (!r || !r.ok || !r.pts || r.pts.length < 2) {
        wx.showToast({ title: '路线获取失败，请稍后再试', icon: 'none' });
        return;
      }
      const pts = r.pts.map(q => ({ latitude: q[0], longitude: q[1] }));
      this.setData({
        // ⭐ 2026-10-07 老板定：**路线改「绿色 + 加粗」**（原来是品牌橙 5px，压在底图上不够跳）——
        //   绿用项目既有路线同款的 #16A34A（任务地图那条也是这个绿），宽度 5 → 8，白描边 1 → 2。
        polyline: [{
          points: pts, color: '#16A34A', width: 8,
          arrowLine: true, borderColor: '#FFFFFF', borderWidth: 2
        }]
      });
      // 视野框住整条路线（底部留位给工具栏）
      wx.createMapContext('mp', this).includePoints({ points: pts, padding: [80, 60, 260, 60] });
      const km = r.distanceMeters >= 1000
        ? (r.distanceMeters / 1000).toFixed(1) + ' 公里'
        : r.distanceMeters + ' 米';
      wx.showToast({
        title: '步行 ' + km + (r.durationMin ? (' · 约 ' + r.durationMin + ' 分钟') : '') + (r.fallback ? '（近似直线）' : ''),
        icon: 'none', duration: 2600
      });
    }).catch(e => {
      wx.hideLoading();
      console.error('[自由拜访] 路线规划失败', e);
      wx.showToast({ title: '路线获取失败，请稍后再试', icon: 'none' });
    });
  },

  onNav() {
    const s = this.data.sel;
    if (!s || !s.id) return;
    const p = (this._pts || []).find(x => x.i === s.id) ||
              (this._visitedPts || []).find(x => x.i === s.id) || {};
    const lat = Number(p.la) || 0, lng = Number(p.ln) || 0;
    if (!lat || !lng) { wx.showToast({ title: '这家没有坐标，无法导航', icon: 'none' }); return; }
    wx.openLocation({
      latitude: lat, longitude: lng,
      name: s.name, address: s.address || '', scale: 18
    });
  },

  // 📋 详情（⭐ 2026-10-05 老板定：**删掉「去拜访」按钮**，因为详情页里本来就有）
  //   ⚠️⚠️ **必须先把 `curCustomer` 写好（关键是带 `freeTripId`）** ——
  //   客户详情页的 `goVisit()` 写的是 `Object.assign({}, curCustomer, {...})`，
  //   它**完全不认识 `freeTripId`**（customer.js 里 0 处引用），只能"从前一份继承"。
  //   → 不先写，归属就丢了，表现是：**从详情页进去拜访的店，不记进这张自由拜访卡**。
  onDetail() {
    const s = this.data.sel;
    if (!s || !s.id) return;
    const p = (this._pts || []).find(x => x.i === s.id) ||
              (this._visitedPts || []).find(x => x.i === s.id) || {};
    wx.setStorageSync("curCustomer", {
      _id: s.id, name: s.name, address: s.address || "",
      lat: Number(p.la) || 0, lng: Number(p.ln) || 0,
      taskId: "", freeTripId: this._tripId || ""
    });
    wx.navigateTo({ url: '/pages/customer/customer?customerId=' + s.id });
  }
});
