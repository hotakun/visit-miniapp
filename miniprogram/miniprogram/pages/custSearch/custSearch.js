const api = require('../../utils/api');

Page({
  data: { kw: '', rows: [], loading: false, searched: false, err: '' },

  onInput(e) {
    this.setData({ kw: e.detail.value });
  },

  onSearch() {
    const kw = String(this.data.kw || '').trim();
    if (!kw) {
      this.setData({ rows: [], searched: true, err: '请输入店名 / 编号 / 手机号 / 地址' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true, err: '' });
    api.call('tasks', 'searchCust', { kw }).then(res => {
      if (!res || !res.ok) {
        this.setData({ loading: false, searched: true, rows: [], err: (res && res.msg) || '搜索失败' });
        return;
      }
      this.setData({ loading: false, searched: true, rows: res.rows || [] });
    }).catch(() => {
      this.setData({ loading: false, searched: true, rows: [], err: '搜索失败，请重试' });
    });
  },

  open(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    // 🔴 铁律：客户详情页的身份只认 URL 的 ?id=，这里必须带上。
    wx.navigateTo({ url: '/pages/customer/customer?id=' + encodeURIComponent(id) });
  }
});
