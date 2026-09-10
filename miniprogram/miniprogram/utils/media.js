// utils/media.js —— 现场证据工具（2026-09-07 二期拍照/录音提前做）
// 职责：照片压缩（原图 ≤1280/JPEG≤300KB + 320px 缩略图 ≤40KB 双轨）、
//       录音（mp3 16kHz 单声道低码率，档位自动停）、云存储直传、临时链接换取
// 依赖：基础库 ≥2.16.1（OffscreenCanvas）；wx.cloud 已在 app.js init

const fs = wx.getFileSystemManager();

const PHOTO_EDGE = 1280;      // 原图最长边
const PHOTO_QUALITY = 70;     // JPEG 质量
const PHOTO_MAX = 300 * 1024; // 原图 ≤300KB
const THUMB_EDGE = 320;       // 缩略图最长边
const THUMB_QUALITY = 70;
const THUMB_MAX = 40 * 1024;  // 缩略图 ≤40KB
const REC_FORMAT = 'mp3';
const REC_SAMPLE = 16000;     // 16kHz 人声对话足够
const REC_CHANNELS = 1;
const REC_BITRATE = 32000;    // ≈4KB/s：10 分钟 ≈2.4MB（老板定档 3/5/10 分钟由后台下发）

function getFileSize(path) {
  return new Promise((ok) => {
    fs.getFileInfo({ filePath: path, success: r => ok(r.size || 0), fail: () => ok(0) });
  });
}
function getImageInfo(src) {
  return new Promise((ok, fail) => wx.getImageInfo({ src, success: ok, fail }));
}
// 2026-09-11 M2b：照片上限提到 15 张 —— 支持指定来源（['camera']=连拍单张 / ['album']=相册多选），默认两者都可
function chooseImage(count, sourceType) {
  return new Promise((ok, fail) => wx.chooseMedia({
    count, mediaType: ['image'], sourceType: sourceType || ['camera', 'album'], sizeType: ['original'], camera: 'back',
    success: r => ok(r.tempFiles || []), fail
  }));
}
// 画布单次绘制输出 jpg（2026-09-08 终版：无旋转分支、无质量循环、无缩边循环——
// 每张照片走完全相同的代码路径，消除"一会儿对一会儿错"；微信 canvas 对本地照片自动按方向显示）
async function drawOnce(srcPath, W, H, draw, quality) {
  const canvas = wx.createOffscreenCanvas({ type: '2d', width: W, height: H });
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  await new Promise((ok, fail) => { img.onload = ok; img.onerror = fail; img.src = srcPath; });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H); // jpg 无透明：白底防黑
  draw(ctx, img);
  const tmp = await new Promise((ok) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width: W, height: H, destWidth: W, destHeight: H,
    fileType: 'jpg', quality, success: r => ok(r.tempFilePath), fail: () => ok('')
  }));
  return { path: tmp, size: await getFileSize(tmp) };
}

// 缩略图统一 320×240 中心裁切填满：单次绘制，无循环无分支（2026-09-08 终版）
const THUMB_H = 240; // 320×240 固定
async function coverJpg(srcPath) {
  const info = await getImageInfo(srcPath);
  const W = THUMB_EDGE, H = THUMB_H;
  // 中心裁切 4:3 窗口：横图裁左右、竖图裁上下（纯算术，恒定）
  let cw = info.width, ch = info.height, sx = 0, sy = 0;
  if (info.width / info.height > W / H) {
    cw = Math.round(info.height * W / H);
    sx = Math.round((info.width - cw) / 2);
  } else {
    ch = Math.round(info.width * H / W);
    sy = Math.round((info.height - ch) / 2);
  }
  return drawOnce(srcPath, W, H, (ctx, img) => ctx.drawImage(img, sx, sy, cw, ch, 0, 0, W, H), THUMB_QUALITY);
}

// 一张照片产出双轨（单次处理，恒定路径）：{ orig: 原图(≤1280/q70), thumb: 320×240 裁切填满 }
async function prepPhoto(srcPath) {
  const info = await getImageInfo(srcPath);
  const m = Math.max(info.width, info.height);
  const rawSize = await getFileSize(srcPath);
  // orig：小图直接用原文件；大图单次等比缩到 ≤1280
  let orig;
  if (m <= PHOTO_EDGE && rawSize > 0 && rawSize <= PHOTO_MAX) {
    orig = { path: srcPath, size: rawSize };
  } else {
    const dw = m > PHOTO_EDGE ? Math.round(info.width * PHOTO_EDGE / m) : info.width;
    const dh = m > PHOTO_EDGE ? Math.round(info.height * PHOTO_EDGE / m) : info.height;
    orig = await drawOnce(srcPath, dw, dh, (ctx, img) => ctx.drawImage(img, 0, 0, dw, dh), PHOTO_QUALITY);
  }
  const thumb = await coverJpg(srcPath); // 直接对原图单次裁切（不再有中间产物）
  return { orig, thumb };
}

