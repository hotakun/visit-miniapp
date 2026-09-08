// 全局定位工具：跨页面共享最近一次定位（模块级单例缓存）+ 收敛精确定位（§7.9 口径）
let cache = null; // { lat, lng, at }
function getCached() {
  return cache;
}

function setCache(lat, lng) {
  cache = { lat, lng, at: Date.now() };
}

// 单点定位（带超时保护 + 单飞防并发）：
// 微信 getLocation 无 timeout 参数，挂起时必须有保护；
// 全局同一时刻只允许一个定位请求在飞——后到者直接复用进行中的请求（2026-09-06 老板定：防并发挤垮系统定位服务）
let inFlight = null;

function getOne(timeout) {
  if (inFlight) return inFlight;
  const p = new Promise((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('定位超时')); }
    }, timeout || 8000);
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: true,
      success: (r) => {
        if (!settled) {
          settled = true; clearTimeout(t);
          resolve({ lat: r.latitude, lng: r.longitude, accuracy: r.accuracy });
        }
      },
      fail: (e) => {
        if (!settled) { settled = true; clearTimeout(t); reject(e); }
      }
    });
  });
  inFlight = p;
  const clear = () => { if (inFlight === p) inFlight = null; };
  p.then(clear, clear);
  return p;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 收敛精确定位（2026-09-06 老板定稿 · 加权多采点版）：
// 取点间隔 1.5s（串行不并发）；不丢点，全部参与；
// 有效点=accuracy≤opts.acc（默认50，报错高精度用30；0 未知不计）；
// 稳定性判定：最近 3 个有效点（滑动窗口）两两 ≤ 收敛半径(opts.radius 默认20m，报错高精度用10m)；
// 多采点策略：稳定后不提前结束，采满目标有效点数 opts.target（默认5，报错用8）才成功，
// 质心=全部有效点按 1/accuracy² 加权（精度越高的点权重越大）；
// 有效点达到 opts.maxValid（默认8，报错12）或取点轮数达到 opts.maxAttempts（默认10，报错16）时：
// 最近3点稳定且有效点≥3 → 成功，否则失败。
// 成功返回 { lat, lng, accuracy }（accuracy=加权平均精度，供"定位质量行"展示）
function calm(opts) {
  opts = opts || {};
  const radius = opts.radius || 20;
  const accMax = opts.acc || 50;
  const TARGET = opts.target || 5;
  const MAX_VALID = opts.maxValid || 8;
  const MAX_ATTEMPTS = opts.maxAttempts || 10;
  const INTERVAL = 1500;
  return new Promise((resolve, reject) => {
    const valid = []; // 有效点
    let attempts = 0;
    let finished = false;

    const allPairWithin = (arr, d) => {
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          if (haversineM(arr[i].lat, arr[i].lng, arr[j].lat, arr[j].lng) > d) return false;
        }
      }
      return true;
    };

    const isStable = () => valid.length >= 3 && allPairWithin(valid.slice(-3), radius);

    // 加权质心：权重 = 1/accuracy²（GPS 标准加权，精度高的点占主导）
    const wcentroid = (arr) => {
      let wsum = 0, lat = 0, lng = 0, accSum = 0;
      arr.forEach(p => {
        const a = p.accuracy || 10;
        const w = 1 / (a * a);
        wsum += w; lat += p.lat * w; lng += p.lng * w; accSum += a * w;
      });
      return { lat: lat / wsum, lng: lng / wsum, accuracy: Math.round(accSum / wsum) };
    };

    const success = () => {
      if (finished) return;
      finished = true;
      resolve(wcentroid(valid));
    };
    const fail = () => {
      if (!finished) { finished = true; reject(new Error('定位不稳定')); }
    };
    // 兜底判定：最近 3 点稳定且有效点≥3 则成功
    const finalJudge = () => {
      if (isStable()) success(); else fail();
    };

    const step = () => {
      if (finished) return;
      attempts++;
      getOne(8000).then(p => {
        if (finished) return;
        if (p && p.accuracy != null && p.accuracy > 0 && p.accuracy <= accMax) {
          valid.push(p);
          // 稳定且采满目标点数 → 成功（稳定后仍继续采点充实样本，提高质心精度）
          if (isStable() && valid.length >= TARGET) { success(); return; }
          // 有效点上限：必须稳定才成功
          if (valid.length >= MAX_VALID) { finalJudge(); return; }
        }
        if (attempts >= MAX_ATTEMPTS) { finalJudge(); return; }
        setTimeout(step, INTERVAL);
      }).catch(() => {
        if (finished) return;
        if (attempts >= MAX_ATTEMPTS) { finalJudge(); return; }
        setTimeout(step, INTERVAL);
      });
    };
    step();
  });
}

