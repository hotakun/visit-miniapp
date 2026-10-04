// 自由拜访卡片页（2026-10-03）
//   · 列自己的自由拜访卡（最新在前）；点卡片 → 看这趟「去过的店」（去重）
//   · 「🗺 打开地图」进地图页（带 tripId，回来后去向/去过判断都按这张卡算）
//   · 已结束的卡可「▶ 继续用」（可重复用）
//   · ⭐ 「已拜访的店」底部也留「🗺 继续跑店」—— 否则退两步才能接着跑（老板 2026-10-03 指出）
const api = require('../../utils/api');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

Page({
  data: {
    list: [],        // 卡片列表
    cur: null,       // 当前打开的那张卡（null = 显示列表）
    customers: []    // 这张卡去过的店（去重）
  },

  onShow() {
    // 从地图页拜访回来时要刷新家数，所以放 onShow
    if (!this.data.cur) this.load();
    else this.reloadCur();
  },

  load() {
    wx.showLoading({ title: '加载…', mask: false });
    api.call('tasks', { action: 'freeTripList', limit: 50 }).then(r => {
      wx.hideLoading();
      if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '加载失败', icon: 'none' }); return; }
      const list = (r.list || []).map(t => Object.assign({}, t, {
        areaText: [t.district, t.bizCircle].filter(Boolean).join(' · ') || '未划分商圈',
        timeText: fmtTime(t.createdAt)
      }));
      this.setData({ list: list });
    }).catch(e => {
      wx.hideLoading();
      console.error('[自由拜访] 加载失败', e);
      wx.showToast({ title: '加载失败，请稍后再试', icon: 'none' });
    });
  },

  reloadCur() {
    const c = this.data.cur;
    if (!c) return;
    // ⚠️ 2026-10-04【对抗性检查修】原来这里还调了一次 this.load() →
    //   onShow 一次刷两个接口（重复请求）。列表由 onShow 的 load() 负责，这里只管客户列表。
    api.call('tasks', { action: 'freeTripDetail', tripId: c.id }).then(r => {
      if (!r || !r.ok) return;
      this.setData({ customers: r.customers || [] });
    }).catch(() => {});
  },

  // 🗺 打开地图（带 tripId：让地图知道"当前跟的是哪张卡"）
  goMap() {
    const id = this.data.cur ? this.data.cur.id : '';
    wx.navigateTo({ url: '/pages/freevisit/map' + (id ? ('?tripId=' + id) : '') });
  },

  // 点卡片 → 看这趟去过的店
  openCard(e) {
    const id = e.currentTarget.dataset.id;
    const t = (this.data.list || []).find(x => x.id === id);
    if (!t) return;
    wx.showLoading({ title: '加载…', mask: false });
    api.call('tasks', { action: 'freeTripDetail', tripId: id }).then(r => {
      wx.hideLoading();
      if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '加载失败', icon: 'none' }); return; }
      this.setData({ cur: t, customers: r.customers || [] });
    }).catch(() => { wx.hideLoading(); });
  },

  backList() { this.setData({ cur: null, customers: [] }); },

  // 点某家店 → 客户详情（带 freeTripId，后续拜访归属这张卡）
  openCust(e) {
    const id = e.currentTarget.dataset.id;
    const c = (this.data.customers || []).find(x => x.id === id);
    if (!c) return;
    wx.setStorageSync('curCustomer', {
      _id: c.id, name: c.name, address: c.address || '',
      lat: Number(c.lat) || 0, lng: Number(c.lng) || 0,
      taskId: '', freeTripId: (this.data.cur || {}).id || ''
    });
    wx.navigateTo({ url: '/pages/customer/customer' });
  },

  // ⏹ 结束这张卡（老板 2026-10-03 定：能结束也能唤醒；「结束」= 暂时收工，不是作废）
  //   ⚠️ 2026-10-04 对抗性检查补：原来只做了「继续用」，**没有结束入口** → 卡永远关不掉
  onPause(e) {
    const id = e.currentTarget.dataset.id;
    const t = (this.data.list || []).find(x => x.id === id);
    if (!t) return;
    wx.showModal({
      title: "结束这张卡",
      content: "结束后这张卡不再收新的拜访（已拜访的店照旧保留）。以后还能「▶ 继续用」。\n\n确定结束吗？",
      confirmText: "结束",
      success: (res) => {
        if (!res.confirm) return;
        api.call("tasks", { action: "freeTripPause", tripId: id }).then(r => {
          if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || "结束失败", icon: "none" }); return; }
          wx.showToast({ title: "已结束 · 还能再唤醒", icon: "none" });
          this.load();
        }).catch(() => {});
      }
    });
  },

  // ▶ 继续用（唤醒已结束的卡）
  onResume(e) {
    const id = e.currentTarget.dataset.id;
    api.call('tasks', { action: 'freeTripResume', tripId: id }).then(r => {
      if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '唤醒失败', icon: 'none' }); return; }
      wx.showToast({ title: '已继续使用这张卡', icon: 'none' });
      this.load();
    }).catch(() => {});
  },

  // 🗑 删除这张卡（⭐ 2026-10-04 老板要的：结束旁边加删除）
  //   ⚠️ 与后台同口径：**只删归类**，已拜访的记录保留（变成无任务拜访）
  onDelete(e) {
    const id = e.currentTarget.dataset.id;
    const t = (this.data.list || []).find(x => x.id === id);
    const n = t ? (t.visitedCount || 0) : 0;
    wx.showModal({
      title: '删除这张卡',
      content: '已拜访的 ' + n + ' 家店会保留（变成无任务拜访记录），只是这张卡不见了。\n\n确定删除吗？',
      confirmText: '删除',
      confirmColor: '#C93A40',
      success: (res) => {
        if (!res.confirm) return;
        api.call('tasks', { action: 'freeTripDelete', tripId: id }).then(r => {
          if (!r || !r.ok) { wx.showToast({ title: (r && r.msg) || '删除失败', icon: 'none' }); return; }
          wx.showToast({ title: '已删除', icon: 'none' });
          this.load();
        }).catch(err => {
          console.error('[自由拜访] 删卡失败', err);
          wx.showToast({ title: '删除失败，请稍后再试', icon: 'none' });
        });
      }
    });
  }
});