// 云存储直传（客户端上传不占云函数超时）；返回 fileID；cloudPath 随机防撞
function uploadFile(localPath, ext) {
  const cloudPath = 'evidence/' + Date.now() + '-' + Math.random().toString(36).slice(2, 10) + ext;
  return wx.cloud.uploadFile({ cloudPath, filePath: localPath }).then(r => r.fileID);
}

// 批量换临时 https 链接（历史/后台展示；fileIDs ≤50）
function getTempURLs(fileIDs) {
  return wx.cloud.getTempFileURL({ fileList: fileIDs }).then(r => {
    const map = {};
    (r.fileList || []).forEach(f => { if (f.status === 0 && f.tempFileURL) map[f.fileID] = f.tempFileURL; });
    return map;
  });
}

function fmtSec(s) {
  const n = Math.max(0, Math.floor(s || 0));
  return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
}

// ===== 平台识别（2026-09-08 老板反馈：iPhone 不支持 mp3 录音格式） =====
// iOS → aac（苹果原生，稳定）；安卓/鸿蒙 → mp3（保持现状）
let _ios = null;
function isIOS() {
  if (_ios === null) {
    try { _ios = String((wx.getSystemInfoSync().platform || '')).toLowerCase() === 'ios'; }
    catch (e) { _ios = false; }
  }
  return _ios;
}
// 2026-09-11 M2b（老板定）：单条上限 ≤10 分钟，iOS 一并放开 —— 原「iOS 单独封顶 5 分钟」取消，改为与安卓同档 600s
// ⚠️ iPhone 10 分钟长录音仍需真机压测确认（若苹果端异常，改回 Math.min(n, 300) 并告知老板）
function recLimit(limitSec) {
  const n = Number(limitSec) || 300;
  return isIOS() ? Math.min(n, 600) : n;
}

// ===== 录音封装（安卓/鸿蒙 mp3 16kHz 单声道；iOS aac 16kHz 单声道；start 后可 stop；到点自动停） =====
// 2026-09-11 M2b：录音器仍为单例（微信 RecorderManager 本身是全局单例）→ 多段由页面「串行录制」实现，
// 每段录完立即 getUploadPath() 转存为持久路径后再入列；试听走下面的 playPath（共用一颗播放器 → 互斥）
function createRecorder() {
  const rm = wx.getRecorderManager();
  const aud = wx.createInnerAudioContext();
  aud.autoplay = false;
  aud.obeyMuteSwitch = false; // 2026-09-08 修复：iOS 静音键打开时 InnerAudioContext 无声（后台有声手机无声）
  let state = 'idle'; // idle | rec | done
  let limitSec = 300;
  let autoStopped = false;
  let curFmt = 'mp3';   // 当前格式（iOS=aac；mp3 失败会降级 aac 重试）
  let triedAac = false; // mp3 失败自动降级 aac 的兜底标记
  let recPath = '';   // 录音文件路径（闭包变量：onStop 写、play/reset 读。曾误用 this.path——
  let savedPath = ''; // 箭头函数里 this=模块对象而 play 的 this=实例，读写错位导致试听从未执行播放）
  let playingSrc = ''; // 正在播放的 src（iOS 空实例 stop 会误报 onError，只在真有源时提示）
  let onTick = null; // (secs, state) 每秒
  let onDone = null; // (tempFilePath, durationSec)
  let onErr = null;

  // 确保录音文件为有效持久路径（2026-09-08 iPhone 提交失败根因：saveFile 会**移动**临时文件，
  // 试听后 tmp 已失效，上传必须用转存后的持久路径；转存成功后回写 recPath）
  async function ensureSaved() {
    if (!recPath) return '';
    if (recPath.indexOf('wxfile://tmp') === 0) {
      if (savedPath) { recPath = savedPath; return savedPath; }
      try {
        const s = await new Promise((ok, fail) => wx.getFileSystemManager().saveFile({
          tempFilePath: recPath, success: r => ok(r.savedFilePath || recPath), fail
        }));
        savedPath = s;
        recPath = s; // 关键：tmp 已被移动失效，回写持久路径供后续上传/播放
      } catch (e) { /* 转存失败：保持原路径（多数安卓可直接用） */ }
    }
    return recPath;
  }

  function recStart(fmt) {
    curFmt = fmt;
    if (fmt === 'mp3') {
      rm.start({ format: 'mp3', sampleRate: REC_SAMPLE, numberOfChannels: REC_CHANNELS, encodeBitRate: REC_BITRATE });
    } else {
      // iOS aac：不传码率（苹果自适应，16kHz 单声道）
      rm.start({ format: 'aac', sampleRate: REC_SAMPLE, numberOfChannels: REC_CHANNELS });
    }
  }

  rm.onStart(() => { state = 'rec'; autoStopped = false; });
  rm.onStop(r => {
    const dur = Math.round((r.duration || 0) / 1000);
    state = 'done';
    recPath = r.tempFilePath || '';
    savedPath = ''; // 新录音：清除旧转存，播放时再转存
    if (onTick) onTick(dur, state);
    if (onDone) onDone(recPath, dur, autoStopped);
  });
  rm.onError(() => {
    // 兜底：mp3 启动失败自动降级 aac 重试一次（iOS 判断失误/异常机型都能救回）
    if (curFmt === 'mp3' && !triedAac) {
      triedAac = true;
      recStart('aac');
      return;
    }
    state = 'idle';
    if (onErr) onErr('录音失败，请重试');
  });
  aud.onError(() => {
    // 仅当真有播放源时才提示（iOS 对空实例 stop 会触发误报 onError，2026-09-08 老板实测：报错却有声）
    if (!playingSrc) return;
    playingSrc = '';
    wx.showToast({ title: '播放失败，请重试', icon: 'none' });
  });
  aud.onEnded(() => { playingSrc = ''; if (onTick) onTick(-1, 'playend'); });

  return {
    start(limit, tickCb, doneCb, errCb) {
      if (state === 'rec') return;
      limitSec = recLimit(limit || 300);
      triedAac = false;
      onTick = tickCb; onDone = doneCb; onErr = errCb;
      recStart(isIOS() ? 'aac' : 'mp3');
    },
    stop() { if (state === 'rec') { autoStopped = false; rm.stop(); } },
    stopAtLimit() { // 到档位上限自动停（visit 页定时器调用）
      if (state === 'rec') { autoStopped = true; rm.stop(); }
    },
    // 上传扩展名：iOS=aac(.m4a)；其余=mp3
    get uploadExt() { return curFmt === 'aac' ? '.m4a' : '.mp3'; },
    // 上传/试听共用：返回有效持久路径（tmp 会自动转存并回写）
    getUploadPath() { return ensureSaved(); },
    // 试听：转存后播放（2026-09-08：iOS 对 RecorderManager 的 wxfile://tmp 临时文件播放有兼容问题）
    async play() {
      if (state !== 'done' || !recPath) return;
      const p = await ensureSaved();
      if (!p) return;
      aud.stop();
      aud.src = p;
      playingSrc = p;
      aud.play();
    },
    stopPlay() { playingSrc = ''; aud.stop(); },
    reset() { aud.stop(); playingSrc = ''; state = 'idle'; recPath = ''; savedPath = ''; if (onTick) onTick(0, 'idle'); },
    get state() { return state; }
  };
}

