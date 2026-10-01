// pages/notes/editor/editor.js —— 记事详情 / 编辑（2026-09-28 老板定：**只存本机**）
// ---------------------------------------------------------------------------
// 入口：① 客户详情页「快速记事」→ ?customerId=xx&customerName=yy（新建，标题自动带店名）
//      ② 我的记事列表点一条 → ?id=xx（查看 / 修改）
// 上云的**只有一样**：你点了「🎙 转文字」的那一段录音（转完即删云端文件，文字留在本机）。
// ⚠️ 写数据的是 utils/notes.js（本机数据层）；照片/录音落 wx.env.USER_DATA_PATH（约 200MB 额度）。
// ⚠️ 布局口径（老板 2026-09-28 拍板，照 _scratch/记事-演示.html）：**添加入口全部收在最底一排工具栏**，
//    卡片只负责展示已有内容 —— 所以本页的「拍照 / 录音 / 定位 / 设提醒」都从底部工具栏进来。
// ---------------------------------------------------------------------------
const api = require('../../../utils/api');
const loc = require('../../../utils/loc');
const media = require('../../../utils/media');
const notes = require('../../../utils/notes');

const TOTAL_MAX_SEC = 1800;   // 录音合计 30 分钟硬封顶（与拜访页同口径，老板定）
const MAX_SEGS = 6;           // 最多 6 段（与拜访页同口径）
const RM_DAYS = 60;           // 提醒：日期列给未来 60 天
const RM_MIN_STEP = 15;       // 提醒：分钟档 15 分钟一档

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 东八区「今天 00:00」的 UTC 时间戳（项目统一口径：时间都按 +8h 算）
function day0UTC8(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// 提醒选择器：日期列（今天起 60 天）+ 小时列（0~23）+ 分钟列（每 15 分钟）
function buildRmRange() {
  const days = [];
  const b = day0UTC8();
  for (let i = 0; i < RM_DAYS; i++) {
    const d = new Date(b + i * 86400000);
    const md = (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日';
    days.push(i === 0 ? ('今天 · ' + md) : (i === 1 ? ('明天 · ' + md) : (i === 2 ? ('后天 · ' + md) : md)));
  }
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(String(h).padStart(2, '0') + ' 点');
  const mins = [];
  for (let m = 0; m < 60; m += RM_MIN_STEP) mins.push(String(m).padStart(2, '0') + ' 分');
  return [days, hours, mins];
}
// [日期序, 小时, 分钟档] → 时间戳（按东八区换算）
function rmAt(v) {
  const i = Number(v[0]) || 0, h = Number(v[1]) || 0, mi = Number(v[2]) || 0;
  return day0UTC8() + i * 86400000 + h * 3600000 + mi * RM_MIN_STEP * 60000 - 8 * 3600 * 1000;
}
// 时间戳 → 选择器下标（打开已有记事时把提醒时间还原到三列上）
function rmIdxOf(at) {
  if (!at) return [1, 9, 0];
  const d = new Date(at + 8 * 3600 * 1000);
  const di = Math.round((day0UTC8(at) - day0UTC8()) / 86400000);
  return [
    Math.max(0, Math.min(RM_DAYS - 1, di)),
    Math.max(0, Math.min(23, d.getUTCHours())),
    Math.max(0, Math.min(60 / RM_MIN_STEP - 1, Math.round(d.getUTCMinutes() / RM_MIN_STEP)))
  ];
}

Page({
  // 2026-09-11 老板定：能分享的页面统一走 utils/share.js（path 带分享者 _id → 记录推荐人）
  onShareAppMessage() { return require('../../../utils/share').cfg(); },

  data: {
    isNew: true, id: '', at: 0,
    title: '', body: '',
    custId: '', custName: '',
    photos: [], audios: [],
    lat: 0, lng: 0, addr: '', locText: '', locBusy: false, prepBusy: false,
    maxPics: 9, maxSegs: MAX_SEGS, photoFull: false,
    segLimitMin: 5, segMaxSec: 300,
    recState: 'idle', curText: '00:00', recLeftText: '', recPlayId: '', recBusy: false,
    trBusy: false,
    rmRange: [[], [], []], rmIdx: [1, 9, 0], remind: null, remindText: '',
    saving: false
  },

  onLoad(q) {
    const q2 = q || {};
    // 照片 / 录音上限跟后台档位走（sysCfg 由任务详情写入；没进过任务页就用云端同一套默认值 —— 与拜访页同一个兜底）
    const cfg = (getApp().globalData && getApp().globalData.sysCfg) || {};
    // 照片：记事页按老板口径**固定三格相框**（跟客户详情页一样）→ 上限取 3
    //（后台档位若设得更大，这里也只给 3 格；老板 2026-09-28 定）
    const plRaw = [3, 6, 9, 15].includes(Number(cfg.photoLimit)) ? Number(cfg.photoLimit) : 9;
    const pl = Math.min(3, plRaw);
    const segSec = media.recLimit(Number(cfg.recordingDurationLimit) || 300);
    const base = {
      maxPics: pl, segMaxSec: segSec, segLimitMin: Math.max(3, Math.round(segSec / 60)),
      rmRange: buildRmRange()
    };

    if (q2.id) {
      const n = notes.get(q2.id);
      if (!n) { api.toast('这条记事不在了'); wx.navigateBack(); return; }
      const audios = (n.audios || []).map(a => ({
        id: a.id || ('r' + Math.random().toString(36).slice(2, 7)),
        path: a.path || '', ext: a.ext || '.mp3', sec: Number(a.sec) || 0,
        durText: media.fmtSec(Number(a.sec) || 0),
        trText: a.text || '', trStatus: a.text ? 'done' : ''
      }));
      this.setData(Object.assign(base, {
        isNew: false, id: n.id, at: n.at || 0,
        title: n.title || '', body: n.body || '',
        custId: n.customerId || '', custName: n.customerName || '',
        photos: n.photos || [], audios,
        photoFull: (n.photos || []).length >= pl,
        lat: Number(n.lat) || 0, lng: Number(n.lng) || 0, addr: n.addr || '',
        locText: (n.lat && n.lng) ? (Number(n.lat).toFixed(6) + ', ' + Number(n.lng).toFixed(6)) : '',
        remind: n.remind || null,
        remindText: n.remind ? notes.fmtTime(n.remind.at) : '',
        rmIdx: n.remind ? rmIdxOf(n.remind.at) : [1, 9, 0]
      }));
    } else {
      // ⚠️ 2026-09-28 修 bug：客户页「快速记事」把店名放在 URL 里带过来，**必须解码**
      //   （不解码就显示成 %E8%83%A1%E8%AE%B0… 那种"乱码"—— 老板报的就是这个）。
      //   客户 id 兜底：URL 没带就从上一页塞的 storage `curCustomer` 取（与客户页同一套兜底）。
      const cc = wx.getStorageSync('curCustomer') || {};
      const cid = notes.qs(q2.customerId) || cc._id || '';
      const cname = notes.qs(q2.customerName) || cc.name || '';
      const d = notes.draft({ customerId: cid, customerName: cname });
      this.setData(Object.assign(base, {
        isNew: true, id: d.id, at: d.at,
        title: d.title, custId: d.customerId, custName: d.customerName
      }));
    }
    this.recorder = media.createRecorder();   // 页面级录音器（串行录制，多段）
    this.locateNow();                          // 进页面自动定位一次（演示稿：位置进来时自动带）
  },

  onUnload() {
    this._dead = true;
    this._stopRecTicker();
    try { if (this.recorder) { this.recorder.stopPlay(); if (this.data.recState === 'rec') this.recorder.stop(); } } catch (e) { /* 静默 */ }
    media.stopPath();
  },

  // ---------- 关联客户：回客户页 ----------
  // ⭐ 2026-09-28 修 bug（老板报"点回客户没反应"）：原来 `if (!cid) return;` 是**静默什么都不做**。
  //   现在三级兜底，保证**点了一定有反应**：
  //     ① 页面栈里还有那家客户页 → 直接退回去（从客户页进来的常见路径，最自然）；
  //     ② 没有 → 用 id 新开一页客户详情；
  //     ③ 连 id 都没有 → 至少退一页，绝不装死。
  goCustomer() {
    const cid = this.data.custId;
    const pages = getCurrentPages();
    for (let i = pages.length - 2; i >= 0; i--) {     // 从上一页往前找（跳过自己）
      if (pages[i].route === 'pages/customer/customer') {
        wx.navigateBack({ delta: pages.length - 1 - i });
        return;
      }
    }
    if (cid) { wx.navigateTo({ url: '/pages/customer/customer?id=' + cid }); return; }
    wx.navigateBack({ delta: 1, fail: () => api.toast('请从客户列表重进') });
  },

  // ---------- 文字 ----------
  onTitle(e) { this.setData({ title: e.detail.value }); },
  onBody(e) { this.setData({ body: e.detail.value }); },

  // ---------- 📷 照片（点相框 → 拍照 / 从相册选 → 压缩 → 落到本机用户目录；记下当时坐标）----------
  // ⚠️ 2026-09-28 晚老板定：**点相框要能拍照，也要能进相册**。
  //   实现上**不靠** `sourceType:['camera','album']` —— 微信各版本/机型行为不一致
  //   （有时弹"拍照/从相册选择"，有时直接跳相册；微信分身环境还只认一个来源）。
  //   这里改用小程序自带的来源菜单，行为稳定可预期。
  shootOrPick() {
    if (this.data.prepBusy) return;
    if (this.data.photos.length >= this.data.maxPics) { api.toast('最多 ' + this.data.maxPics + ' 张照片'); return; }
    wx.showActionSheet({
      itemList: ['拍照', '从相册选'],
      success: (r) => {
        if (r.tapIndex === 0) this._takeOne();
        else if (r.tapIndex === 1) this.pickPhoto();
      },
      fail: () => { /* 用户取消：不提示 */ }
    });
  },
  // 拍一张（拍完直接入列，不连拍 —— 想多拍就再点一次相框）
  async _takeOne() {
    let files;
    try { files = await media.chooseImage(1, ['camera']); } catch (e) { return; }
    if (!files || !files.length || this._dead) return;
    await this._addPics(files);
  },
  async pickPhoto() {
    if (this.data.prepBusy) return;
    const left = this.data.maxPics - this.data.photos.length;
    if (left <= 0) { api.toast('最多 ' + this.data.maxPics + ' 张照片'); return; }
    let files;
    try { files = await media.chooseImage(left, ['album']); } catch (e) { return; }
    if (!files || !files.length) return;
    await this._addPics(files);
  },
  async _addPics(files) {
    this.setData({ prepBusy: true });
    const photos = [...this.data.photos];
    let failed = 0;
    for (const f of files) {
      if (photos.length >= this.data.maxPics) break;
      try {
        const r = await media.prepPhoto(f.tempFilePath);
        // 一定要「拷进用户目录」——prepPhoto 给的是临时文件，重启就没了
        const saved = notes.saveLocal(r.orig.path, '.jpg') || r.orig.path;
        photos.push({
          id: 'p' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
          path: saved, at: Date.now(), lat: this.data.lat || 0, lng: this.data.lng || 0
        });
      } catch (e) { failed++; }
    }
    this.setData({ photos, photoFull: photos.length >= this.data.maxPics, prepBusy: false });
    if (failed) api.toast(failed + ' 张处理失败');
  },
  previewPhoto(e) {
    wx.previewImage({ urls: this.data.photos.map(p => p.path), current: e.currentTarget.dataset.src });
  },
  delPhoto(e) {
    const id = e.currentTarget.dataset.id;
    const p = this.data.photos.find(x => x.id === id);
    if (p) notes.delLocal(p.path);          // 本机文件一起清（不占额度）
    const photos = this.data.photos.filter(x => x.id !== id);
    this.setData({ photos, photoFull: photos.length >= this.data.maxPics });
  },

  // ---------- 🎙 录音（底部工具栏「🎙 录音」；多段串行；单条跟后台档位；合计 30 分钟）----------
  onRecTap() {
    if (this.data.recState === 'rec') this.stopRec();
    else this.startRec();
  },
  startRec() {
    if (this.data.recState === 'rec' || this.data.recBusy) return;
    const audios = this.data.audios || [];
    if (audios.length >= MAX_SEGS) { api.toast('最多 ' + MAX_SEGS + ' 段录音'); return; }
    const used = audios.reduce((s, a) => s + (Number(a.sec) || 0), 0);
    const leftTotal = TOTAL_MAX_SEC - used;
    if (leftTotal <= 5) { api.toast('录音合计已满 30 分钟'); return; }
    const limit = Math.min(this.data.segMaxSec, leftTotal);
    this._recLimit = limit;
    this._recSecs = 0;
    this.setData({ recState: 'rec', curText: '00:00', recLeftText: '剩余 ' + media.fmtSec(limit) });
    this.recorder.start(limit, () => {}, (p, dur) => this.onRecDone(p, dur), m => { if (!this._dead) api.toast(m); });
    this._startRecTicker(limit);
  },
  _startRecTicker(limit) {
    clearInterval(this._recTicker);
    this._recTicker = setInterval(() => {
      if (this._dead) return;
      this._recSecs++;
      const left = Math.max(0, limit - this._recSecs);
      this.setData({ curText: media.fmtSec(this._recSecs), recLeftText: '剩余 ' + media.fmtSec(left) });
      if (this._recSecs >= limit) this.recorder.stopAtLimit();   // 到档位自动停
    }, 1000);
  },
  _stopRecTicker() { if (this._recTicker) { clearInterval(this._recTicker); this._recTicker = null; } },
  stopRec() { this._stopRecTicker(); this.recorder.stop(); },
  // 录完一段：立刻拷进用户目录（临时文件重启即失效），再入列
  async onRecDone(path, dur) {
    if (this._dead || !path) return;
    this._stopRecTicker();
    const secs = Math.max(1, Math.round(dur || this._recSecs));
    const ext = this.recorder.uploadExt;      // iOS=.m4a / 安卓鸿蒙=.mp3
    this.setData({ recState: 'idle', recBusy: true, curText: '00:00', recLeftText: '' });
    let up = path;
    try { const p = await this.recorder.getUploadPath(); if (p) up = p; } catch (e) { /* 转存失败：退回原路径 */ }
    const local = notes.saveLocal(up, ext) || up;
    if (this._dead) return;
    const audios = [...this.data.audios];
    audios.push({
      id: 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      path: local, ext, sec: secs, durText: media.fmtSec(secs), trText: '', trStatus: ''
    });
    this.setData({ audios, recBusy: false });
  },
  playRec(e) {
    const id = e.currentTarget.dataset.i;
    const it = (this.data.audios || [])[Number(id)];
    if (!it || !it.path) return;
    if (this.data.recPlayId === it.id) { media.stopPath(); this.setData({ recPlayId: '' }); return; }
    media.playPath(it.path, () => { if (!this._dead) this.setData({ recPlayId: '' }); });
    this.setData({ recPlayId: it.id });
  },
  delRec(e) {
    const idx = Number(e.currentTarget.dataset.i);
    const it = (this.data.audios || [])[idx];
    if (!it) return;
    media.stopPath();
    notes.delLocal(it.path);
    const audios = [...this.data.audios];
    audios.splice(idx, 1);
    this.setData({ audios, recPlayId: '' });
  },
  // 「🎙 转文字」：**只把这一段**上传云存储 → transcribe 提交识别 → 轮询取文字 → 删云端文件
  //   （老板口径：其余一切留在本机，只有点了转文字的这一段会上云）
  async transcribe(e) {
    if (this.data.trBusy) return;
    const idx = Number(e.currentTarget.dataset.i);
    const a = (this.data.audios || [])[idx];
    if (!a || !a.path) return;
    if (a.trStatus === 'processing') { api.toast('正在转写中…'); return; }
    const setSeg = (patch) => {
      const audios = [...this.data.audios];
      if (!audios[idx]) return;
      audios[idx] = Object.assign({}, audios[idx], patch);
      this.setData({ audios });
    };
    this.setData({ trBusy: true });
    setSeg({ trStatus: 'processing', trText: '正在转写…（约 1~3 分钟）' });
    let fileID = '';
    try {
      fileID = await media.uploadFile(a.path, a.ext || '.mp3');
      const res = await api.call('transcribe', {
        action: 'start', fileIDs: [{ fileID, duration: Number(a.sec) || 0 }], customerId: this.data.custId
      });
      if (res && res.ok && res.boss) {   // 老板模式：云端虚拟成功，给演示文字
        setSeg({ trStatus: 'done', trText: '（老板模式演示：真机会出真文字）' });
        return;
      }
      if (!res || !res.ok) throw new Error((res && res.msg) || '提交失败');
      const tid = ((res.segs || [])[0] || {}).transcriptId || '';
      if (!tid) throw new Error('提交失败');
      let text = '';
      for (let i = 0; i < 12; i++) {
        await sleep(4000);
        if (this._dead) return;
        const r = await api.call('transcribe', { action: 'poll', transcriptIds: [tid] });
        const one = ((r && r.list) || []).find(x => x._id === tid);
        if (one && one.status === 'done') { text = one.text || ''; break; }
        if (one && one.status === 'failed') throw new Error(one.errorMsg || '识别失败');
      }
      if (!text) throw new Error('识别超时，稍后再试');
      setSeg({ trStatus: 'done', trText: text });
      api.toast('转写完成', 'success');
    } catch (err) {
      setSeg({ trStatus: 'failed', trText: (err && err.message) || '转写失败' });
      api.toast((err && err.message) || '转写失败');
    } finally {
      this.setData({ trBusy: false });
      // 老板口径：转完就把云端那段录音删掉（文字已经在本机了）
      if (fileID) { try { wx.cloud.deleteFile({ fileList: [fileID] }); } catch (e) { /* 静默 */ } }
    }
  },

  // ---------- 📍 位置（底部工具栏「📍 位置」；进页面也会自动定位一次）----------
  locateNow() {
    if (this.data.locBusy) return;
    this.setData({ locBusy: true });
    loc.getOne(8000).then(p => {
      if (this._dead) return;
      if (!p || !p.lat) { this.setData({ locBusy: false }); api.toast('定位失败，可稍后重试'); return; }
      const acc = p.accuracy ? (' · 精度 ±' + Math.round(p.accuracy) + ' 米') : '';
      this.setData({
        lat: p.lat, lng: p.lng, locBusy: false,
        locText: Number(p.lat).toFixed(6) + ', ' + Number(p.lng).toFixed(6) + acc
      });
    }).catch(() => { if (!this._dead) { this.setData({ locBusy: false }); api.toast('定位失败，可稍后重试'); } });
  },

  // ---------- ⏰ 提醒（底部工具栏「⏰ 提醒」→ 三列选择器 → 写手机系统日历，纯本地不上云）----------
  // multiSelector 必须处理 columnchange：列一动就记下，否则 value 不同步、选完拿到的是旧下标
  onRmCol(e) {
    const i = Number(e.detail.column), v = Number(e.detail.value);
    const rmIdx = [...this.data.rmIdx];
    rmIdx[i] = v;
    this.setData({ rmIdx });
  },
  onRmPick(e) {
    const v = (e.detail.value || []).map(Number);
    const at = rmAt(v);
    if (!at || at <= Date.now()) { api.toast('提醒时间要晚于现在'); return; }
    this.setData({ rmIdx: v });
    this.setRemindAt(at);
  },
  setRemindAt(at) {
    const text = (this.data.title || this.data.custName || '记事提醒').slice(0, 20);
    const done = () => { this.setData({ remind: { at, text }, remindText: notes.fmtTime(at) }); };
    wx.addPhoneCalendar({
      title: text,
      description: (this.data.body || '').slice(0, 60),
      startTime: Math.floor(at / 1000),
      allDay: false, alarm: true, alarmOffset: 0,
      success: () => { done(); api.toast('已写入系统日历', 'success'); },
      // ⚠️ 小程序的日历接口要在 app.json 的 requiredPrivateInfos 里声明、且需提审 —— 没声明就会走这里
      fail: () => { done(); api.toast('已记下提醒时间（写日历需开通权限）'); }
    });
  },
  clearRemind() { this.setData({ remind: null, remindText: '', rmIdx: [1, 9, 0] }); },

  // ---------- 保存 / 删除（都只动本机）----------
  save() {
    if (this.data.saving) return;
    const title = (this.data.title || '').trim();
    const body = (this.data.body || '').trim();
    const { photos, audios } = this.data;
    if (!title && !body && !photos.length && !audios.length) { api.toast('写点什么再保存'); return; }
    this.setData({ saving: true });
    const note = {
      id: this.data.id, at: this.data.at,
      title, body,
      customerId: this.data.custId, customerName: this.data.custName,
      photos: photos.map(p => ({ path: p.path, at: p.at || 0, lat: p.lat || 0, lng: p.lng || 0 })),
      audios: audios.map(a => ({
        path: a.path, ext: a.ext || '.mp3', sec: Number(a.sec) || 0,
        text: a.trStatus === 'done' && a.trText ? a.trText : ''      // 转好了才随记事一起留（其余留在本机音频里）
      })),
      lat: Number(this.data.lat) || 0, lng: Number(this.data.lng) || 0, addr: this.data.addr || '',
      remind: this.data.remind || null
    };
    const r = notes.save(note);
    this.setData({ saving: false });
    if (!r) { api.toast('保存失败：内容太多了'); return; }
    api.toast('已保存', 'success');
    setTimeout(() => { if (!this._dead) wx.navigateBack(); }, 600);
  },
  askRemove() {
    wx.showModal({
      title: '删除这条记事', content: '删除后不可恢复（本机的照片、录音一起删掉）',
      confirmText: '删除', confirmColor: '#E5484D',
      success: (r) => {
        if (!r.confirm) return;
        notes.remove(this.data.id);
        api.toast('已删除');
        setTimeout(() => { if (!this._dead) wx.navigateBack(); }, 400);
      }
    });
  }
});
