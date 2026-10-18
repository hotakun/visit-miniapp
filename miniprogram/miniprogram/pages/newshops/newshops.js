// ⭐⭐ 2026-10-12 老板定：手机端老板首页「新店」小卡片 → 点进这一页。
//   内容 = 全部新店（业务员现场录入、还没对上商城的店 = 后台「重点消息·加新店」那一批）。
//
// ⭐⭐ 2026-10-13 老板定（本页改成**本地优先**，省流量、省云开发额度）：
//   · **新店信息存本地**（wx.setStorageSync）→ 再打开这一页**秒开**，先把本地那份显示出来；
//   · **平时只从云端拉"新增的"**（把本地最新一条的时间当"水位"传给云端 `since`，云端只回比它新的几条）；
//   · **只有点「🔄 刷新」才整份重拉**（全量对齐 —— 后台把某条删进回收站了，也会跟着消失）；
//   · 顶部按钮三个：**按日期 / 按商圈 / 🔄 刷新**（原来的"按顺序"取消，老板 2026-10-13 定）；
//   · 顶部显示「数据截至 MM-DD HH:mm」= 本地这份数据是什么时候同步的（缓存的铁律：必须让人知道数据时间）。
//   点卡片 → 客户详情页（**必须带 ?id=**，页面身份只认 URL 那条铁律）。
const api = require('../../utils/api.js');
const { dayCn } = require('../../utils/date');
const app = getApp();
const CACHE_KEY = 'newshopsCache';     // 本地缓存：{ shops: [...], maxAt, syncedAt }