// ===== 2026-09-11 M2b：多段录音的独立试听播放器 =====
// 共用一颗 InnerAudioContext → 天然满足「同一时刻只播一条」（试听互斥）；每次切换先 stop
let _pv = null;      // InnerAudioContext 单例
let _pvPath = '';    // 当前播放源（空 = 没在播）
let _pvEnd = null;   // 播放结束/出错回调（复位按钮状态用）
function _ensurePlayer() {
  if (_pv) return _pv;
  _pv = wx.createInnerAudioContext();
  _pv.autoplay = false;
  _pv.obeyMuteSwitch = false; // 与 createRecorder 一致：iOS 静音键打开时也要有声
  _pv.onEnded(() => { _pvPath = ''; const cb = _pvEnd; _pvEnd = null; if (cb) cb(); });
  _pv.onError(() => {
    if (!_pvPath) return; // 空实例 stop 会误报 onError（2026-09-08 老板实测：报错却有声）
    _pvPath = '';
    const cb = _pvEnd; _pvEnd = null;
    if (cb) cb();
    wx.showToast({ title: '播放失败，请重试', icon: 'none' });
  });
  return _pv;
}
// 播放指定路径（path 为空则仅停止）；onEnded 用于复位按钮状态
function playPath(path, onEnded) {
  const p = _pv || _ensurePlayer();
  p.stop();
  _pvPath = '';
  _pvEnd = onEnded || null;
  if (!path) return;
  p.src = path;
  _pvPath = path;
  p.play();
}
// 停止试听并清回调
function stopPath() {
  _pvPath = '';
  _pvEnd = null;
  if (_pv) _pv.stop();
}
// 某路径是否正在播放
function isPlayingPath(path) { return !!path && _pvPath === path; }

module.exports = {
  PHOTO_EDGE, PHOTO_MAX, THUMB_EDGE, THUMB_MAX,
  REC_SAMPLE, REC_FORMAT,
  chooseImage, prepPhoto, uploadFile, getTempURLs, fmtSec, createRecorder, getFileSize, isIOS, recLimit,
  playPath, stopPath, isPlayingPath
};
