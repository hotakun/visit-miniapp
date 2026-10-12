// ⭐⭐ 2026-10-12 老板定：手机端老板首页「新店」小卡片 → 点进这一页。
//   内容 = **全部新店**（业务员现场录入、还没对上商城的店 = 后台「重点消息·加新店」那一批）。
//   三种排列：① 按日期 ② 按顺序（单独卡片）③ 按商圈；顶部搜索框**只搜这一页内**的店；点卡片进**客户详情页**。
const api = require('../../utils/api.js');
const app = getApp();

Page({
  data: {
    list: [], groups: [], total: 0, loading: true,
    mode: 'date',                     // date | card | circle
    kw: ''
  },

  onLoad() {
    if (!app.globalData.user) { wx.reLaunch({ url: '/pages/login/login' }); return; }
    this.load();
  },
  onPullDownRefresh() { this.load(() => wx.stopPullDownRefresh()); },

  load(cb) {
    this.setData({ loading: true });
    api.call('adminapi', { action: 'listNewShops' }).then(r => {
      this._all = (r && r.shops) || [];
      this.setData({ total: this._all.length, loading: false }, () => this.apply());
      if (cb) cb();
    }).catch(e => {
      this.setData({ loading: false });
      api.toast('加载失败，请下拉重试');
      console.error('[newshops] 加载失败', e);
      if (cb) cb();
    });
  },

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
    if (mode === 'card') {
      groups.push({ title: '', items: list });            // 单独卡片：平铺，不分组（顺序 = 接口给的"新的在前"）
    } else {
      const map = {};
      list.forEach(x => {
        const k = (mode === 'circle') ? (x.bizCircle || '(未知商圈)') : dayCn(x.at);
        (map[k] = map[k] || []).push(x);
      });
      Object.keys(map).forEach(k => groups.push({ title: k, items: map[k] }));
      if (mode === 'date') groups.sort((a, b) => (a.title < b.title ? 1 : -1));   // 日期新的在前
      else groups.sort((a, b) => b.items.length - a.items.length);               // 商圈：家数多的在前
    }
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
function dayCn(at) {
  if (!at) return '(未填日期)';
  const s = String(at).trim();
  let d;
  if (/^\d{10,}$/.test(s)) { const n = Number(s); d = new Date(n > 1e12 ? n : n * 1000); }
  else d = new Date(s.replace(/-/g, '/'));
  if (!d || isNaN(d.getTime())) return '(未填日期)';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}
