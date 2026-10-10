// 定位取点组件（2026-10-07 新建）
// ---------------------------------------------------------------------------
// 由来：客户详情页「📍 报错」改成**大半屏弹层**（老板 2026-10-07 定），弹层里要"三个来源现场取点"——
//   与「加新店」第 1 步的定位界面**同一套**，所以搬成组件复用（老板口径：搬，不重写）。
//   ⚠️ `pages/newshop/` **一行未动**（它继续用自己那份，等这边稳了再考虑切过来）。
//   ⚠️ `utils/gps/` 只 require、**一个字不改**。
//
// 职责边界：**只管取点**。
//   · 不做查重 / 区域识别（那是加新店页的事）、不碰云端、不发任何请求；
//   · 用户点「✓ 采用」→ `triggerEvent('adopt', { lat, lng, src })`，**取值与提交由页面决定**。
//
// ⭐ 三个来源各自独立、互不覆盖：
//     📱 手机定位（蓝，/images/locdot_blue.png）  —— 精度差（几十米），退路
//     📡 北斗卫星（绿，/images/locdot_green.png） —— 精度约 1 米，采点中绿点实时移动
//     ✎ 手动微调（红，/images/locdot_red.png）    —— 拖着对准门口，兜底矫正
//   · 三个点可同屏；**被采用的那个正常显示、略大，另外两个 50% 半透明**（alpha .45）
//   · **"候选 → 采用"两段式**（卫星与微调都是这个模型）：
//       采点中只写 `pend*`、微调中只写 `tunCand*` —— **绝不写最终坐标**，点「✓ 采用」才落定
//   · ⭐ 微调的特别之处：**已定下的 `tunLat` 在重新微调时"留在原地不动"**，
//       动的只是 `tunCand*`（地图正中的红图钉）；只有再点「✓ 采用微调」才把候选落定
//   · 进采点 / 微调之前**先停另一个来源**；北斗收敛时**震动**提醒
//   · ⚠️ **微调中绝不许 setData 地图中心**（否则视野被拉回、红点看着"跳回去"——加新店页真机踩过）
const api = require('../../utils/api');
const { GpsCapture } = require('../../utils/gps/capture');

// 三个点位的图标：**三张同款、只有颜色不同**（与加新店同一套图）
const ICON = { phone: '/images/locdot_blue.png', gps: '/images/locdot_green.png', tune: '/images/locdot_red.png' };
const MARK = 22;                   // 三个点的标准边长
const MARK_BIG = 26;               // 被采用的那个点略大一圈，好认

