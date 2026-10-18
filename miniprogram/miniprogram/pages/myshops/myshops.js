// pages/myshops/myshops.js —— 我新加的店（2026-09-29 新增）
//   「我的」页 → 「我的记事」下面进来；只列**我自己**提交的现场录入（source:'field' + createdBy=我）。
//
// ⭐⭐ 2026-10-15 老板定：「业务员端的新店卡片摆放方式，换成和老板首页的新店卡片页面方式一样，
//   只是业务员端下面多了一个加新店的按钮。」
//   → 本页**整套逻辑照 `pages/newshops/newshops.js` 抄**（本地优先 / 只拉增量 / 点刷新才全量 /
//     搜索 / 按日期·按商圈分组 / 「数据截至」），**只改两处**：
//     ① 数据源 = `tasks.myNewShops`（只看自己建的；老板端是 `listNewShops` 看全部）
//        —— 云函数那边已把返回格式对齐成和 `listNewShops` 一样（含 photos 归一化 / since / maxAt）
//     ② 底部多一个「＋ 加新店」按钮（老板端没有）
//   ⚠️ 缓存键用 `myshopsCache`（**不能**用老板端的 `newshopsCache`，否则两边数据串了）。
//   ⚠️ 改 newshops.js 的逻辑时，记得同步这里（老板要的就是"两边一样"）。
const api = require('../../utils/api.js');
const { dayCn } = require('../../utils/date');
const app = getApp();
const CACHE_KEY = 'myshopsCache';      // 本地缓存：{ shops: [...], maxAt, syncedAt }

Page({
  onShareAppMessage() { return require('../../utils/share').cfg(); },

  data: {
    list: [], groups: [], total: 0, loading: true,
    mode: 'date',                     // date | circle
    kw: '',
    syncedText: '',                   // 「数据截至 10-13 18:12」
    refreshing: false
  },

  onLoad() {
    if (!app.globalData.user) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    // ① 先用本地缓存显示（秒开、0 请求）
    const cache = this._readCache();
    if (cache && cache.shops && cache.shops.length) {
      this._all = cache.shops;
      this._maxAt = Number(cache.maxAt) || 0;
      this.setData({
        total: this._all.length, loading: false, syncedText: this._syncedText(cache.syncedAt)
      }, () => this.apply());
      // ② 后台静默拉新增（只回比水位新的几条）
      this.syncNew(false);
    } else {
      this.syncNew(true);
    }
  },

  // 从「加新店」编辑页返回 / 建完店回来 → 刷新（原来就有这条，别丢）
  onShow() { if (this._needRefresh) { this._needRefresh = false; this.syncNew(true); } },

  onPullDownRefresh() { this.syncNew(true, () => wx.stopPullDownRefresh()); },

  // ===== 本地缓存读写 =====
  _readCache() { try { return wx.getStorageSync(CACHE_KEY) || null; } catch (e) { return null; } },
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
    if (this._busy) { if (cb) cb(); return; }
    this._busy = true;
    if (full) this.setData({ refreshing: true });
    if (!this._all || !this._all.length) this.setData({ loading: true });
    const since = full ? 0 : (this._maxAt || 0);
    // ⚠️ 调 **tasks**（不是 adminapi）—— 后者是「后台账号密码」专属入口，手机端调会被 NO_AUTH 拒掉
    api.call('tasks', { action: 'myNewShops', since: since }).then(r => {
      this._busy = false;
      if (!r || !r.ok) {
        this.setData({ loading: false, refreshing: false });
        if (this._all && this._all.length) api.toast('同步失败，先看本地这份');
        else api.toast('加载失败，请下拉重试');
        if (cb) cb();
        return;
      }
      // ⚠️ 兼容：云函数同时回 `shops`（新）与 `list`（旧）——优先用 shops
      const got = r.shops || r.list || [];
      if (full) {
        this._all = got;                       // 全量：整份替换（回收站删掉的也会跟着没）
      } else {
        const seen = {};
        const merged = (this._all || []).slice();
        merged.forEach(x => { seen[x.id] = 1; });
        got.forEach(x => { if (!seen[x.id]) { merged.push(x); seen[x.id] = 1; } });
        this._all = merged;
      }
      this._all.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));   // 新的在前
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
      console.error('[myshops] 同步失败', e);
      if (!(this._all && this._all.length)) api.toast('加载失败，请下拉重试');
      if (cb) cb();
    });
  },

  // 「🔄 刷新」——只有它整份重拉（与老板端一致）
  onRefresh() { this.syncNew(true); },

  // ★ 搜索 + 分组的总出口
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
    // ⚠️ 分组排序必须按"该组最新一条的时间戳"降序 —— 不能拿中文标题字符串比大小
    //    （老板 2026-10-13 报过："10月7日"会被排到"10月12日"前面）
    Object.keys(map).forEach(k => {
      const items = map[k];
      let mx = 0;
      items.forEach(y => { const t = Number(y.at) || 0; if (t > mx) mx = t; });
      groups.push({ title: k, items: items, maxAt: mx });
    });
    if (mode === 'date') groups.sort((a, b) => b.maxAt - a.maxAt);      // 日期：最近的在最上面
    else groups.sort((a, b) => b.items.length - a.items.length);        // 商圈：家数多的在前
    this.setData({ groups, list });
  },

  onKw(e) { this.setData({ kw: e.detail.value }, () => this.apply()); },
  clearKw() { this.setData({ kw: '' }, () => this.apply()); },
  setMode(e) {
    const m = e.currentTarget.dataset.m;
    if (!m || m === this.data.mode) return;
    this.setData({ mode: m }, () => this.apply());
  },

  // 点卡片 → 客户详情页（与老板端同一个去处；**必须带 ?id=**）
  //   ⚠️ 带 freeVisit=1：告诉详情页"这是无任务的自由拜访"，详情页据此清掉 storage 里可能残留的 taskId。
  openShop(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this._needRefresh = true;                          // 从详情页加照片/更正信息回来要刷新
    wx.navigateTo({ url: '/pages/customer/customer?id=' + id + '&freeVisit=1' });
  },

  // ⭐ 老板要求：业务员端底部多这个按钮 → 进建店表单（新建，不带 ?id=）
  goAdd() {
    this._needRefresh = true;                          // 建完回来要刷新列表
    wx.navigateTo({ url: '/pages/newshop/newshop' });
  }
});

// 时间戳 / 日期串 → '10月12日'（分组标题用；认不出来给"未填日期"）