module.exports = { getCached, setCache, getOne, calm, startForeground, subscribe, latest, startBackground, stopBackground, beacon };

// ================= 持续定位总线（2026-09-08 M1 定位升级） =================
// 基于 wx.startLocationUpdate + wx.onLocationChange 的位置流；
// 不可用（模拟器/权限/老基础库）→ 页面照旧用 getOne 轮询（唯一降级路径）。
let bus = null;
function ensureBus() {
  if (bus) return;
  bus = { available: false, running: false, latest: null, subs: [], inited: false };
  bus.available = typeof wx.startLocationUpdate === 'function' && typeof wx.onLocationChange === 'function';
  if (bus.available) {
    wx.onLocationChange(p => {
      if (!p) return;
      const pt = { lat: p.latitude, lng: p.longitude, accuracy: Number(p.accuracy) || 0, speed: Number(p.speed) || 0, at: Date.now() };
      setCache(pt.lat, pt.lng);
      bus.latest = pt;
      const now = Date.now();
      bus.subs.forEach(s => {
        if (now - s.last >= s.throttle) { s.last = now; s.fn(pt); }
      });
      maybeUpload(pt); // 最新位置上报（60 秒节流；非工作时段 10 米阈值在云端判定）
      sampleTrack(pt); // 轨迹采样与片段上传（2026-09-08 M2 时间分层口径）
    });
  }
}

