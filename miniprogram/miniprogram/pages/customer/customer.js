const api = require('../../utils/api');
const loc = require('../../utils/loc');
const media = require('../../utils/media');

// YYYY-MM-DD → "X 天前"（0=今天；无效返回 ''）
function daysAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).replace(/-/g, '/') + ' 00:00:00');
  if (isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  return days > 0 ? days + ' 天前' : '今天';
}

Page({
  data: { c: null, history: [], evPlay: '', evCurMs: 0, evCurText: '00:00', typeName: 'mall', coordConfirmShow: false, coordNewText: '', coordDistLine1: '', coordDistLine2: '', coordNote: '', coordQuality: '', coordRefreshing: false, coordCooldown: 0, coordSpinChar: '◐', coordPics: [], coordPicBusy: false },
  onShow() {
    const c = wx.getStorageSync('curCustomer');
    if (!c) { api.toast('客户信息丢失'); wx.navigateBack(); return; }
    // 游客（实习账号）：店家电话后四位打码（2026-09-08 老板定）
    const trial = api.isTrialUser();
    this.setData({
      c: {
        ...c,
        lastOrderAgo: daysAgo(c.lastOrderAt),
        lastBrowseAgo: daysAgo(c.lastBrowseAt),
        phoneShow: trial ? api.maskTrialPhone(c.phone) : c.phone,
        phone2Show: trial ? api.maskTrialPhone(c.phone2) : c.phone2
      },
      typeName: c.customerType === 'new' ? 'new' : 'mall',
      isTrial: trial
    });
    this.loadHistory(c._id);
    this.refreshOngoing(c._id, c.taskId); // 开始拜访/取消/提交后按钮底色要实时正确
  },
  onUnload() {
    clearInterval(this._spinTimer);
    clearInterval(this._cdTimer);
    if (this._audio) { this._audio.destroy(); this._audio = null; }
  },
  // 拜访中状态云端刷新（静默；失败保持本地快照值）
  async refreshOngoing(customerId, taskId) {
    if (!taskId) return;
    try {
      const res = await api.call('tasks', { action: 'detail', taskId });
      if (!res.ok) return;
      const found = (res.customers || []).find(x => x._id === customerId);
      if (found) {
        this.setData({
          'c.visitOngoing': !!found.visitOngoing,
          'c.visitedToday': !!found.visitedToday
        });
      }
    } catch (e) { /* 静默：保持 storage 快照值 */ }
  },
  async loadHistory(customerId) {
    try {
      const res = await api.call('visits', { action: 'history', customerId });
      if (!res.ok) return;
      const raw = res.visits || [];
      const visits = raw.map(v => {
        // 前端双保险：把时长统一成数字并预先算好分钟数（不足 1 分钟按 1 分钟向上取整），
        // 避免旧数据 durationSeconds 为 undefined/字符串导致显示异常
        const sec = Math.max(0, parseInt(v.durationSeconds, 10) || 0);
        // 历史卡日期去掉年份（2026-09-08 老板定）：2026-09-08 → 9月8日（与任务页天页签同一风格）
        const dm = String(v.visitedAt || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
        const dateMD = dm ? `${parseInt(dm[2], 10)}月${parseInt(dm[3], 10)}日` : (v.visitedAt || '');
        return { ...v, durationSeconds: sec, mins: sec > 0 ? Math.ceil(sec / 60) : 0, dateMD };
      });
      // 现场证据（2026-09-07）：批量换临时链接（thumb 缩略展示 / orig 大图 / audio 播放），失败静默降级不显示
      const need = [];
      raw.forEach(v => {
        (v.photos || []).forEach(p => { if (p.thumbID) need.push(p.thumbID); if (p.fileID) need.push(p.fileID); });
        // 2026-09-11 M2b：多段录音（audios）全部换链接，兼容旧 audio 单段
        const as = Array.isArray(v.audios) && v.audios.length ? v.audios : (v.audio ? [v.audio] : []);
        as.forEach(a => { if (a && a.fileID) need.push(a.fileID); });
      });
      let urls = {};
      if (need.length) {
        try { urls = await media.getTempURLs([...new Set(need)]); } catch (e) { /* 链接换取失败：历史照常显示无证据区 */ }
      }
      const withEv = visits.map(v => {
        const photos = (v.photos || []).filter(p => p && urls[p.thumbID]);
        // 2026-09-11 M2b 小步：语音转写摘要（去掉换行，截 60 字）与全文
        const trText = (v.transcribe && v.transcribe.text) || '';
        // 2026-09-11 M2b：多段录音列表（逐段独立试听；播放 key = visitId#段号 → 天然互斥）
        const audRaw = Array.isArray(v.audios) && v.audios.length ? v.audios : (v.audio ? [v.audio] : []);
        const audList = audRaw.filter(a => a && a.fileID && urls[a.fileID]).map((a, i) => {
          const sec = Math.max(0, Math.round(Number(a.duration) || 0));
          return {
            key: v._id + '#' + i,
            label: audRaw.length > 1 ? ('录音 ' + (i + 1)) : '录音',
            url: urls[a.fileID],
            text: media.fmtSec(sec),
            durMs: Math.max(1, sec * 1000),
            on: a.transcribe !== false // 是否参与转写（未勾选只留档）
          };
        });
        return {
          ...v,
          evPhotos: photos.map(p => ({ t: urls[p.thumbID], o: urls[p.fileID] || '' })),
          // 2026-09-11 老板定：历史卡只显示前 3 张；点任意一张 → 全屏左右滑看全部
          evShow: photos.slice(0, 3).map(p => ({ t: urls[p.thumbID], o: urls[p.fileID] || '' })),
          evMore: photos.length > 3 ? photos.length : 0,
          evListJson: JSON.stringify(photos.map(p => urls[p.fileID]).filter(Boolean)),
          audList,
          audioUrl: v.audio && v.audio.fileID ? (urls[v.audio.fileID] || '') : '', // 兼容旧模板
          audioText: v.audio && v.audio.duration ? media.fmtSec(v.audio.duration) : '',
          audioDurMs: v.audio && v.audio.duration ? Math.round(Number(v.audio.duration) * 1000) : 0,
          tr: v.transcribe || null,
          trPrev: trText ? trText.replace(/\s+/g, ' ').slice(0, 60) : ''
        };
      });
      this.setData({ history: withEv });
    } catch (e) { /* 历史加载失败不阻断 */ }
  },
  // 语音转写全文（2026-09-11 M2b 小步）：点文字打开页内弹层（项目铁律：不用 wx.showModal）
  openTr(e) {
    const i = Number(e.currentTarget.dataset.i);
    const it = (this.data.history || [])[i];
    if (!it || !it.tr || !it.tr.text) return;
    const title = `${it.dateMD || ''}${it.timeHM ? ' ' + it.timeHM : ''}${it.salesmanName ? ' · ' + it.salesmanName : ''}`;
    this.setData({
      trShow: true, trTitle: title, trText: it.tr.text,
      trVisitId: it._id, trEdited: !!it.tr.edited, trEditing: false, trDraft: it.tr.text
    });
  },
  // 2026-09-11 老板定：转写文字可人工修订（改错别字）—— 员工可改自己的，老板/管理员可改全部
  editTr() { this.setData({ trEditing: true, trDraft: this.data.trText || '' }); },
  cancelTrEdit() { this.setData({ trEditing: false }); },
  onTrDraft(e) { this.setData({ trDraft: e.detail.value }); },
  async saveTr() {
    if (this.trSaving) return;
    const visitId = this.data.trVisitId;
    const text = String(this.data.trDraft || '').trim();
    if (!visitId) return;
    this.trSaving = true;
    wx.showLoading({ title: '保存中…', mask: true });
    try {
      const res = await api.call('visits', { action: 'saveTrText', visitId, text });
      wx.hideLoading();
      this.trSaving = false;
      if (res && res.ok) {
        this.setData({ trText: text, trEditing: false, trEdited: true });
        api.toast('已保存 ✓', 'success');
        this.loadHistory(this.data.c._id); // 刷新历史卡摘要
      } else {
        api.toast((res && res.msg) || '保存失败');
      }
    } catch (e) {
      wx.hideLoading();
      this.trSaving = false;
      api.toast('保存失败，请重试');
    }
  },
  closeTr() { this.setData({ trShow: false, trText: '', trEditing: false }); },
  noop() { /* 仅用于 catchtap：阻止弹层内的点击冒泡到遮罩 */ },
  copyTr() {
    const t = this.data.trText || '';
    if (!t) return;
    wx.setClipboardData({
      data: t,
      success: () => api.toast('已复制全文', 'success'),
      fail: () => api.toast('复制失败，请长按选择')
    });
  },
  // 播放/停止历史录音（页面级单 audio；带播放进度控件：▶/⏸ + 可拖进度条 + 时间）
  playEv(e) {
    const { id, url, dur } = e.currentTarget.dataset;
    if (!url) return;
    if (this._evPlayId === id) { this.stopEvAudio(); return; }
    if (!this._audio) {
      this._audio = wx.createInnerAudioContext();
      this._audio.obeyMuteSwitch = false; // 2026-09-08 修复：iOS 静音键打开时播放无声
      this._audio.onEnded(() => this.stopEvAudio());
      this._audio.onError(() => this.stopEvAudio());
      // 播放进度（约 250ms 一次，仅播放中的卡片走 setData）
      this._audio.onTimeUpdate(() => {
        if (this._evPlayId) {
          const ct = Math.floor((this._audio.currentTime || 0) * 1000);
          this.setData({ evCurMs: ct, evCurText: media.fmtSec(Math.round(ct / 1000)) });
        }
      });
    }
    this._evDurTxt = dur || '';
    this._audio.stop();
    this._audio.src = url;
    this._audio.play();
    this._evPlayId = id;
    this.setData({ evPlay: id, evCurMs: 0, evCurText: '00:00' });
  },
  // 拖进度条跳转（松手触发；duration ms）
  onEvSeek(e) {
    const id = e.currentTarget.dataset.id;
    if (this._evPlayId !== id || !this._audio) return;
    const ms = Number(e.detail.value) || 0;
    this._audio.seek(ms / 1000);
    this.setData({ evCurMs: ms, evCurText: media.fmtSec(Math.round(ms / 1000)) });
  },
  stopEvAudio() {
    if (this._audio) this._audio.stop();
    this._evPlayId = '';
    this.setData({ evPlay: '', evCurMs: 0, evCurText: '00:00' });
  },
  // 历史照片点开大图（同次拜访多张可左右滑）
  previewEv(e) {
    let list = [];
    try { list = JSON.parse(e.currentTarget.dataset.list || '[]'); } catch (err) { /* 忽略 */ }
    if (!list.length) return;
    wx.previewImage({ urls: list, current: e.currentTarget.dataset.src || list[0] });
  },
  callPhone(e) {
    if (api.isTrialUser()) { api.toast('游客不能拨打电话'); return; }
    const phone = e.currentTarget.dataset.phone || this.data.c.phone;
    wx.makePhoneCall({ phoneNumber: phone, fail: () => {} });
  },
  reportFix() {
    // 位置报错：立即高精度取点（最多等 2 秒）→ 确认弹窗 → 提交待管理员审核（同意后才更新客户坐标）
    if (this.data.c.coordFixPending) { api.toast('坐标审核中，请等待管理员审核'); return; }
    this.prepCoord();
  },
  // 报错定位准备：点报错立即取一次点，最多等 2 秒弹窗；2 秒未出用缓存值兜底
  async prepCoord() {
    const c = this.data.c;
    let applied = false;
    const apply = (p) => {
      if (applied || !p) return;
      applied = true;
      this.applyCoord(p, p.accuracy != null && p.accuracy > 0 ? `精度 ±${Math.round(p.accuracy)} 米` : '');
    };
    const fresh = loc.getOne(2000).then(p => apply(p)).catch(() => {});
    await Promise.race([fresh, new Promise(r => setTimeout(r, 2000))]);
    if (!applied) {
      const cached = loc.getCached();
      if (cached) apply(cached); // 2 秒未出：用缓存值兜底（无精度信息）
    }
    this.setData({
      coordConfirmShow: true,
      coordNote: '',
      coordRefreshing: false,
      coordCooldown: 0,
      coordPics: [], // 每次报错重新开始（2026-09-08 拍照功能启用：固定三框）
      coordPicBusy: false
    });
  },
  // ===== 坐标报错现场照片（2026-09-08 启用：三框固定，压缩/缩略同拜访页） =====
  addCoordPhoto() {
    if (this.data.coordPicBusy) return;
    const left = 3 - this.data.coordPics.length;
    if (left <= 0) { api.toast('最多 3 张照片'); return; }
    media.chooseImage(left).then(async files => {
      if (!files || !files.length) return;
      this.setData({ coordPicBusy: true });
      const pics = [...this.data.coordPics];
      let failed = 0;
      for (const f of files) {
        try {
          const r = await media.prepPhoto(f.tempFilePath);
          pics.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), orig: r.orig.path, thumb: r.thumb.path, up: false });
        } catch (err) { failed++; }
      }
      this.setData({ coordPics: pics, coordPicBusy: false });
      if (failed) api.toast(failed + ' 张处理失败，请重试');
    }).catch(() => { /* 用户取消 */ });
  },
  delCoordPhoto(e) {
    this.setData({ coordPics: this.data.coordPics.filter(p => p.id !== e.currentTarget.dataset.id) });
  },
  previewCoordPhoto(e) {
    const urls = this.data.coordPics.map(p => p.orig);
    wx.previewImage({ urls, current: e.currentTarget.dataset.src });
  },
  // 应用定位结果：更新报错坐标/距离两行/质量行
  applyCoord(p, quality) {
    const c = this.data.c;
    this._newLoc = { lat: p.lat, lng: p.lng };
    const dist = (c.lat && c.lng) ? haversine(p.lat, p.lng, c.lat, c.lng) : null;
    this.setData({
      coordNewText: `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`, // 手机端报错弹窗：纬度在前（老板 2026-09-06 定）；后台各处仍为经度在前
      coordDistLine1: dist === null ? '该客户暂无原坐标' : '与原坐标相距',
      coordDistLine2: dist === null ? '' : (dist < 1000 ? `约 ${Math.round(dist)} 米` : `约 ${(dist / 1000).toFixed(1)} 公里`),
      coordQuality: quality || ''
    });
  },
  // 报错弹窗 📍 图标：可多次点击做**高精度收敛**（半径 10m / accuracy≤30）；成功刷新坐标+质量行，失败保持原显示+6 秒倒计时
  onCoordRefresh() {
    if (this.data.coordRefreshing || this.data.coordCooldown > 0) return;
    this.setData({ coordRefreshing: true });
    const chars = ['◐', '◓', '◑', '◒'];
    this._spinIdx = 0;
    this._spinTimer = setInterval(() => {
      this._spinIdx = (this._spinIdx + 1) % 4;
      this.setData({ coordSpinChar: chars[this._spinIdx] });
    }, 200);
    loc.calm({ radius: 10, acc: 30, target: 8, maxValid: 12, maxAttempts: 16 }).then(p => {
      loc.setCache(p.lat, p.lng);
      clearInterval(this._spinTimer);
      this.applyCoord(p, `✅ 已精确定位 · 精度 ±${p.accuracy || 10} 米`);
      this.setData({ coordRefreshing: false });
    }).catch(() => {
      /* 不收敛：保持原显示；6 秒冷却倒计时防连点 */
      clearInterval(this._spinTimer);
      this.setData({ coordRefreshing: false, coordCooldown: 6 });
      clearInterval(this._cdTimer);
      this._cdTimer = setInterval(() => {
        const v = this.data.coordCooldown - 1;
        if (v <= 1) {
          clearInterval(this._cdTimer);
          this.setData({ coordCooldown: 0 });
        } else {
          this.setData({ coordCooldown: v });
        }
      }, 1000);
    });
  },
  hideCoordConfirm() { this.setData({ coordConfirmShow: false }); },
  onCoordNote(e) { this.setData({ coordNote: e.detail.value }); },
  async confirmCoordFix() {
    if (!this._newLoc) { this.setData({ coordConfirmShow: false }); return; }
    if (this._coordSubmitting) return;
    // 游客（实习账号）模拟提交（2026-09-08 老板定）：走完弹窗流程，不上传照片、不写后台
    if (api.isTrialUser()) {
      this.setData({ coordConfirmShow: false });
      api.toast('模拟提交成功', 'success');
      return;
    }
    this._coordSubmitting = true;
    try {
      // 0) 现场照片上传（2026-09-08 启用：双轨 {fileID,thumbID}，失败留在弹窗可重试；已传自动复用）
      const pics = this.data.coordPics;
      if (pics.length) {
        wx.showLoading({ title: '上传照片…', mask: true });
        try {
          for (let i = 0; i < pics.length; i++) {
            if (pics[i].up) continue;
            const fileID = await media.uploadFile(pics[i].orig, '.jpg');
            const thumbID = await media.uploadFile(pics[i].thumb, '.jpg');
            pics[i] = { ...pics[i], up: true, fileID, thumbID };
          }
          this.setData({ coordPics: pics });
        } catch (e) {
          wx.hideLoading();
          this._coordSubmitting = false;
          api.toast('照片上传失败，请检查网络后重试');
          return;
        }
        wx.hideLoading();
      }
      const photos = pics.filter(p => p.up).map(p => ({ fileID: p.fileID, thumbID: p.thumbID }));
      wx.showLoading({ title: '提交中…', mask: true });
      const res = await api.call('coordfix', {
        customerId: this.data.c._id,
        lat: this._newLoc.lat,
        lng: this._newLoc.lng,
        note: (this.data.coordNote || '').trim(),
        photos
      });
      wx.hideLoading();
      this._coordSubmitting = false;
      this.setData({ coordConfirmShow: false });
      if (res.ok) {
        api.toast('已提交，管理员审核后更新坐标');
        this.setData({ 'c.coordFixPending': true, coordPics: [] });
      } else {
        api.toast(res.msg || '提交失败');
      }
    } catch (e) {
      wx.hideLoading();
      this._coordSubmitting = false;
      this.setData({ coordConfirmShow: false });
      api.toast('提交失败，请确认已部署 coordfix');
    }
  },
  goVisit() {
    // 点「开始拜访·自动计时」立即定位一次（老板 2026-09-06 定）：写全局缓存供提交弹窗复用；不阻塞跳转
    loc.getOne(8000).then(p => loc.setCache(p.lat, p.lng)).catch(() => { /* 静默 */ });
    wx.navigateTo({ url: '/pages/visit/visit' });
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