Page({
  data: {
    list: [], groups: [], total: 0, loading: true,
    mode: 'date',                     // date | circle（原来的 card"按顺序"已按老板要求去掉）
    kw: '',
    syncedText: '',                   // 「数据截至 10-13 18:12」
    refreshing: false
  },

  onLoad() {
    if (!app.globalData.user) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    // ① 先用**本地缓存**显示（秒开、0 请求）
    const cache = this._readCache();
    if (cache && cache.shops && cache.shops.length) {
      this._all = cache.shops;
      this._maxAt = Number(cache.maxAt) || 0;
      this.setData({
        total: this._all.length, loading: false, syncedText: this._syncedText(cache.syncedAt)
      }, () => this.apply());
      // ② 后台**静默拉新增**（只回比水位新的几条），不打扰已显示的列表
      this.syncNew(false);
    } else {
      // 首次装/缓存被清 → 拉全量
      this.syncNew(true);
    }
  },

  // 下拉刷新 = 与「🔄 刷新」同一个动作（全量对齐）
  onPullDownRefresh() { this.syncNew(true, () => wx.stopPullDownRefresh()); },

  // ===== 本地缓存读写 =====
  _readCache() {
    try { return wx.getStorageSync(CACHE_KEY) || null; } catch (e) { return null; }
  },
  _writeCache(shops, maxAt) {
    try { wx.setStorageSync(CACHE_KEY, { shops: shops, maxAt: maxAt, syncedAt: Date.now() }); } catch (e) { /* 存不下不影响看 */ }
  },
  _syncedText(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '';
    const p = n => (n < 10 ? '0' + n : '' + n);
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  },

  // ===== 同步：full=false 只拉新增（平时）／full=true 全量（点刷新、首次）=====
  syncNew(full, cb) {
    if (this._busy) { if (cb) cb(); return; }        // 防连点
    this._busy = true;
    if (full) this.setData({ refreshing: true });
    if (!this._all || !this._all.length) this.setData({ loading: true });
    const since = full ? 0 : (this._maxAt || 0);
    // ⚠️ 调 **tasks**（不是 adminapi）—— 后者是「后台账号密码」专属入口，手机端调会被 NO_AUTH 拒掉
    api.call('tasks', { action: 'listNewShops', since: since }).then(r => {
      this._busy = false;
      if (!r || !r.ok) {
        this.setData({ loading: false, refreshing: false });
        if (this._all && this._all.length) api.toast('同步失败，先看本地这份');
        else api.toast('加载失败，请下拉重试');
        if (cb) cb();
        return;
      }
      const got = r.shops || [];
      if (full) {
        this._all = got;                                        // 全量：整份替换（回收站删掉的也会跟着没）
      } else {
        const seen = {};
        const merged = (this._all || []).slice();
        merged.forEach(x => { seen[x.id] = 1; });
        got.forEach(x => { if (!seen[x.id]) { merged.push(x); seen[x.id] = 1; } });
        this._all = merged;
      }
      this._all.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));   // 新的在前
      // 水位 = 本地最新一条的时间（只进不退；云端给的 maxAt 更大就用云端的）
      let maxAt = Number(this._maxAt) || 0;
      this._all.forEach(x => { const t = Number(x.at) || 0; if (t > maxAt) maxAt = t; });
      if (Number(r.maxAt) > maxAt) maxAt = Number(r.maxAt);
      if (full) maxAt = Number(r.maxAt) || maxAt;
      this._maxAt = maxAt;
      this._writeCache(this._all, maxAt);
      this.setData({
        total: this._all.length, loading: false, refreshing: false,
        syncedText: this._syncedText(r.syncedAt || Date.now())
      }, () => this.apply());
      if (cb) cb();
    }).catch(e => {
      this._busy = false;
      this.setData({ loading: false, refreshing: false });
      console.error('[newshops] 同步失败', e);
      if (!(this._all && this._all.length)) api.toast('加载失败，请下拉重试');
      if (cb) cb();
    });
  },

  // 「🔄 刷新」——**只有它**会整份重拉（老板 2026-10-13 定）
  onRefresh() { this.syncNew(true); },

  // ★ 搜索 + 分组的总出口（改搜索词 / 改排列方式都走它）
  apply() {
    const kw = String(this.data.kw || '').trim().toLowerCase();
    let list = this._all || [];
    if (kw) {
      list = list.filter(x =>
        String(x.name || '').toLowerCase().indexOf(kw) >= 0 ||
        String(x.address || '').toLowerCase().indexOf(kw) >= 0 ||
        String(x.phone || '').indexOf(kw) >= 0 ||
        String(x.bizCircle || '').toLowerCase().indexOf(kw) >= 0);
    }
    const mode = this.data.mode;
    const groups = [];
    const map = {};
    list.forEach(x => {
      const k = (mode === 'circle') ? (x.bizCircle || '(未知商圈)') : dayCn(x.at);
      (map[k] = map[k] || []).push(x);
    });
    // ⭐⭐ 2026-10-13 修（老板报「10月7号怎么排到最前面了？按照最近在最上面的原则排列天数」）：
    //   ⚠️ 原来拿**分组标题字符串**比大小（`a.title < b.title`）—— 中文 "10月7日" vs "10月12日"，
    //      逐字比是先比 `10月`、再比 `7` 与 `1` → **"7" > "1" → 10月7日被排到了 10月12日前面**
    //      （同理 12月 与 1月 跨年也会错）。
    //   ✅ 现在按**该组最新一条的时间戳**降序排 —— 才是真正的"最近的在最上面"。
    Object.keys(map).forEach(k => {
      const items = map[k];
      let mx = 0;
      items.forEach(y => { const t = Number(y.at) || 0; if (t > mx) mx = t; });
      groups.push({ title: k, items: items, maxAt: mx });
    });
    if (mode === 'date') groups.sort((a, b) => b.maxAt - a.maxAt);             // 日期：最近的在最上面
    else groups.sort((a, b) => b.items.length - a.items.length);               // 商圈：家数多的在前
    this.setData({ groups, list });
  },

  onKw(e) { this.setData({ kw: e.detail.value }, () => this.apply()); },
  clearKw() { this.setData({ kw: '' }, () => this.apply()); },
  setMode(e) {
    const m = e.currentTarget.dataset.m;
    if (!m || m === this.data.mode) return;
    this.setData({ mode: m }, () => this.apply());
  },

  // 点卡片 → 客户详情页（与业务员端「我新加的店」同一个去处）
  openShop(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: '/pages/customer/customer?id=' + id + '&freeVisit=1' });
  }
});

// 时间戳 / 日期串 → '10月12日'（分组标题用；认不出来给"未填日期"）

