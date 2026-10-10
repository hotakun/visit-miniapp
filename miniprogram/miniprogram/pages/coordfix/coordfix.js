// 坐标报错 · 整屏取点页（⭐ 2026-10-07 新建）
// ---------------------------------------------------------------------------
// 老板 2026-10-07 定的「更好的办法」：报错取点从"页面内大半屏弹层"改成**独立整屏页** ——
//   弹层只有 86% 高度，里面还得排标题/说明/状态行/三行来源/三排按钮/原因/按钮，
//   留给地图只剩 190px 左右，拖地图微调根本对不准（老板原话「卡片太小了，操作实在不方便」）。
//   整屏后取点区跟「加新店」第 1 步一样敞亮。
//
// 分工：
//   · 取点 = components/locpick/（与加新店第 1 步**同一套** UI；`pages/newshop/` 一行未动）
//   · 本页 = 进来带客户现有坐标 → 取新点 → 填原因（可不填）→ 提交 → 返回
//   · 云端 coordfix **一个字没改**：本来就收 { customerId, lat, lng, note, photos }
//     （photos 固定传空数组 —— 现场照片这一档 2026-10-07 已按老板要求去掉）
//   ⚠️ 老板模式 = 云端模拟成功**不落库**（后台收不到、铃铛不响、语音不播）—— 与「地图修正」同一条规矩。
const api = require('../../utils/api');

Page({
  onShareAppMessage() { return require('../../utils/share').cfg(); },

  data: {
    initLat: '', initLng: '',   // 客户现有坐标（组件的地图起点；⚠️ 不预置"已采用"，要用户自己点）
    note: '',
    picked: false,              // 用户在组件里"采用"过一个点没有（只影响按钮观感）
    busy: false,
    kb: 0                       // 键盘高度（px）：弹起时把底部抬起，免得输入框被键盘挡住
  },

  onLoad(q) {
    const cid = (q && q.customerId) || '';
    this._cid = cid;
    this._pick = null;
    this.setData({
      initLat: (q && q.lat) || '',
      initLng: (q && q.lng) || ''
    });
    if (!cid) {
      // 正常进不来（入口一定带 cid）；真缺了就给一句人话 + 退回上一页，别让页面卡着
      api.toast('缺少客户参数');
      setTimeout(() => wx.navigateBack(), 900);
    }
    // ⚠️ 键盘弹起时把底部整块抬起来（老板 2026-10-07 真机反馈：
    //   "点输入框时键盘挡住了文字框，看不到自己输入的内容"）。
    //   根因：本页是 `height:100vh` 的固定布局，**页面本身不可滚动** →
    //   微信默认的"输入框自动顶起"（adjust-position）没有可滚动余量，顶不动它。
    //   做法：自己监听键盘高度，给 .foot 加 margin-bottom → .geo-wrap(flex:1) 被压缩，
    //   输入框始终露在键盘上方；地图同步缩小一点，符合直觉。
    //   ⚠️ 配套：wxml 里把 input 的 adjust-position 关掉 —— 微信那套和这套同时顶会让位置不确定。
    if (wx.onKeyboardHeightChange) {
      this._kbOn = (res) => {
        const h = Math.max(0, Number((res && res.height) || 0));
        if (h !== this.data.kb) this.setData({ kb: h });   // 只在变化时 setData，别每帧都刷
      };
      wx.onKeyboardHeightChange(this._kbOn);
    }
  },

  onUnload() {
    // ⚠️ onKeyboardHeightChange 是**全局**监听：离开页面必须摘掉，否则切走后还会往已销毁的页面 setData
    if (this._kbOn && wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._kbOn);
    this._kbOn = null;
  },

  // 组件里点了「✓ 采用…」→ 收下这个点（提交时报它）
  onPickAdopt(e) {
    const p = (e && e.detail) || null;
    if (!p || !p.lat || !p.lng) return;
    this._pick = { lat: p.lat, lng: p.lng, src: p.src };
    this.setData({ picked: true });
  },

  onNote(e) { this.setData({ note: e.detail.value }); },

  // 「取消返回」按钮（⭐ 2026-10-07 老板定：底部要「取消返回 / 提交报错」两个按钮）
  //   —— 与系统导航栏的返回箭头是同一件事，两个入口都留（老板要按得到）
  cancel() { wx.navigateBack(); },

  async submit() {
    if (this.data.busy) return;
    const cid = this._cid;
    const pick = this._pick;
    if (!cid) { api.toast('缺少客户参数'); return; }
    if (!pick || !pick.lat || !pick.lng) { api.toast('先取一个位置，再点对应的「✓ 采用」'); return; }
    this.setData({ busy: true });
    wx.showLoading({ title: '提交中…', mask: true });
    try {
      const res = await api.call('coordfix', {
        customerId: cid,
        lat: pick.lat,
        lng: pick.lng,
        note: String(this.data.note || '').trim().slice(0, 100),
        photos: []                       // ⚠️ 现场照片这一档 2026-10-07 已去掉（老板定）
      });
      wx.hideLoading();
      this.setData({ busy: false });
      if (!res || !res.ok) { api.toast((res && res.msg) || '提交失败，请稍后再试'); return; }
      api.toast(res.msg || '已提交，等待管理员审核', 'success');
      setTimeout(() => wx.navigateBack(), 600);     // 让提示先看得见，再退回客户详情页
    } catch (err) {
      // 🔴 铁律：原始异常只进控制台，给用户看人话（2026-10-04 老板点名）
      console.error('[coordfix] 坐标报错提交失败', err);
      wx.hideLoading();
      this.setData({ busy: false });
      api.toast('提交失败，请到店门口重试');
    }
  }
});