// ===== 轨迹采样与上传（2026-09-08 M2 时间分层口径 §2.1） =====
// 工作时段：拜访中 5s / 平时 30s；非工作四档联动（默认 10S/60S）；上传发包跟随档位、绝不空转；跨段不抖动由采样间隔自然平滑
const seg = { last: 0, buffer: [], lastUpload: 0 };
function trackToday(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function sampleTrack(pt) {
  const now = Date.now();
  try {
    const app = getApp();
    const cfg = (app && app.globalData.locCfg) || {};
    const sh = cfg.workStartHour != null ? Number(cfg.workStartHour) : 7;
    const eh = cfg.workEndHour != null ? Number(cfg.workEndHour) : 20;
    const tier = ['5_30', '10_60', '20_120', '30_180'].includes(cfg.offDutyTier) ? cfg.offDutyTier : '10_60';
    const TIERS = { '5_30': [5000, 30000], '10_60': [10000, 60000], '20_120': [20000, 120000], '30_180': [30000, 180000] };
    const pair = TIERS[tier];
    const hour = new Date(now + 8 * 3600 * 1000).getUTCHours();
    const isWork = hour >= sh && hour < eh;
    const visiting = !!(app && app.globalData.visitOngoing);
    const sampleMs = isWork ? (visiting ? 5000 : 30000) : (visiting ? pair[0] : pair[1]);
    const uploadMs = isWork ? 60000 : pair[1];
    if (!seg.last || now - seg.last >= sampleMs) {
      seg.last = now;
      seg.buffer.push({ lat: pt.lat, lng: pt.lng, acc: pt.accuracy || 0, t: now });
      if (seg.buffer.length > 120) seg.buffer.shift();
    }
    if (seg.buffer.length && now - seg.lastUpload >= uploadMs) {
      seg.lastUpload = now;
      const pts = seg.buffer.slice();
      seg.buffer = [];
      const api = require('./api');
      const user = app && app.globalData.user;
      if (user && user._id) {
        api.call('visits', { action: 'reportTrack', day: trackToday(now), pts }).catch(() => {
          seg.buffer = pts.concat(seg.buffer).sort((a, b) => a.t - b.t); // 失败回灌，按时间排序防倒序（2026-09-08 审查修复）
        });
      }
    }
  } catch (e) { /* 静默 */ }
}

// 最新位置上传（2026-09-08 M1）：60 秒节流；云端按"工作正常写/非工作超 10 米才写"判定
let lastUploadAt = 0;
function maybeUpload(pt) {
  const now = Date.now();
  if (now - lastUploadAt < 60000) return;
  lastUploadAt = now;
  try {
    const app = getApp();
    const user = app && app.globalData.user;
    if (!user || !user._id) return;
    // 延迟 require 防循环依赖
    const api = require('./api');
    api.call('visits', {
      action: 'reportLocation',
      lat: pt.lat, lng: pt.lng, accuracy: pt.accuracy,
      visitOngoing: !!(app.globalData.visitOngoing)
    }).catch(() => { /* 静默：下次再传 */ });
  } catch (e) { /* 静默 */ }
}

// 开启前台持续定位（幂等；返回是否可用）
function startForeground() {
  ensureBus();
  if (!bus.available) return Promise.resolve(false);
  if (bus.running) return Promise.resolve(true);
  return new Promise(resolve => {
    try {
      wx.startLocationUpdate({
        success: () => { bus.running = true; resolve(true); },
        fail: () => { resolve(false); }
      });
    } catch (e) { resolve(false); }
  });
}

// 订阅位置流（按 throttleMs 节流渲染）；返回退订函数
function subscribe(fn, throttleMs) {
  ensureBus();
  const s = { fn, throttle: Math.max(1000, Number(throttleMs) || 30000), last: 0 };
  bus.subs.push(s);
  return () => { bus.subs = bus.subs.filter(x => x !== s); };
}

// 最新位置：流内最新点，无则回退缓存/轮询点
function latest() {
  ensureBus();
  if (bus.latest) return bus.latest;
  const c = getCached();
  return c || null;
}

// 后台持续定位（2026-09-08 M2：仅拜访中开启；拒绝不影响前台功能）
function startBackground() {
  ensureBus();
  if (typeof wx.startLocationUpdateBackground !== 'function') return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      wx.startLocationUpdateBackground({
        success: () => resolve(true),
        fail: () => resolve(false)
      });
    } catch (e) { resolve(false); }
  });
}
function stopBackground() {
  try { if (typeof wx.stopLocationUpdate === 'function') wx.stopLocationUpdate({ fail: () => {} }); } catch (e) { /* 静默 */ }
  if (bus) bus.running = false; // 前台流一并标记停止，其他页面 onShow 会重新 startForeground
}

// 状态迁移位置信标（2026-09-08 老板定）：拜访状态变化后立即 force 上报一次，
// 后台即刻感知新状态+位置（流内最新点优先，60 秒内有效；否则 getOne 兜底）
function beacon() {
  const app = getApp();
  const user = app && app.globalData.user;
  if (!user || !user._id) return Promise.resolve(false);
  const send = p => {
    if (!p || !p.lat) return Promise.resolve(false);
    const api = require('./api');
    return api.call('visits', {
      action: 'reportLocation',
      lat: p.lat, lng: p.lng, accuracy: p.accuracy || 0,
      visitOngoing: !!(app.globalData.visitOngoing),
      force: true // 信标必写：不受时段/移动阈值限制
    }).then(r => !!(r && r.ok)).catch(() => false);
  };
  ensureBus();
  const lp = latest();
  if (lp && lp.at && Date.now() - lp.at < 60000) return send(lp);
  return getOne(8000).then(send).catch(() => false);
}
