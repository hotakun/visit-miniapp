const api = require('../../utils/api');
const loc = require('../../utils/loc');
const media = require('../../utils/media');

const MALL = ['极有意向', '有意向', '已下单', '无需求', '有抵触', '联系不上', '闭店·搬迁', '其他'];
const NEW = [...MALL, '已注册商城'];

// 提交成功话语库（按拜访结果分类，随机取一条，短句 ≤14 字）
// 正面=表扬活跃气氛 / 中性=激励 / 负面=温暖治愈打气
const PRAISE = {
  '极有意向': ['厉害！客户心动了 💪', '漂亮！这单有戏了 🔥', '好兆头！趁热打铁冲！🏃'],
  '有意向': ['不错哦，有苗头了 ✨', '有想法了，趁热打铁！', '有戏！保持跟进就成啦！'],
  '已下单': ['太棒了！真金白银到手 🎉', '成交啦！这一趟值了！', '漂亮！业绩又添一笔 📈'],
  '已注册商城': ['恭喜！又拉进一位新客 🎊', '成功入圈，干得漂亮！', '新客到手，持续跟进哦 🚀'],
  '无需求': ['正常滴，先混个脸熟 😄', '没需求也留了印象，值！', '先结缘，后成交，慢慢来！'],
  '其他': ['记录在案，下次再战！', '辛苦了，稳稳拿下！', '跑一趟就有一趟的收获！'],
  '有抵触': ['没关系，慢慢来，下次更好 🌤', '别灰心，门总会打开的', '冷脸也是信息，你辛苦了！'],
  '联系不上': ['扑空不算白跑，下次逮住他 😉', '缘分未到，改天再来！', '人不在店也在，下次再约！'],
  '闭店·搬迁': ['情况记下了，你辛苦啦 🤗', '又排掉一个雷，功劳不小！', '信息已更新，别白跑啦！']
};