Component({
  // ⚠️ 样式保持默认隔离（isolated）：组件里的 .row / .card 之类不会漏到客户详情页上
  properties: {
    // 进来先把地图中心放到这里（= 客户现有坐标）
    //   ⚠️ 只当"视野起点"与微调兜底，**不预置"已采用"状态**（用户必须自己点采用）
    initLat: { type: null, value: '' },
    initLng: { type: null, value: '' },
    // 进组件自动跑一次手机定位（照加新店页 onLoad 的做法；拿到的只是"候选"，要用户点「✓ 采用手机」）
    autoLocate: { type: Boolean, value: true }
  },

  data: {
    // ===== 坐标：三个来源各自独立 + adopted 记录采用了哪个 =====
    phoneLat: '', phoneLng: '', phoneAcc: '', phoneOn: false,            // 📱 手机定位
    gpsLat: '', gpsLng: '', gpsWgsLat: '', gpsWgsLng: '', gpsOn: false,  // 📡 北斗卫星（已采用）
    tunLat: '', tunLng: '', tunOn: false,                                // ✎ 微调（**已定下**的那个点）
    // 北斗卫星中的"候选"（**绝不写进 gpsLat/gpsLng**，点「采用卫星」才落）
    pendLat: '', pendLng: '', pendWgsLat: '', pendWgsLng: '', pendStable: false,
    // 微调拖动中的"候选"（= 地图中心；**绝不写进 tunLat**，点「采用微调」才落）
    tunCandLat: '', tunCandLng: '', tunDist: '',
    gpsText: '', gpsSummary: '', capOn: false,
    adopted: '',                    // '' | 'phone' | 'gps' | 'tune'  ← 最终用哪个
    mode: 'idle',                   // idle | capturing | tuning
    markers: [],                    // 地图上的点（三个来源）
    mapLat: '', mapLng: '',         // 地图中心
    // 提交用：= 被采用那个点的坐标（页面通过 adopt 事件 / getPicked() 取）
    lat: '', lng: '', wgsLat: '', wgsLng: '',
    locBusy: false
  },

  lifetimes: {
    attached() {
      this._dead = false;
      // ⚠️ 只设地图中心，**不要在这里调 _mks()** —— _mks 会把中心重算成"已采用点/卫星/手机"，
      //    那时三样都是空的，反而把刚设上的 initLat 清掉。
      const la = this.data.initLat, ln = this.data.initLng;
      if (la && ln) this.setData({ mapLat: la, mapLng: ln });
      if (this.data.autoLocate) this.locateNow();
    },
    detached() {
      // ⚠️ 采点必须停：BLE 连接不能留着（离开弹层就该断）
      this._dead = true;
      try { if (this.cap) this.cap.destroy(); } catch (e) { /* 静默 */ }
      this.cap = null;
    }
  },

  methods: {
    // 页面也可以直接问它要"已采用的坐标"（不是必须，adopt 事件已够）
    getPicked() {
      const d = this.data;
      return d.adopted
        ? { lat: d.lat, lng: d.lng, wgsLat: d.wgsLat, wgsLng: d.wgsLng, src: d.adopted }
        : null;
    },

    // ===================== 🗺 地图上的三个点 =====================
    //   ⭐ 被采用的：正常大小、全色；另外两个：alpha .45（一眼看清用了哪个）
    //   ⚠️ 微调中的"候选"**不画成 marker** —— 由地图正中的红图钉（.cmap-pin）表示，
    //      这样"已定下的红点"能留在原地不动、候选在正中，两个点各司其职。
    _mks() {
      const d = this.data;
      const a = (k) => (d.adopted && d.adopted !== k) ? 0.45 : 1;
      const sz = (k) => (d.adopted === k ? MARK_BIG : MARK);   // 被采用的 26 / 其余 22
      const ms = [];
      if (d.phoneLat) ms.push({
        id: 1, latitude: Number(d.phoneLat), longitude: Number(d.phoneLng),
        iconPath: ICON.phone, width: sz('phone'), height: sz('phone'), alpha: a('phone'), anchor: { x: .5, y: .5 }
      });
      const gLat = d.mode === 'capturing' ? d.pendLat : d.gpsLat;
      const gLng = d.mode === 'capturing' ? d.pendLng : d.gpsLng;
      if (gLat) ms.push({
        id: 2, latitude: Number(gLat), longitude: Number(gLng),
        iconPath: ICON.gps, width: sz('gps'), height: sz('gps'), alpha: a('gps'), anchor: { x: .5, y: .5 }
      });
      // 微调点（**已定下的那个**）—— 微调中也照常显示，留在原地不动
      if (d.tunLat) ms.push({
        id: 3, latitude: Number(d.tunLat), longitude: Number(d.tunLng),
        iconPath: ICON.tune, width: sz('tune'), height: sz('tune'), alpha: a('tune'), anchor: { x: .5, y: .5 }
      });
      // ⚠️⚠️ 微调模式**绝对不许改地图中心**：用户拖地图 → regionchange → setData → 回调 _mks() →
      //   这里如果再设一次中心 → **地图被拉回去** → 红点看着"跳回"、用户怎么拖都白费。
      //   所以：**微调中只更新 markers，一个字的视野都不动**。
      const set = { markers: ms };
      if (d.mode !== 'tuning') {
        // 非微调：地图中心优先"采用的那个"，其次北斗卫星，再次手机；都没有就回到传进来的客户坐标
        set.mapLat = d.lat || d.gpsLat || d.phoneLat || d.initLat || '';
        set.mapLng = d.lng || d.gpsLng || d.phoneLng || d.initLng || '';
      }
      this.setData(set);
    },

    // 取地图当前中心（兜底用）
    _center() {
      return new Promise((ok) => {
        try {
          const ctx = wx.createMapContext('gmap', this);
          ctx.getCenterLocation({ success: (r) => ok({ lat: r.latitude, lng: r.longitude }), fail: () => ok(null) });
        } catch (e) { ok(null); }
      });
    },

    // ===================== 📍 采用某个来源 =====================
    //   三个"采用"按钮都走这里；采用后**抛给页面**（页面拿它去提交报错）
    _adopt(src) {
      const d = this.data;
      let lat = '', lng = '', wgsLat = '', wgsLng = '';
      if (src === 'phone') { if (!d.phoneLat) return; lat = d.phoneLat; lng = d.phoneLng; }
      else if (src === 'gps') { if (!d.gpsLat) return; lat = d.gpsLat; lng = d.gpsLng; wgsLat = d.gpsWgsLat || ''; wgsLng = d.gpsWgsLng || ''; }
      else if (src === 'tune') { if (!d.tunLat) return; lat = d.tunLat; lng = d.tunLng; }
      else return;
      // ⭐ 采用任何来源都**先把微调模式收掉**（mode='idle'）——
      //   否则地图仍然"可拖"（enable-scroll 跟着 mode）、regionchange 继续生效，
      //   已采用的那个点会被下一次拖动改掉。
      this.setData({
        mode: 'idle', adopted: src, lat: lat, lng: lng, wgsLat: wgsLat, wgsLng: wgsLng,
        tunCandLat: '', tunCandLng: ''
      }, () => this._mks());
      try { wx.vibrateShort({ type: 'light' }); } catch (e) { /* 静默 */ }
      // ⭐ 通知页面（客户详情页据此知道"用户可以提交了"，并拿坐标去提交）
      this.triggerEvent('adopt', { lat: lat, lng: lng, src: src });
    },
    adoptPhone() { this._adopt('phone'); },

    // ===================== 📱 坐标 1：手机定位 =====================
    locateNow() {
      if (this.data.locBusy) return;
      if (this.data.mode === 'tuning') return api.toast('先退出微调，再重新定位');
      this.setData({ locBusy: true });
      wx.getLocation({
        type: 'gcj02', isHighAccuracy: true, highAccuracyExpireTime: 6000,
        success: (r) => {
          if (this._dead) return;
          this.setData({
            locBusy: false, phoneOn: true,
            phoneLat: Number(r.latitude).toFixed(6),
            phoneLng: Number(r.longitude).toFixed(6),
            phoneAcc: '约 ' + Math.round(r.accuracy || 0) + ' 米'
          }, () => this._mks());
        },
        fail: () => {
          if (this._dead) return;
          this.setData({ locBusy: false });
          api.toast('定位失败：请检查定位权限，或改用「📡 北斗卫星」');
        }
      });
    },

    // ===================== 📡 坐标 2：北斗卫星 采点 =====================
    //   ⚠️ 采点中**只写 pend\***（候选），**不碰 gpsLat/gpsLng** —— 必须点「✓ 采用卫星」才算数
    _ensureCap() {
      if (this.cap) return this.cap;
      this.cap = new GpsCapture({
        deviceNameKey: 'xinghewei',
        onStatus: (s) => { if (!this._dead) this.setData({ gpsText: s.text || '' }); },
        onProgress: (p) => {
          if (this._dead) return;
          const set = { gpsSummary: p.summary || '' };
          if (p.gcjLat) { set.pendLat = Number(p.gcjLat).toFixed(6); set.pendLng = Number(p.gcjLng).toFixed(6); }
          if (p.lat) { set.pendWgsLat = Number(p.lat).toFixed(6); set.pendWgsLng = Number(p.lng).toFixed(6); }
          const wasStable = this.data.pendStable;
          set.pendStable = !!p.stable;
          this.setData(set, () => this._mks());      // 绿点跟着"候选"实时移动（这本身就是进度反馈）
          // 刚收敛那一刻：**震一下** + 提示可以采用了
          if (p.stable && !wasStable) {
            try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 静默 */ }
            api.toast('已收敛 —— 可以点「✓ 采用卫星」了');
          }
        },
        onError: (e) => {
          if (this._dead) return;
          this.setData({ capOn: false, mode: 'idle' });
          api.toast((e && e.message) || '采点出错，请重试');
        },
        onLog: (m) => console.log('[GPS]', m)
      });
      return this.cap;
    },
    async startCapture() {
      if (this.data.capOn) return;
      if (this.data.mode === 'tuning') return api.toast('先退出微调，再采点');
      this.setData({
        capOn: true, mode: 'capturing', gpsText: '正在搜索设备…', gpsSummary: '',
        pendLat: '', pendLng: '', pendWgsLat: '', pendWgsLng: '', pendStable: false
      }, () => this._mks());
      try {
        await this._ensureCap().start();
      } catch (e) {
        this.setData({ capOn: false, mode: 'idle' });
        api.toast('采点失败：' + ((e && e.message) || '请检查定位功能与网络'));
      }
    },
    stopCapture() {
      try { if (this.cap) this.cap.stop(); } catch (e) { /* 静默 */ }
      if (this.data.capOn) this.setData({ capOn: false, mode: 'idle', gpsText: '已停止采点' }, () => this._mks());
    },
    tapCap() { if (this.data.mode === 'capturing') this.stopCapture(); else this.startCapture(); },
    // 「✓ 采用卫星」：把"候选"（pend*）落成 gpsLat/gpsLng，并采用它
    adoptGpsCapture() {
      const d = this.data;
      if (!d.pendLat) return api.toast('还没收到位置：把设备放店门口，等十几秒');
      if (!d.pendStable) api.toast('还没收敛（可能偏几米），已按当前值采用');
      this.stopCapture();
      this.setData({
        gpsOn: true, gpsLat: d.pendLat, gpsLng: d.pendLng,
        gpsWgsLat: d.pendWgsLat || '', gpsWgsLng: d.pendWgsLng || ''
      }, () => this._adopt('gps'));
    },

    // 「✓ 采用微调」：把**当前候选**（= 地图中心）落成 tunLat，再采用它
    async adoptTune() {
      const d = this.data;
      if (d.mode !== 'tuning') return;
      let lat = d.tunCandLat, lng = d.tunCandLng;
      if (!lat) {                                    // 没拖动过 / 事件没给 → 用地图中心兜底
        const c = await this._center();
        if (!c) return api.toast('还没取到地图中心：拖一下地图再点');
        lat = Number(c.lat).toFixed(6); lng = Number(c.lng).toFixed(6);
      }
      this.setData({ tunOn: true, tunLat: lat, tunLng: lng }, () => this._adopt('tune'));
    },

    // ===================== ✎ 坐标 3：手动微调 =====================
    //   ⭐ 进微调**先停采点**（否则 GPS 回调会把拖好的位置又冲掉）
    //   ⭐⭐ 关键：**不覆盖已定下的 tunLat** —— 它留在原地不动；拖动只改 tunCand*（候选），
    //        直到点「✓ 采用微调」才把候选落定。
    startTune() {
      const d = this.data;
      // 视野要"对准"的那个点：已定下的微调点 > 北斗卫星 > 手机 > 传进来的客户坐标
      const base = d.tunLat ? { lat: d.tunLat, lng: d.tunLng }
        : d.gpsLat ? { lat: d.gpsLat, lng: d.gpsLng }
        : d.phoneLat ? { lat: d.phoneLat, lng: d.phoneLng }
        : d.initLat ? { lat: d.initLat, lng: d.initLng } : null;
      if (!base) return api.toast('先取一个位置（手机定位 或 北斗卫星），再微调');
      this.stopCapture();
      this.setData({
        mode: 'tuning', tunOn: true, tunDist: '',
        tunCandLat: base.lat, tunCandLng: base.lng,   // 候选初始 = 视野对准的那个点
        mapLat: base.lat, mapLng: base.lng            // 显式把视野对过去（微调中 _mks 不再改中心）
      }, () => this._mks());
    },
    cancelTune() {
      // 退出微调、放弃**这次**调整（⚠️ 已定下的 tunLat 留着不动）
      this.setData({ mode: 'idle', tunCandLat: '', tunCandLng: '', tunDist: '' }, () => this._mks());
    },
    // 微调时拖动地图 → 只更新"候选"，**不动已定下的 tunLat**
    // ⚠️ 三条纪律：① 优先用事件自带的 centerLocation；② 拿不到就兜底 getCenterLocation；
    //   ③ **只写 tunCand\***，绝不 setData tunLat / lat / mapLat。
    async onRegionChange(e) {
      if (this.data.mode !== 'tuning') return;
      if (e.type && e.type !== 'end') return;
      let c = (e.detail && e.detail.centerLocation) || null;
      if (!c) c = await this._center();            // 兜底：事件没给就用地图 API 取
      if (!c) return;
      if (this.data.mode !== 'tuning') return;     // 等异步期间可能已退出微调
      const lat = Number(c.latitude !== undefined ? c.latitude : c.lat).toFixed(6);
      const lng = Number(c.longitude !== undefined ? c.longitude : c.lng).toFixed(6);
      // "挪了多远"从**起点**算：起点 = 进微调时对准的那个点（tunLat 或 首次候选）
      const from = this.data.tunLat
        ? { lat: this.data.tunLat, lng: this.data.tunLng }
        : (this.data.tunCandLat ? { lat: this.data.tunCandLat, lng: this.data.tunCandLng } : { lat: lat, lng: lng });
      const dm = this._dist(from.lat, from.lng, lat, lng);
      // ⚠️ 只写候选；**也刻意不调 _mks()** —— markers 没变，调它反而有"视野被拉走"的风险
      this.setData({
        tunCandLat: lat, tunCandLng: lng,
        tunDist: dm < 1 ? '就是这里' : (dm < 1000 ? Math.round(dm) + ' 米' : (dm / 1000).toFixed(2) + ' 公里')
      });
    },
    // 两点距离（米，haversine）
    _dist(la1, ln1, la2, ln2) {
      const R = 6371000, rad = x => Number(x) * Math.PI / 180;
      const dLa = rad(la2) - rad(la1), dLn = rad(ln2) - rad(ln1);
      const a = Math.sin(dLa / 2) * Math.sin(dLa / 2) +
        Math.cos(rad(la1)) * Math.cos(rad(la2)) * Math.sin(dLn / 2) * Math.sin(dLn / 2);
      return 2 * R * Math.asin(Math.sqrt(a));
    }
  }
});
