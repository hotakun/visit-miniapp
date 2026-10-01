// utils/gps/staticFix.js —— 驻留采点：稳健重加权 + 精度加权 + 分半一致性 + 逐步收敛判定
//
// 2026-09-18 升级：从"硬阈值 + HDOP 加权"改成下面四件事（动机与验证见 tools/estimator-test.js）：
//
//   ① 收敛判据看「均值还能变多少」（标准误 SE），而不是只看单次散布（rms）。
//      rms 小只说明"每次定位之间很一致"，回答不了"再采 30 秒平均值还会不会变"。
//   ② 分半一致性：把样本按时间对半切，算两个子均值之差 Δ。
//      它是**唯一能实测"样本相关性/有效独立样本数"**的量（模型无关），
//      而且它就是 ① 的输入 —— 有它，SE 里的 N_eff 才不是拍脑袋的。
//   ③ 权重用接收机自报精度 σ（$GNGST 的 √(stdLat²+stdLon²)、或 NAV-PVT 的 hAcc），
//      而不是只反映几何的 HDOP。实测同一台设备在不同环境 σ 差 3~10 倍，
//      而 HDOP 对此**无感** —— 用 1/σ² 加权等于把这 3~10 倍差距平方后体现在权重里。
//   ④ 中间地带的点用 Huber 迭代重加权（IRLS）**平滑降权**，而不是"8 m 内一视同仁"。
//      原来偏 0.3 m 和偏 7 m 的点权重完全一样，而偏 7 m 的点对 0.5 m 级的目标是致命的。
//
// ⚠️ 前提：这些改进都建立在"接收机输出的是诚实的、无偏的逐历元位置"之上。
//    所以**不要去动 CFG-NAVSPG-DYNMODEL**（设成 STAT 会让接收机内部平滑），
//    那会让我们连"样本"和"残差"都测不准，这四处改进全部失去意义。
function distanceMeters(a, b) {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad * Math.cos(a.lat * toRad);
  return Math.sqrt(dLat * dLat + dLng * dLng) * R;
}

/** 中位数（不改原数组） */
function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 用 MAD 稳健估计标准差（1.4826 是正态一致系数） */
function madSigma(arr) {
  if (!arr.length) return 0;
  const med = median(arr);
  return 1.4826 * median(arr.map(v => Math.abs(v - med)));
}

/** Huber 权重：|r| ≤ k 不降权；超过后按 k/|r| 平滑降权（不会像硬剔除那样一刀切） */
function huber(r, k) {
  const a = Math.abs(r);
  return a <= k ? 1 : k / a;
}

// 接收机自报的精度有时是"无效哨兵值"（无定位时 hAcc = 0xFFFFFFFF mm）。
// 判据与 ubx.accValid() 保持一致：必须是正数且 < 1 km。
const ACC_MAX = 1000;
function accUsable(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v < ACC_MAX; }

class StaticFix {
  constructor(opts = {}) {
    this.minSats = opts.minSats ?? 6;         // 卫星数下限
    this.maxHdop = opts.maxHdop ?? 1.5;       // HDOP 上限（质量门）
    this.maxSpread = opts.maxSpread ?? 8.0;   // 硬上限：与中位数偏离超过此值(米)判为跑飞，直接丢
    this.minSamples = opts.minSamples ?? 60;  // 收敛所需的最少有效样本
    this.maxRms = opts.maxRms ?? 1.0;         // 收敛所需的散布上限（米）
    this.capacity = opts.capacity ?? 600;     // 滑动窗口上限
    // ★ 最短驻留时长（秒）：只看样本数的话，频率一提高（1→2 Hz）驻留就自动砍半
    this.minSeconds = opts.minSeconds ?? 60;
    // 相邻样本间隔超过这么久（毫秒）就认为"中间断了"，驻留计时重新开始
    this.maxGapMs = opts.maxGapMs ?? 10000;
    // ① 均值的标准误上限（米）：**这才是"收敛"的正确定义** ——
    //    "再采下去，平均值大概不会再动超过这个数"。
    //
    // ⚠️ 2026-09-18 现场教训：第一版定的 0.15 m **太严**（用户测 4 次只过 1 次，
    //    其余 >0.40、最大 >1）。原因有两个，都要记住：
    //      1) 当 N_eff ≈ 1（系统性偏差主导，实测很常见）时 SE ≈ rms，
    //         于是 0.15 这个门槛等于**把 rms 门槛从 1.0 m 偷偷收紧到 0.15 m** —— 严了 6 倍；
    //      2) 0.15 比我们**实测的跨时段重复性（约 0.5 m）**还小 3 倍 ——
    //         要求"单点的随机不确定度比最终能达到的精度还准"，逻辑上就不通。
    //    现在锚定在**实测重复性**上：不确定度不超过 0.5 m 就收。
    this.maxSe = opts.maxSe ?? 0.5;
    // ★ 半差门槛由 maxSe **导出**，不要再各写各的。关系（第一版我说错过一次，这里写准）：
    //     半差 = ratio · 2·rms/√N；SE = rms/√nEff，且 nEff = N/ratio²（未夹取时）
    //     ⇒ **半差 = 2·SE**（未夹取时严格成立）
    //     nEff 被夹取时（ratio<1 → 夹到 N；ratio>√N → 夹到 1）半差 < 2·SE。
    //   ⇒ 恒有 **半差 ≤ 2·SE**，所以取 maxHalfDrift = 2·maxSe 时，
    //     **半差门槛永远不会比 SE 门槛更严** —— 只留 SE 一个旋钮就够了。
    //   第一版同时写死 "SE<0.15" 和 "半差≤0.6"，等价于 SE<0.3，比标称紧了一倍，
    //   现场测 4 次只过 1 次就是这么来的。
    this.maxHalfDrift = opts.maxHalfDrift ?? (this.maxSe * 2);
    this.huberK = opts.huberK ?? 1.345;       // ④ Huber 常数（1.345 → 95% 正态效率）
    this.irlsIters = opts.irlsIters ?? 5;
    // 时钟可注入：测试要模拟不同采样率，不能真 sleep（见 tools/dwell-test.js）
    this.now = opts.now || Date.now;
    this.pts = [];
  }

