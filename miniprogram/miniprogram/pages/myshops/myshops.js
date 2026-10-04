// pages/myshops/myshops.js —— 我新加的店（2026-09-29 新增）
//   「我的」页 → 「我的记事」下面进来。
//   只列**我自己**提交的现场录入（source:'field'）。
//   ⚠️ 2026-10-03 更正：卡片胶囊**固定显示「新店采集」**，不再拿 mallPending 二值判断。
//      原因：mallPending 的 false 有两种来源（真导入商城表比对上了 / 被旧的"手工已建档"点掉），
//      后者从没对上商城却会被显示成"已对上商城"（老板实测报障）。
//      "是否已对上商城"看 customerType==='mall' / mallKey（老板后台的事，不摆给业务员）。
//   ⭐ 点卡片 → 「加新店」页**预填编辑**（newshop.js 认 ?id= 就走编辑模式，提交时调 updateNewShop）
const api = require('../../utils/api');

const PAGE = 20;

// 时间戳 → 「今天 14:32」/「9月28日 14:32」/「2025年9月28日 14:32」
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const now = new Date();
  const p2 = n => (n < 10 ? '0' + n : '' + n);
  const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return '今天 ' + hm;
  const md = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() === now.getFullYear() ? md : (d.getFullYear() + '年' + md);
}

Page({
  onShareAppMessage() { return require('../../utils/share').cfg(); },

  data: {
    list: [], total: 0, hasMore: false,
    loaded: false, loadingMore: false
  },

  onLoad() { this._busy = false; this.load(true); },
  // ⚠️ 从「加新店」编辑页返回时要刷新 —— 改完的内容得立刻反映到列表上
  onShow() { if (this._needRefresh) { this._needRefresh = false; this.load(true); } },

  async load(first) {
    if (this._busy) return;
    this._busy = true;
    const skip = first ? 0 : (this.data.list || []).length;
    if (!first) this.setData({ loadingMore: true });
    try {
      const r = await api.call('tasks', { action: 'myNewShops', skip: skip, size: PAGE });
      if (!r || !r.ok) throw new Error((r && r.msg) || '加载失败');
      const add = (r.list || []).map(x => Object.assign({}, x, {
        timeText: fmtTime(x.createdAt),
        addrLine: [x.area, x.bizCircle, x.address].filter(Boolean).join(' · ')
      }));
      this.setData({
        list: first ? add : (this.data.list || []).concat(add),
        total: r.total || 0,
        hasMore: !!r.hasMore,
        loaded: true, loadingMore: false
      });
    } catch (e) {
      this.setData({ loaded: true, loadingMore: false });
      api.toast((e && e.message) || '加载失败，请重试');
    }
    this._busy = false;
  },
  loadMore() { if (this.data.hasMore) this.load(false); },

  // ⭐ 2026-10-02 老板定：底部大按钮「＋ 加新店」→ 进建店表单（新建，不带 ?id=）
  goAdd() {
    this._needRefresh = true;                      // 建完回来要刷新列表
    wx.navigateTo({ url: '/pages/newshop/newshop' });
  },

  // 点卡片 → 「加新店」页预填编辑
  openShop(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    this._needRefresh = true;                      // 从编辑页回来时刷新
    wx.navigateTo({ url: '/pages/newshop/newshop?id=' + id });
  },

  // ⭐ 2026-10-02 老板定：卡片右边的「开始拜访」→ 直接进拜访页（**无任务拜访 / 自由拜访**）
  //   背景：这家店是现场录入的、**不属于任何任务** → 走 visits 的"自由拜访"分支（taskId 传空）。
  //   ⚠️ 拜访页是从 storage 的 `curCustomer` 取客户信息的（与其它入口一致），所以这里先写 storage。
  goVisit(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    const it = (this.data.list || []).filter(x => x.id === id)[0];
    if (!it) return;
    if (!it.lng || !it.lat) { api.toast('这家店还没有坐标：先去编辑页定个位置'); return; }
    wx.setStorageSync('curCustomer', {
      _id: it.id,
      name: it.name || '',
      address: it.address || '',
      lng: it.lng, lat: it.lat,
      taskId: '',                                  // ⭐ 空 = 自由拜访（不属于任何任务）
      freeVisit: true
    });
    this._needRefresh = true;                      // 拜访完回来刷新一下
    wx.navigateTo({ url: '/pages/visit/visit' });
  }
});