Page({
  data: {
    c: null, resultList: MALL, result: '', text: '', samples: '', timerText: '00:00',
    confirmShow: false, cancelShow: false, blocked: false, blockMsg: '',
    distText: '', durMins: 0, distShow: false, locRefreshing: false, locCooldown: 0, locSpinChar: '◐',
    // 超时（2026-09-08 M1）：上限前 5 分钟预警条
    timeoutWarn: false, timeoutLeftMin: 5,
    // 现场证据（2026-09-07 二期提前做）：照片双轨瓦片 + 录音状态机
    // 2026-09-11 M2b：录音改为【多段】—— ≤5 条 / 单条 ≤10 分钟 / 合计 30 分钟硬封顶；按段勾选转写
    pics: [], prepBusy: false, maxPics: 15, // 现场照片上限（2026-09-11 老板定：3 → 15，支持连拍 + 相册多选）
    recs: [],              // 已录段：[{id, path, ext, sec, text, transcribe, up, fileID, trStatus}]
    recState: 'idle',      // idle | rec（同一时刻只录一段）
    curText: '00:00',      // 本次录制计时
    curSec: 0,
    recLeftText: '',       // 本次剩余可录（倒计时）
    recWarn: false,        // 剩 ≤30 秒：红字加大闪动
    recPlayId: '',         // 正在试听的段 id（互斥）
    recBusy: false,        // 转存/上传处理中
    recCountText: '0/5',   // 段数
    recTotalText: '00:00', // 合计时长
    recLimitMin: 10,       // 单条上限（分钟；由后台档位决定，上限 10）
    segMaxSec: 300,        // 单条上限（秒）初值；onLoad 会按后台「拜访录音上限」档位覆盖（2026-09-11 老板定：跟后台走）
    totalMaxSec: 1800,     // 合计硬封顶（秒）= 30 分钟
    maxSegs: 6,            // 最多 6 段（2026-09-11 老板定：由 5 改为 6）
    trBusy: false,         // 「开始转录」进行中
    trMsg: '',             // 转录状态提示
    delRecShow: false,     // 删除单段：二次确认弹层
    delRecIdx: -1,
    // 2026-09-11 老板定：五个区块【全部】改为可折叠卡片（点标题栏展开收起；独立展开；默认展开）
    foldPic: false,
    foldRec: false,
    foldSamp: false,
    foldText: false,
    foldRes: false,
    evDesc: ''
  },
  onLoad() {
    const c = wx.getStorageSync('curCustomer');
    if (!c) { api.toast('客户信息丢失'); wx.navigateBack(); return; }
    const lim = media.recLimit(Number(c.recordingDurationLimit) || 300); // 单条上限（秒；≤600，iOS 已放开）
    // 拜访时长上限（2026-09-08 M1）：30 分钟/1 小时/2 小时，默认 1 小时
    const vlRaw = Number(c.visitDurationLimit);
    this.vLimit = [1800, 3600, 7200].includes(vlRaw) ? vlRaw : 3600;
    this._warned = false;
    this._timeoutDone = false;
    this.setData({
      c,
      resultList: c.customerType === 'new' ? NEW : MALL,
      recLimitMin: Math.max(3, Math.round(lim / 60)),
      segMaxSec: lim
    });
    // 录音器（页面级单例；串行录制，离开页面即停并丢弃，未提交不上传）
    this.recorder = media.createRecorder();
    this._recSecs = 0;
    this._recTicker = null;
    this._dead = false;
    // 开始拜访：云端校验（任务内单开：其他家还在拜访中会拦截）
    api.call('visits', { action: 'start', taskId: c.taskId, customerId: c._id }).then(res => {
      if (res && res.code === 'ONGOING_OTHERS') {
        // 大弹窗提示（不再用 toast）：停留至用户点击「知道了」，避免一闪而过
        this.setData({ blocked: true, blockMsg: res.msg || '有一家还未完成拜访' });
        return;
      }
      this.beginTimer(c);
    }).catch(() => { this.beginTimer(c); });
  },
  // 单开拦截弹窗「知道了」：返回客户详情页
  goBackFromBlock() {
    wx.navigateBack();
  },
  // 计时基准时间持久化（2026-09-06 老板定）：进入拜访页记一次，切后台/页面重载回来继续沿用，
  // 只有取消拜访或提交成功才清除——显示与提交时长永远基于同一开始时间
  beginTimer(c) {
    const key = 'visitStart_' + c.taskId + '_' + c._id;
    let t0 = wx.getStorageSync(key);
    // 新鲜度校验：超过 24 小时的旧基准作废（防撤回/删除任务后重发，同 key 沿用很早以前的开始时间）
    if (!t0 || (Date.now() - t0) > 24 * 3600 * 1000) {
      t0 = Date.now();
      wx.setStorageSync(key, t0);
    }
    this.t0 = t0;
    this._startKey = key;
    getApp().globalData.visitOngoing = true; // 最新位置上报标记（2026-09-08 M1）
    loc.beacon(); // 状态信标：进入拜访中（2026-09-08 老板定：后台立即感知）
    // 后台定位（2026-09-08 M2）：仅拜访中开启，拒绝不阻断；首次提示一次
    loc.startForeground();
    loc.startBackground().then(ok => {
      if (ok && !wx.getStorageSync('bgLocTip')) {
        wx.setStorageSync('bgLocTip', 1);
        api.toast('拜访期间将后台记录位置轨迹');
      }
    });
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  },
  tick() {
    const s = Math.floor((Date.now() - this.t0) / 1000);
    this.setData({ timerText: String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0') });
    // 超时预警与到点双态（2026-09-08 M1）
    if (!this.vLimit || this._timeoutDone) return;
    const left = this.vLimit - s;
    if (left <= 300 && left > 0 && !this._warned) {
      this._warned = true;
      const m = Math.ceil(left / 60);
      this.setData({ timeoutWarn: true, timeoutLeftMin: m });
      try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* 震动失败忽略 */ }
    } else if (left > 0 && this._warned) {
      const m = Math.ceil(left / 60);
      if (m !== this.data.timeoutLeftMin) this.setData({ timeoutLeftMin: m });
    } else if (left <= 0) {
      this._timeoutDone = true;
      this.onTimeout();
    }
  },
  // 到点本地双态（云端 10 分钟定时触发兜底，幂等不重复）：
  // 已选结果 → 自动提交（跳过距离、无照片录音）；未选 → 自动取消
  async onTimeout() {
    if (this._timeoutBusy) return;
    this._timeoutBusy = true;
    clearInterval(this.timer);
    const c = this.data.c;
    try {
      if (this.data.result) {
        const durationSeconds = Math.floor((Date.now() - this.t0) / 1000);
        const res = await api.call('visits', {
          action: 'submit', taskId: c.taskId, customerId: c._id,
          result: this.data.result, text: this.data.text, samples: this.data.samples,
          durationSeconds, skipLoc: true
        });
        if (!res.ok) { api.toast(res.msg || '超时自动提交失败'); this._timeoutBusy = false; this.timer = setInterval(() => this.tick(), 1000); return; }
        this.clearStart();
        loc.beacon(); // 状态信标：拜访中→已回访（2026-09-08 老板定）
        api.toast('超时已自动提交 ✓');
        setTimeout(() => wx.navigateBack(), 900);
      } else {
        const res = await api.call('visits', { action: 'cancel', taskId: c.taskId, customerId: c._id });
        if (!res.ok) { api.toast(res.msg || '超时自动取消失败'); this._timeoutBusy = false; this.timer = setInterval(() => this.tick(), 1000); return; }
        this.clearStart();
        loc.beacon(); // 状态信标：拜访中→待回访（2026-09-08 老板定）
        api.toast('拜访超时，已自动取消');
        setTimeout(() => wx.navigateBack(), 900);
      }
    } catch (e) {
      this._timeoutBusy = false;
      this.timer = setInterval(() => this.tick(), 1000);
      api.toast('网络异常，稍后将由系统自动处理');
    }
  },
  // 草稿上报（防抖 1.2 秒）：点选结果/输入备注时上报，云端据此超时自动提交
  saveDraftSoon() {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => this.saveDraftNow(), 1200);
  },
  saveDraftNow() {
    const c = this.data.c;
    if (!c || !c.taskId) return;
    api.call('visits', {
      action: 'saveDraft', taskId: c.taskId, customerId: c._id,
      result: this.data.result, text: this.data.text, samples: this.data.samples
    }).catch(() => { /* 静默：下次再报 */ });
  },
  clearStart() {
    if (this._startKey) {
      wx.removeStorageSync(this._startKey);
      this._startKey = null;
    }
    getApp().globalData.visitOngoing = false; // 最新位置上报标记清除（2026-09-08 M1）
    loc.stopBackground(); // 后台定位严格关闭（2026-09-08 M2：提交/取消即停）
  },
  onUnload() {
    this._dead = true;
    clearInterval(this.timer);
    clearInterval(this._spinTimer);
    clearInterval(this._locTimer);
    clearInterval(this._cdTimer);
    if (this._draftTimer) { clearTimeout(this._draftTimer); this._draftTimer = null; }
    // 审查修复：退出前立即补报一次草稿（防最后 1.2 秒内的输入丢失导致超时误判"未选结果"而取消）
    this.saveDraftNow();
    // 离开页面：录音/试听一律停掉丢弃（未提交不上传，符合取消/退出零残留口径）
    this._stopRecTicker();
    media.stopPath(); // 多段试听：停掉独立播放器
    if (this.recorder) {
      this.recorder.stopPlay();
      if (this.data.recState === 'rec') this.recorder.stop();
    }
  },
  // 折叠卡片（2026-09-11 老板定）：点标题栏展开/收起【五个区块】；独立展开、互不影响
  toggleFold(e) {
    const k = e.currentTarget.dataset.k;
    const map = { pic: 'foldPic', rec: 'foldRec', samp: 'foldSamp', text: 'foldText', res: 'foldRes' };
    const key = map[k];
    if (key) this.setData({ [key]: !this.data[key] });
  },
  // ===== 现场证据：照片（2026-09-11 老板定：上限 15 张，支持连拍 + 相册多选） =====
  // 相册多选：一次最多选到剩余额度
  async pickPhoto() {
    if (this.data.prepBusy) return;
    const left = this.data.maxPics - this.data.pics.length;
    if (left <= 0) { api.toast('最多 ' + this.data.maxPics + ' 张现场照片'); return; }
    let files;
    try { files = await media.chooseImage(left, ['album']); } catch (e) { return; }
    if (!files || !files.length) return;
    await this._addPics(files);
  },
  // 连拍：拍一张 → 自动再开相机 → 直到在相机里点返回（取消）或拍满 15 张
  async shootPhoto() {
    if (this.data.prepBusy) return;
    while (this.data.pics.length < this.data.maxPics) {
      let files;
      try { files = await media.chooseImage(1, ['camera']); } catch (e) { return; } // 取消拍照 → 结束连拍
      if (!files || !files.length) return;
      await this._addPics(files);
      if (this._dead) return;
      if (this.data.pics.length >= this.data.maxPics) { api.toast('已拍满 ' + this.data.maxPics + ' 张'); return; }
      // 继续循环 → 自动再次打开相机（连拍体验）
    }
  },
  // 逐张处理（压缩成「原图 + 缩略图」双轨）后追加到列表
  async _addPics(files) {
    this.setData({ prepBusy: true });
    const pics = [...this.data.pics];
    let failed = 0;
    for (const f of files) {
      if (pics.length >= this.data.maxPics) break;
      try {
        const r = await media.prepPhoto(f.tempFilePath);
        pics.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), orig: r.orig.path, thumb: r.thumb.path, up: false });
      } catch (err) { failed++; }
    }
    this.setData({ pics, prepBusy: false });
    if (failed) api.toast(failed + ' 张处理失败，请重试');
  },
  delPhoto(e) {
    this.setData({ pics: this.data.pics.filter(p => p.id !== e.currentTarget.dataset.id) });
  },
  previewPhoto(e) {
    wx.previewImage({ urls: this.data.pics.map(p => p.orig), current: e.currentTarget.dataset.src });
  },

  // ===== 现场录音（2026-09-11 M2b：多段） =====
  // 口径（老板拍板）：≤5 条；单条 ≤10 分钟（由后台档位决定上限）；合计 30 分钟硬封顶（满了不让再录）
  // 微信 RecorderManager 是全局单例 → 串行录制；每段录完立即转存为持久路径再入列，不覆盖
  onRecTap() {
    if (this.data.recState === 'rec') this.stopRec(false);
    else this.startRec();
  },
  _recUsed() {
    return (this.data.recs || []).reduce((s, r) => s + (Number(r.sec) || 0), 0);
  },
  _refreshRecMeta(recs) {
    const total = (recs || []).reduce((s, r) => s + (Number(r.sec) || 0), 0);
    this.setData({ recCountText: (recs || []).length + '/' + this.data.maxSegs, recTotalText: media.fmtSec(total) });
  },
  startRec() {
    if (this.data.recState === 'rec' || this.data.recBusy) return;
    const recs = this.data.recs || [];
    if (recs.length >= this.data.maxSegs) { api.toast('最多 ' + this.data.maxSegs + ' 段录音'); return; }
    const leftTotal = this.data.totalMaxSec - this._recUsed();
    if (leftTotal <= 5) { api.toast('录音合计已达 30 分钟上限，不能再录'); return; }
    // 本次可录上限 = min(后台档位设置的单条上限, 剩余合计) —— 合计 30 分钟硬封顶在此生效
    // 2026-09-11 老板定：单条上限跟后台「拜访录音上限」档位走（后台一改，这里自动跟随；文案也动态显示）
    const segMax = media.recLimit(Number(this.data.c && this.data.c.recordingDurationLimit) || 300);
    const limit = Math.min(segMax, leftTotal);
    this._recLimit = limit;
    this._recSecs = 0;
    this.setData({ recState: 'rec', curText: '00:00', curSec: 0, recWarn: false, recLeftText: '剩余 ' + media.fmtSec(limit), trMsg: '' });
    this.recorder.start(limit, () => {}, (p, dur, auto) => this.onRecDone(p, dur, auto), m => { if (!this._dead) api.toast(m); });
    this._startRecTicker(limit);
  },
  _startRecTicker(limit) {
    clearInterval(this._recTicker);
    this._recTicker = setInterval(() => {
      if (this._dead) return;
      this._recSecs++;
      const left = Math.max(0, limit - this._recSecs);
      this.setData({
        curSec: this._recSecs,
        curText: media.fmtSec(this._recSecs),
        recLeftText: '剩余 ' + media.fmtSec(left),
        recWarn: left <= 30 // 剩 30 秒：红字 + 加大 + 闪动（样式见 wxss）
      });
      if (this._recSecs >= limit) this.recorder.stopAtLimit(); // 到本次上限自动停
    }, 1000);
  },
  _stopRecTicker() { clearInterval(this._recTicker); this._recTicker = null; },
  stopRec(byLimit) {
    this._stopRecTicker();
    if (byLimit) this.recorder.stopAtLimit(); else this.recorder.stop();
  },
  // 录完一段：立即转存为持久路径（saveFile 会移动临时文件 → 试听/上传必须用转存后的路径）
  async onRecDone(path, dur, auto) {
    if (this._recStopResolve) { const r = this._recStopResolve; this._recStopResolve = null; r(); }
    if (this._dead || !path) return;
    this._stopRecTicker();
    const secs = Math.max(1, Math.round(dur || this._recSecs));
    const ext = this.recorder.uploadExt; // iOS=.m4a / 安卓鸿蒙=.mp3（随段记录，防后续格式变化）
    this.setData({ recState: 'idle', recBusy: true, recWarn: false, curText: '00:00', recLeftText: '' });
    let up = path;
    try { const p = await this.recorder.getUploadPath(); if (p) up = p; } catch (e) { /* 转存失败：退回原路径 */ }
    if (this._dead) return;
    const recs = [...(this.data.recs || [])];
    recs.push({
      id: 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
      path: up, ext, sec: secs, text: media.fmtSec(secs),
      transcribe: true, // 默认勾选转写（未勾选只留档不计费）
      up: false, fileID: '', trStatus: ''
    });
    this.setData({ recs, recBusy: false });
    this._refreshRecMeta(recs);
    if (auto) {
      const hitTotal = this._recUsed() >= this.data.totalMaxSec - 5;
      api.toast(hitTotal ? '录音合计已达 30 分钟，已自动停止' : '已达单条上限，录音已自动停止');
    }
  },
  // 试听某一段（共用一颗 InnerAudioContext → 同一时刻只播一条）
  playRec(e) {
    const id = e.currentTarget.dataset.id;
    const it = (this.data.recs || []).find(r => r.id === id);
    if (!it || !it.path) return;
    if (this.data.recPlayId === id) {
      media.stopPath();
      this.setData({ recPlayId: '' });
      return;
    }
    media.playPath(it.path, () => { if (!this._dead) this.setData({ recPlayId: '' }); });
    this.setData({ recPlayId: id });
  },
  // 删除某一段（老板定：二次确认，防误删）
  askDelRec(e) {
    const idx = Number(e.currentTarget.dataset.i);
    if (!(this.data.recs || [])[idx]) return;
    media.stopPath();
    this.setData({ delRecShow: true, delRecIdx: idx, recPlayId: '' });
  },
  hideDelRec() { this.setData({ delRecShow: false, delRecIdx: -1 }); },
  doDelRec() {
    const idx = this.data.delRecIdx;
    const recs = [...(this.data.recs || [])];
    this.setData({ delRecShow: false, delRecIdx: -1 });
    if (idx < 0 || !recs[idx]) return;
    recs.splice(idx, 1);
    this.setData({ recs });
    this._refreshRecMeta(recs);
    api.toast('已删除该段录音');
  },
  // 勾选 / 取消某段「参与转写」
  toggleRecTr(e) {
    const idx = Number(e.currentTarget.dataset.i);
    const recs = [...(this.data.recs || [])];
    if (!recs[idx]) return;
    recs[idx] = { ...recs[idx], transcribe: !recs[idx].transcribe };
    this.setData({ recs });
  },
  // 「开始转录」（老板定：按下 = 上传 + 转写勾选的段；可提前看结果）
  // 提交拜访时还会对「勾选但尚未提交转写」的段兜底一次
  async startTranscribe() {
    if (this.data.trBusy) return;
    if (this.data.recState === 'rec') { api.toast('请先停止录音'); return; }
    const recs = this.data.recs || [];
    if (!recs.length) { api.toast('还没有录音'); return; }
    if (!recs.filter(r => r.transcribe).length) { api.toast('没有勾选任何录音段'); return; }
    this.setData({ trBusy: true, trMsg: '上传录音中…' });
    try {
      const all = await this.uploadAudios();
      const fileIDs = all.filter(r => r.transcribe && r.fileID).map(r => ({ fileID: r.fileID, duration: r.sec }));
      if (!fileIDs.length) { this.setData({ trBusy: false, trMsg: '' }); api.toast('录音上传失败，请重试'); return; }
      this.setData({ trMsg: '提交识别…' });
      const res = await api.call('transcribe', {
        action: 'start',
        fileIDs,
        taskId: this.data.c.taskId,
        customerId: this.data.c._id
      });
      if (res && res.ok) {
        // 标记已提交的段（提交拜访时只对"未提交"的段兜底，不重复计费）
        const marked = (this.data.recs || []).map(r => (r.transcribe && r.fileID && !r.trStatus) ? { ...r, trStatus: 'processing' } : r);
        this.setData({ recs: marked, trBusy: false, trMsg: '已提交转写，等 1~3 分钟可在客户详情看文字' });
        api.toast('已提交转写 ✓', 'success');
      } else {
        this.setData({ trBusy: false, trMsg: '' });
        api.toast((res && res.msg) || '提交转写失败');
      }
    } catch (e) {
      this.setData({ trBusy: false, trMsg: '' });
      api.toast('提交转写失败，请重试');
    }
  },

  // 拜访记录页（重要定位页面）：按后台「重要页面刷新」档位刷定位（默认 15 秒，2026-09-06 老板定），
  // 写全局缓存供提交弹窗复用；进入页面启动、退出/切后台停止
  onShow() {
    this.locateNow();
    clearInterval(this._locTimer);
    const sec = (this.data.c && this.data.c.locKeyRefresh) || 15;
    this._locTimer = setInterval(() => this.locateNow(), sec * 1000);
  },
  onHide() {
    clearInterval(this._locTimer);
  },
  locateNow() {
    if (this.data.locRefreshing) return; // 收敛精确定位进行中：避免并发定位请求
    loc.getOne(8000).then(p => loc.setCache(p.lat, p.lng)).catch(() => { /* 静默 */ });
  },
  pickResult(e) { this.setData({ result: e.currentTarget.dataset.r }); this.saveDraftSoon(); },
  onText(e) { this.setData({ text: e.detail.value }); this.saveDraftSoon(); },
  onSamples(e) { this.setData({ samples: e.detail.value }); this.saveDraftSoon(); },

  // 第 1 步：点提交立即刷新一次定位，最多等 2 秒出结果再弹窗；2 秒未出也弹窗（用缓存值）；晚到的新鲜结果自动更新弹窗
  async submit() {
    if (this.submitting) return;
    if (!this.data.result) {
      api.toast('请先选择拜访结果');
      return;
    }
    // 游客（实习账号）模拟提交（2026-09-08 老板定）：走完整流程但不写任何数据；
    // 清理云端 ongoing 防后台残留"拜访中"，提示「模拟提交成功」
    if (api.isTrialUser()) {
      this.submitting = true;
      try { await api.call('visits', { action: 'cancel', taskId: this.data.c.taskId, customerId: this.data.c._id }); } catch (e) { /* 静默 */ }
      this.clearStart();
      this.submitting = false;
      api.toast('模拟提交成功', 'success');
      setTimeout(() => wx.navigateBack(), 900);
      return;
    }
    const durationSeconds = Math.floor((Date.now() - this.t0) / 1000);
    const c = this.data.c;
    let locP = loc.getCached() || {};
    let distText = this.fmtDist(locP.lat, locP.lng, c);
    let applied = false; // 新鲜定位结果只应用一次
    const apply = (p) => {
      if (applied || !p) return;
      applied = true;
      loc.setCache(p.lat, p.lng);
      locP = { lat: p.lat, lng: p.lng };
      this.pendingLoc = locP;
      const nt = this.fmtDist(p.lat, p.lng, c);
      if (this.data.confirmShow && !this.data.locRefreshing) this.setData({ distText: nt });
      distText = nt;
    };
    // 立即刷新一次（防并发由 loc.getOne 单飞保证；失败静默用缓存值）
    const fresh = loc.getOne(2000).then(p => apply(p)).catch(() => {});
    // 最多等 2 秒：结果先到就带新距离弹窗，否则到点直接弹窗
    await Promise.race([fresh, new Promise(r => setTimeout(r, 2000))]);
    this.pendingLoc = locP;
    this.setData({
      confirmShow: true,
      distText,
      distShow: true, // 无坐标客户也显示距离行（显示 —）
      locRefreshing: false,
      locCooldown: 0,
      durMins: Math.max(1, Math.ceil(durationSeconds / 60)),
      pendingSeconds: durationSeconds,
      evDesc: this.evDesc()
    });
  },
  // 提交弹窗证据清单文案：📷 N 张 · 🎙️ N 段 合计 mm:ss（无证据返回空串不显示行）
  evDesc() {
    const n = this.data.pics.length;
    const recs = this.data.recs || [];
    if (!n && !recs.length) return '';
    const parts = [];
    if (n) parts.push('📷 ' + n + ' 张');
    if (recs.length) parts.push('🎙️ ' + recs.length + ' 段 ' + this.data.recTotalText);
    return parts.join(' · ');
  },
  // 距离文案：客户无坐标 → '—'
  fmtDist(lat, lng, c) {
    if (!lat || !lng || !c || !c.lat || !c.lng) return '—';
    const d = haversine(lat, lng, c.lat, c.lng);
    return '距客户 ' + (d < 1000 ? Math.round(d) + ' 米' : (d / 1000).toFixed(1) + ' 公里');
  },
  // 距离行左侧图标：可多次点击 → 收敛精确定位；成功刷新距离+恢复图标；失败保持原显示 + 6 秒倒计时冷却
  onLocRefresh() {
    if (this.data.locRefreshing || this.data.locCooldown > 0) return;
    this.setData({ locRefreshing: true });
    // 收敛约 3~6 秒：图标轮换字符转圈（JS 驱动，设备上 CSS 动画曾失效，勿用）
    const chars = ['◐', '◓', '◑', '◒'];
    this._spinIdx = 0;
    this._spinTimer = setInterval(() => {
      this._spinIdx = (this._spinIdx + 1) % 4;
      this.setData({ locSpinChar: chars[this._spinIdx] });
    }, 200);
    loc.calm().then(p => {
      loc.setCache(p.lat, p.lng);
      this.pendingLoc = { lat: p.lat, lng: p.lng };
      const nt = this.fmtDist(p.lat, p.lng, this.data.c);
      clearInterval(this._spinTimer);
      this.setData({ locRefreshing: false, distText: nt }); // 成功：图标恢复，可再点
    }).catch(() => {
      /* 不收敛：保持原显示；6 秒冷却倒计时（6→1 显示完恢复可点），避免连续刷定位 */
      clearInterval(this._spinTimer);
      this.setData({ locRefreshing: false, locCooldown: 6 });
      clearInterval(this._cdTimer);
      this._cdTimer = setInterval(() => {
        const v = this.data.locCooldown - 1;
        if (v <= 1) {
          clearInterval(this._cdTimer);
          this.setData({ locCooldown: 0 }); // 倒数到 1 即恢复
        } else {
          this.setData({ locCooldown: v });
        }
      }, 1000);
    });
  },
  hideConfirm() { this.setData({ confirmShow: false }); },

  // ===== 取消本次拜访（老板 2026-09-04 定：主动撤销，客户仍为待回访；无需定位） =====
  askCancel() { this.setData({ cancelShow: true }); },
  hideCancel() { this.setData({ cancelShow: false }); },
  async doCancel() {
    if (this.cancelling) return;
    this.cancelling = true;
    wx.showLoading({ title: '取消中…', mask: true });
    try {
      const res = await api.call('visits', { action: 'cancel', taskId: this.data.c.taskId, customerId: this.data.c._id });
      wx.hideLoading();
      this.cancelling = false;
      this.setData({ cancelShow: false });
      if (res.ok) {
        this.clearStart(); // 取消拜访：计时基准清除，下次进入重新计时
        loc.beacon(); // 状态信标：拜访中→待回访（2026-09-08 老板定）
        api.toast('已取消本次拜访');
        setTimeout(() => wx.navigateBack(), 900);
      } else {
        api.toast(res.msg || '取消失败');
      }
    } catch (e) {
      wx.hideLoading();
      this.cancelling = false;
      this.setData({ cancelShow: false });
      api.toast('取消失败，请重试');
    }
  },

  // 第 2 步：确认提交 —— 先上传现场证据（成功才落库；已传的自动复用，失败可重试），再提交拜访
  async confirmSubmit() {
    if (this.submitting) return;
    this.submitting = true;
    try {
      // 0) 录音若仍在进行：先自动停止，等文件就绪
      if (this.data.recState === 'rec') {
        await new Promise(ok => { this._recStopResolve = ok; this.stopRec(false); });
      }
      // 1) 现场证据上传（无证据直接跳过）
      const hasEv = this.data.pics.length > 0 || (this.data.recs || []).length > 0;
      if (hasEv) {
        wx.showLoading({ title: '上传现场证据…', mask: true });
        try {
          await this.uploadEvidence();
        } catch (e) {
          wx.hideLoading();
          this.submitting = false;
          api.toast('证据上传失败，请检查网络后重试');
          return;
        }
        wx.hideLoading();
      }
      // 2) 提交拜访
      wx.showLoading({ title: '提交中…' });
      const photos = this._evPhotos || [];
      const audios = this._evAudios || [];
      const audio = audios.length ? { fileID: audios[0].fileID, duration: audios[0].duration } : null;
      const res = await api.call('visits', {
        action: 'submit',
        taskId: this.data.c.taskId,
        customerId: this.data.c._id,
        result: this.data.result,
        text: this.data.text,
        samples: this.data.samples,
        durationSeconds: this.data.pendingSeconds,
        ...this.pendingLoc,
        photos,
        audios,
        audio
      });
      wx.hideLoading();
      this.submitting = false;
      this.setData({ confirmShow: false });
      if (res.ok) {
        this.clearStart(); // 提交成功：计时基准清除，下次进入重新计时
        loc.beacon(); // 状态信标：拜访中→已回访（2026-09-08 老板定）
        // 2026-09-11 M2b：转写兜底 —— 对「勾选但还没提交转写」的段触发（提前点过「开始转录」的段不重复计费）
        if (!res.boss && res.visitId) {
          const idx = (this.data.recs || [])
            .map((r, i) => (r.transcribe && !r.trStatus && r.fileID ? i : -1))
            .filter(i => i >= 0);
          if (idx.length) api.call('transcribe', { action: 'start', visitId: res.visitId, segIndexes: idx }).catch(() => {});
        }
        this._evPhotos = null; this._evAudios = null; this._evAudio = null;
        const pool = PRAISE[this.data.result] || ['辛苦啦！拜访已提交 ✓'];
        const line = pool[Math.floor(Math.random() * pool.length)];
        api.toast(line, 'success');
        // 提示后自动回任务详情页（回退两层：拜访记录页 → 客户详情页）
        setTimeout(() => wx.navigateBack({ delta: 2 }), 900);
      } else if (res.code === 'TOO_FAR') {
        // 证据已上传完成：重试自动复用（_evPhotos/_evAudios 保留），不重复传
        api.toast(`距客户 ${res.distance} 米，超限`);
      } else {
        api.toast(res.msg || '提交失败，请重试');
      }
    } catch (e) {
      wx.hideLoading();
      this.submitting = false;
      api.toast('提交失败，请确认云函数已部署');
    }
  },
  // 上传录音段（已传的跳过；返回最新列表）—— 未勾选转写的段也上传留档，只是不提交识别
  async uploadAudios() {
    const recs = [...(this.data.recs || [])];
    for (let i = 0; i < recs.length; i++) {
      if (recs[i].up && recs[i].fileID) continue;
      if (!recs[i].path) continue;
      const fileID = await media.uploadFile(recs[i].path, recs[i].ext || this.recorder.uploadExt);
      recs[i] = { ...recs[i], up: true, fileID };
      this.setData({ recs });
    }
    return recs;
  },
  // 上传照片（原图+缩略图双轨）与录音段；逐张进行，已上传的跳过（断网重试不重复传）
  async uploadEvidence() {
    const pics = this.data.pics;
    for (let i = 0; i < pics.length; i++) {
      if (pics[i].up) continue;
      const fileID = await media.uploadFile(pics[i].orig, '.jpg');
      const thumbID = await media.uploadFile(pics[i].thumb, '.jpg');
      pics[i] = { ...pics[i], up: true, fileID, thumbID };
      this.setData({ pics });
    }
    this._evPhotos = pics.map(p => ({ fileID: p.fileID, thumbID: p.thumbID }));
    const recs = await this.uploadAudios();
    this._evAudios = recs.filter(r => r.fileID).map(r => ({ fileID: r.fileID, duration: r.sec, transcribe: !!r.transcribe }));
    this._evAudio = this._evAudios.length ? { fileID: this._evAudios[0].fileID, duration: this._evAudios[0].duration } : null;
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
