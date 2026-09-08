const api = require('../../utils/api');

Page({
  data: { tasks: [], loading: true },
  onShow() {
    const app = getApp();
    if (!this._revFn) {
      // 注册审核观察员：审核结果变化时静默刷新（15 秒被动感知）
      this._revFn = (list) => { if (this._shown) this.load(); };
      app.registerReviewListener(this._revFn);
    }
    this._shown = true;
    const u = app.globalData.user;
    if (!u || u.role !== 'salesman') {
      wx.redirectTo({ url: '/pages/login/login' });
      return;
    }
    this.load();
  },
  onHide() {
    this._shown = false;
    if (this._revFn) { getApp().unregisterReviewListener(this._revFn); this._revFn = null; }
  },
  async load() {
    this.setData({ loading: true });
    try {
      const res = await api.call('tasks', { action: 'list' });
      if (res.ok) {
        const fmtDeadline = s => {
          const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
          return m ? `${parseInt(m[2], 10)}月${parseInt(m[3], 10)}日` : (s || '—');
        };
        this.setData({ tasks: (res.tasks || []).map(t => ({ ...t, deadline: fmtDeadline(t.deadline) })) });
        // 有审核中任务：启动全局审核观察员
        if ((res.tasks || []).some(t => t.status === 'reviewing')) getApp().startReviewWatcher();
      } else {
        api.toast(res.msg || '加载失败');
      }
    } catch (e) {
      api.toast('任务加载失败，请确认已部署 tasks');
    }
    this.setData({ loading: false });
  },
  goTask(e) {
    wx.navigateTo({ url: `/pages/task/task?taskId=${e.currentTarget.dataset.id}` });
  }
});
