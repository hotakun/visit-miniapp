// pages/notes/notes.js —— 「我的记事」列表（2026-09-28 老板定：只存本机）
// 入口：① 客户详情页「我的记事 · N 条」（带 customerId 过滤 → 只看这一家）
//      ② 我的页 / 首页「记事」快捷入口（看全部）
Page({
  // 2026-09-11 老板定：能分享的页面统一走 utils/share.js（path 带分享者 _id → 记录推荐人）
  onShareAppMessage() { return require('../../utils/share').cfg(); },

  data: { list: [], cid: '', cname: '' },

  onLoad(q) {
    // ⚠️ 2026-09-28 修 bug：从客户页带过来的店名走 URL，**必须解码**（否则过滤条显示成 %E8%83%A1…）
    const notes = require('../../utils/notes');
    this.setData({
      cid: notes.qs(q && (q.customerId || q.id)) || '',
      cname: notes.qs(q && q.customerName) || ''
    });
  },
  // 每次回到本页都重读本机数据（编辑页保存后返回即时刷新）
  onShow() { this.refresh(); },

  refresh() {
    const notes = require('../../utils/notes');
    const src = this.data.cid ? notes.byCustomer(this.data.cid) : notes.all();
    const list = src.map(n => ({
      id: n.id,
      title: n.title || '（无标题）',
      x: n.body || '',
      cust: n.customerName || '',
      at: notes.fmtTime(n.at),
      addr: n.addr || '',
      vn: (n.audios || []).length,
      photos: (n.photos || []).map(p => p.path).slice(0, 3)   // 列表最多露 3 张
    }));
    this.setData({ list });
  },

  clearFilter() { this.setData({ cid: '', cname: '' }, () => this.refresh()); },

  // ⭐ 2026-09-28 晚补：列表页自己的「＋ 记一笔」——
  //   不关联客户也能随手记；若本页是从客户页进来的（有 cid），新建时自动带上那家。
  goNew() {
    const q = this.data.cid
      ? ('?customerId=' + this.data.cid + '&customerName=' + encodeURIComponent(this.data.cname || ''))
      : '';
    wx.navigateTo({ url: '/pages/notes/editor/editor' + q });
  },

  open(e) {
    wx.navigateTo({ url: '/pages/notes/editor/editor?id=' + e.currentTarget.dataset.id });
  }
});