  push(g) {
    if (!g || !g.usable) return null;
    if (g.sats < this.minSats || g.hdop > this.maxHdop) return null;
    this.pts.push({
      lat: g.lat, lng: g.lng,
      hdop: g.hdop,
      acc: accUsable(g.acc) ? g.acc : null,   // ★ σ（米）：来自 $GNGST / NAV-PVT hAcc
      t: this.now()
    });
    if (this.pts.length > this.capacity) this.pts.shift();
    return this.estimate();
  }

  estimate() {
    const n = this.pts.length;
    if (n < 10) return null;

    // ---- 1) 抗差基准：中位数（对跳点鲁棒，不受个别野值影响）----
    const medLat = median(this.pts.map(p => p.lat));
    const medLng = median(this.pts.map(p => p.lng));

    // ---- 2) 硬上限：离中位数超过 maxSpread 的直接丢（防跑飞）。
    //         语义与历史一致，"已用/丢弃"两个数因此仍然可比。
    const kept = this.pts.filter(p =>
      distanceMeters(p, { lat: medLat, lng: medLng }) <= this.maxSpread);
    if (kept.length < 4) return null;

    // ---- 3) 基础权重：优先用接收机自报精度 σ；拿不到就退回 HDOP（与历史行为一致）----
    const sigmas = kept.map(p => p.acc).filter(accUsable);
    const sigMed = sigmas.length ? median(sigmas) : null;
    // ⚠️ 只用 σ 的**相对大小**：缺 σ 的样本按中位 σ 处理，保证整组"同一把尺子"。
    //    绝不能把 1/σ² 和 1/HDOP² 混在一组里（量纲不同，会悄悄扭曲加权）。
    const baseW = kept.map(p => {
      if (sigMed != null) {
        const s = accUsable(p.acc) ? p.acc : sigMed;
        return 1 / (s * s);
      }
      return 1 / (p.hdop * p.hdop);
    });

    // ---- 4) Huber 迭代重加权（IRLS）----
    //    不用硬剔除：偏 1 m 的点权重略降、偏 5 m 的点权重很低、偏 40 m 的点权重趋零。
    let lat = medLat, lng = medLng;
    let w = baseW.slice();
    for (let it = 0; it < this.irlsIters; it++) {
      let sw = 0, sLat = 0, sLng = 0;
      for (let i = 0; i < kept.length; i++) {
        sw += w[i]; sLat += kept[i].lat * w[i]; sLng += kept[i].lng * w[i];
      }
      if (!(sw > 0)) break;
      lat = sLat / sw; lng = sLng / sw;

      const d = kept.map(p => distanceMeters(p, { lat, lng }));
      const sHat = madSigma(d);
      if (!(sHat > 0)) break;                 // 残差全零（理想数据）→ 不降权
      w = baseW.map((b, i) => b * huber(d[i] / sHat, this.huberK));
    }
    // 最后一次均值（用最终权重）
    {
      let sw = 0, sLat = 0, sLng = 0;
      for (let i = 0; i < kept.length; i++) {
        sw += w[i]; sLat += kept[i].lat * w[i]; sLng += kept[i].lng * w[i];
      }
      if (sw > 0) { lat = sLat / sw; lng = sLng / sw; }
    }

    // ---- rms：**保持历史口径**（未加权的距离均方根），否则和以前的数据没法对比 ----
    let s2 = 0;
    for (const p of kept) { const dd = distanceMeters(p, { lat, lng }); s2 += dd * dd; }
    const rms = Math.sqrt(s2 / kept.length);

    // ---- ② 分半一致性：按**时间**对半切（不是按索引 —— 采样率可能变、中间可能有丢弃）----
    const items = kept.map((p, i) => ({ lat: p.lat, lng: p.lng, t: p.t, w: w[i] }));
    items.sort((a, b) => a.t - b.t);
    const weightedMean = (arr) => {
      let sw = 0, sLat = 0, sLng = 0;
      for (const q of arr) { sw += q.w; sLat += q.lat * q.w; sLng += q.lng * q.w; }
      return sw > 0 ? { lat: sLat / sw, lng: sLng / sw } : null;
    };
    const half = items.length >> 1;
    const mA = half >= 1 ? weightedMean(items.slice(0, half)) : null;
    const mB = half >= 1 ? weightedMean(items.slice(half)) : null;
    const halfDiff = (mA && mB) ? distanceMeters(mA, mB) : 0;
    // 若样本**相互独立**，两半均值之差应有的量级：Δ ≈ 2·rms/√N
    const halfNoise = 2 * rms / Math.sqrt(items.length);
    const halfRatio = halfNoise > 0 ? halfDiff / halfNoise : 0;

    // ---- ① 均值的标准误 ----
    // 把实测的 Δ 和"独立时的期望 Δ"比一下，就反推出**有效独立样本数**：
    //   Δ ∝ 1/√N_eff  →  N_eff = N / (Δ实测/Δ期望)² = N / ratio²
    // ratio ≈ 1 → 样本基本独立（提高采样率有用）
    // ratio ≫ 1 → 样本高度相关 / 还在漂移（多采样几乎没用）—— 这正好解释了
    //             "1 Hz 和 2 Hz 精度差不多"这个我们观察到的现象。
    const nEff = halfRatio > 0
      ? Math.max(1, Math.min(items.length, items.length / (halfRatio * halfRatio)))
      : items.length;
    const se = rms / Math.sqrt(nEff);          // 均值的标准误（米）

    // ---- 驻留时长：从"当前这段连续采样"的第一个样本算起（遇长间隔重新计）----
    const tEnd = this.pts[n - 1].t;
    let i = n - 1;
    while (i > 0 && this.pts[i].t - this.pts[i - 1].t <= this.maxGapMs) i--;
    const elapsedSec = (tEnd - this.pts[i].t) / 1000;

    const enoughSamples = kept.length >= this.minSamples;
    const dwellOk = elapsedSec >= this.minSeconds;
    const rmsOk = rms < this.maxRms;
    // ★ 只留一个"均值稳没稳"的门槛（SE），半差门槛由它导出（见构造函数说明）。
    //   两个都当硬门槛是重复的：它们本来就只差一个 2 倍系数。
    const seOk = se < this.maxSe;
    const driftOk = halfDiff <= this.maxHalfDrift;
    // 分级：让 0.4 这种点照样能存，但显示成"可接受"而不是"优" —— 信息保留，不挡人
    const seTier = se <= 0.15 ? '优' : (se <= 0.3 ? '良' : (se <= this.maxSe ? '可接受' : '不合格'));
    return {
      lat, lng,
      samples: n,
      used: kept.length,
      rejected: n - kept.length,
      rms,                                    // 单次散布（重复性口径，与历史可比）
      se,                                     // ★ 均值的标准误：再采下去平均值还能变多少
      nEff,                                   // ★ 有效独立样本数（由分半一致性反推）
      halfDiff,                               // ★ 前后两半均值之差（米）
      halfNoise,                              // 若样本独立，这个差应有的量级
      halfRatio,                              // Δ实测 / Δ期望
      drifting: halfRatio > 2.5,              // 明显还在漂（只是提示，不是硬门槛）
      elapsedSec,
      dwellLeftSec: Math.max(0, Math.ceil(this.minSeconds - elapsedSec)),
      dwellOk, enoughSamples,
      rmsOk, seOk, driftOk,                   // 三个分项，界面可以逐条说明为什么还没收敛
      seTier,                                 // 均值稳定性分级：优 / 良 / 可接受 / 不合格
      // ★ 收敛：四条同时满足（见文件头的说明）
      stable: enoughSamples && dwellOk && rmsOk && seOk && driftOk,
      weighted: sigMed != null,               // 这一轮用的是 σ 加权还是 HDOP 加权（可自证）
      sigMed                                 // 用到的 σ 中位数（米），便于界面说明
    };
  }

  reset() { this.pts = []; }
}

module.exports = { StaticFix, distanceMeters, median, madSigma, huber };
