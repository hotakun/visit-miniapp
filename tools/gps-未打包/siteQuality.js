// ⚠️ 【未启用 / 储备模块】本文件当前**没有任何调用方**（2026-10-05 全项目 grep 核实，零引用）。
//    它不是"写了没用的废码"，而是**为将来准备**的专业模块 —— **别当死代码删**。
//    要启用：接到 capture.js 或拜访页上；背景见 AGENTS.md「utils/gps 储备模块」条。
//    再次确认零引用的方法：grep -rl "siteQuality" --include=*.js miniprogram/ | grep -v utils/gps/
// utils/gps/siteQuality.js —— 点位质量评估
//
// 目的：在几十秒内判断"当前站的位置好不好"，并给出可执行的移动建议。
//
// 原理：卫星几何在 1 分钟内几乎不变（卫星约 0.5°/分钟），
//       所以"环境质量"（遮挡、多径、衰减）可以很快判定；
//       需要时间积累的只有"位置散布"（用来诊断多径跳动）。
//
// 评分构成（总分 100）：
//   卫星可见性 30 + 几何强度 25 + 信号强度 25 + 天空覆盖 10 + 稳定性 10
//
// 额外产出：8 方位"遮挡剖面"—— 每个方向上"能看到的最低仰角"，
//           即该方向的遮挡角。由此得出"哪个方向天空最开阔"。

const { distanceMeters } = require('./staticFix');

const SECTOR_COUNT = 8;
const DIR_NAMES = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const DEG = Math.PI / 180;

// 分阶段：几秒能出什么结论
const STAGE = [
  { at: 0, name: 'idle', text: '未开始' },
  { at: 5, name: 'coarse', text: '环境初判' },
  { at: 15, name: 'sky', text: '含遮挡分析' },
  { at: 30, name: 'full', text: '完整评估' }
];

const DEFAULT_OPTS = {
  evalMs: 60000,        // 完整评估所需观察时长
  // ⚠️ 卫星数口径 = **GSA 并集**（各星座"参与导航"列表的合并），**不是 GGA 的 numSV**。
  //    官方手册（M10 SPG 7.0x，GGA 字段表）：
  //      "numSV ... If compatibility mode is enabled, the range is limited to 12 satellites
  //       (see configuration item CFG-NMEA-COMPAT)."
  //    本机兼容模式是开着的 → numSV 恒为 12（五次真机日志一次没变），
  //    而 GSA 并集实测量级是 20~30。门槛按后者定。
  minSatsGood: 22,      // 达到满分的参与定位卫星数
  minSatsBad: 6,        // 0 分的卫星数下限
  hdopGood: 0.8,        // 达到满分的 HDOP
  hdopBad: 3.0,         // 0 分的 HDOP
  snrGood: 42,          // 达到满分的平均信噪比 dB-Hz
  snrBad: 25,           // 0 分的平均信噪比
  rmsGood: 0.8,         // 达到满分的散布（米）
  rmsBad: 4.0,          // 0 分的散布（米）
  posWindow: 40         // 位置窗口长度
};

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

function norm(v, bad, good, max) {
  if (v == null || !isFinite(v)) return 0;
  return clamp((v - bad) / (good - bad), 0, 1) * max;
}

class SiteQuality {
  constructor(opts = {}) {
    this.opts = Object.assign({}, DEFAULT_OPTS, opts);
    this.reset();
  }

  reset() {
    this.startedAt = 0;
    this.sats = [];            // 最近一次卫星快照 [{sys,prn,el,az,snr,used}]
    this.dop = { hdop: null, pdop: null, vdop: null };
    this.used = 0;
    this.fixQuality = 0;
    this.snrWindow = [];       // 参与解算卫星的平均信噪比滑窗
    this.snrSrc = null;        // 另一套带信噪比的卫星（$PUBX,03）；为空则退回用 this.sats
    this.posWindow = [];       // 位置滑窗（诊断多径跳动）
    this.snrEpochs = 0;        // 收到过"含信噪比"卫星数据的次数
    this.samples = 0;
  }

  /**
   * 每收到一批 NMEA 后调用。
   * @param {Array}  sats       当前卫星快照（来自 GSV）——用于遮挡剖面、可见数、天空视图
   * @param {Array} [snrSats]   另一套**带信噪比**的卫星（来自 $PUBX,03 轮询）。
   *   为什么单独传一套而不是和 sats 合并：$PUBX,03 只给 sv 编号、不带星座标识，
   *   多系统下与 GSV 的 PRN 编号口径可能不一致，硬拼会把信噪比接到错误的卫星上。
   *   它是自洽完整的一套（az/el/cno 都有），所以直接**平行使用**最安全。
   *   不传或为空时自动退回用 sats（即原来的行为）。
   */
  feed({ sats, snrSats, dop, used, fixQuality }) {
    if (!this.startedAt) this.startedAt = Date.now();
    if (sats && sats.length) this.sats = sats;
    if (snrSats && snrSats.length) this.snrSrc = snrSats;
    if (dop) this.dop = dop;
    if (typeof used === 'number') this.used = used;
    if (typeof fixQuality === 'number') this.fixQuality = fixQuality;
    this.samples++;

    // 参与解算卫星的平均信噪比；若"used"标记意外为空，退化为统计所有有信噪比的卫星
    // （否则会导致评分永远不就绪——实测中 GSA 系统判定出错时就是这个症状）
    const src = this._snrSats();
    let u = src.filter(s => s.used && s.snr != null && s.snr > 0);
    if (!u.length) u = src.filter(s => s.snr != null && s.snr > 0);
    if (u.length) {
      const avg = u.reduce((a, b) => a + b.snr, 0) / u.length;
      this.snrWindow.push(avg);
      if (this.snrWindow.length > 60) this.snrWindow.shift();
      this.snrEpochs++;
    }
  }

  /** 信噪比的取数来源：优先用带信噪比的那一套（$PUBX,03），否则用 GSV */
  _snrSats() {
    return (this.snrSrc && this.snrSrc.length) ? this.snrSrc : this.sats;
  }

  /** 可选：喂入已解算的位置，用于稳定性评分 */
  feedPosition(p) {
    if (!p || !isFinite(p.lat) || !isFinite(p.lng)) return;
    this.posWindow.push({ lat: p.lat, lng: p.lng });
    if (this.posWindow.length > this.opts.posWindow) this.posWindow.shift();
  }

  elapsedMs() { return this.startedAt ? (Date.now() - this.startedAt) : 0; }

  _stage() {
    const sec = this.elapsedMs() / 1000;
    let cur = STAGE[0];
    for (const s of STAGE) if (sec >= s.at) cur = s;
    return cur;
  }

  /** 8 方位遮挡剖面：每个方向"能看到的最低仰角" ≈ 该方向遮挡角 */
  _obstruction() {
    const sectors = [];
    // ⚠️ 没有任何带方位/仰角的卫星（例如接收机不输出 GSV）时，
    //    所有方向都必须标成"未知"，绝不能标成"被挡" ——
    //    那会凭空断言"四周遮挡较多"，而我们对天空其实一无所知。
    const noSkyData = !this.sats.some(s => s.az != null && s.el != null);
    // 信噪比取数来源（可能是 $PUBX,03 那套），方位扇区划分两边一致
    const snrSrc = this._snrSats();
    const inSector = (arr, center) => arr.filter(s => {
      if (s.az == null) return false;
      let d = s.az - center;
      while (d <= -180) d += 360;
      while (d > 180) d -= 360;
      return Math.abs(d) <= 22.5;
    });
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const center = i * 45;                 // 扇区以正方位为中心
      // 遮挡剖面用 GSV（有 el）那一套
      const inSec = this.sats.filter(s => {
        if (s.az == null || s.el == null) return false;
        let d = s.az - center;
        while (d <= -180) d += 360;
        while (d > 180) d -= 360;
        return Math.abs(d) <= 22.5;
      });

      // 该方向能看到的最低仰角 ≈ 该方向的遮挡角
      const obsEl = inSec.length ? Math.min.apply(null, inSec.map(s => s.el)) : null;
      // 该方向的平均信噪比：从**带信噪比的那一套**里取（可能不是同一批卫星）
      const snrInSec = inSector(snrSrc, center);
      const snrs = snrInSec.map(s => s.snr).filter(v => v != null && v > 0);
      const avgSnr = snrs.length ? snrs.reduce((a, b) => a + b, 0) / snrs.length : null;

      let level, openRatio;
      if (noSkyData) { level = 'unknown'; openRatio = 0; }            // 没有任何天空数据
      else if (obsEl == null) { level = 'blocked'; openRatio = 0; }   // 该方向一颗星都没有
      else if (obsEl <= 20) { level = 'open'; openRatio = 1; }        // 能看到 20° 以下 → 开阔
      else if (obsEl <= 40) { level = 'partial'; openRatio = 0.5; }   // 部分遮挡
      else { level = 'blocked'; openRatio = 0; }                      // 只能看到高仰角 → 严重遮挡

      sectors.push({
        i,
        center,
        dirName: DIR_NAMES[i],
        count: inSec.length,
        snrCount: snrInSec.length,
        obsEl: obsEl == null ? null : Math.round(obsEl),
        avgSnr: avgSnr == null ? null : Math.round(avgSnr),
        level,
        openRatio,
        // 罗盘显示位置（方位角 0=北 在上）
        x: (50 + 36 * Math.sin(center * DEG)).toFixed(2),
        y: (50 - 36 * Math.cos(center * DEG)).toFixed(2)
      });
    }
    return sectors;
  }

  assess() {
    const o = this.opts;
    const stage = this._stage();
    const elapsed = this.elapsedMs();

    const avgSnr = this.snrWindow.length
      ? this.snrWindow.reduce((a, b) => a + b, 0) / this.snrWindow.length
      : null;

    const hdop = this.dop.hdop;

    // 位置散布（需要一定样本才有意义）
    let rms = null;
    if (this.posWindow.length >= 8) {
      const n = this.posWindow.length;
      const la = this.posWindow.map(p => p.lat).sort((a, b) => a - b);
      const ln = this.posWindow.map(p => p.lng).sort((a, b) => a - b);
      const m = { lat: la[n >> 1], lng: ln[n >> 1] };
      let s2 = 0;
      for (const p of this.posWindow) { const d = distanceMeters(p, m); s2 += d * d; }
      rms = Math.sqrt(s2 / n);
    }

    const sectors = this._obstruction();
    const openScore = sectors.reduce((a, s) => a + s.openRatio, 0) / SECTOR_COUNT;

    // 五个分项（权重：稳定性提高到 25 —— 散布直接决定"这个点能采多准"）
    const cSats = norm(this.used, o.minSatsBad, o.minSatsGood, 25);
    // 几何：HDOP 越小越好
    const cGeom = (hdop == null) ? 0
      : clamp((o.hdopBad - hdop) / (o.hdopBad - o.hdopGood), 0, 1) * 20;
    const cSnr = (avgSnr == null) ? 0 : norm(avgSnr, o.snrBad, o.snrGood, 20);
    const cSky = openScore * 10;
    // 稳定性：rms 越小越好；样本不足时给中性分，避免过早拉低总分
    const cStab = (rms == null) ? 12.5
      : clamp((o.rmsBad - rms) / (o.rmsBad - o.rmsGood), 0, 1) * 25;

    // 分项可用性：某项**拿不到数据**时从总分里剔除，而不是记 0 分。
    // ⚠️ 实测踩过：本机（SR1612U10）的 GSV 信噪比字段可能整段为空 / 或干脆不输出 GSV，
    //    此时若把"信号"记 0 分，好点位也永远上不了 80；更不能因此让评分永不就绪。
    const noSnr = (avgSnr == null);
    const noSky = (this.sats.length === 0);
    const items = [
      { k: '卫星', v: cSats, max: 25, ok: true },
      { k: '几何', v: cGeom, max: 20, ok: true },
      { k: '信号', v: cSnr, max: 20, ok: !noSnr },
      { k: '天空', v: cSky, max: 10, ok: !noSky },
      { k: '稳定', v: cStab, max: 25, ok: true }
    ];
    const maxAvail = items.reduce((a, it) => a + (it.ok ? it.max : 0), 0) || 1;
    const sumAvail = items.reduce((a, it) => a + (it.ok ? it.v : 0), 0);
    let score = Math.round(clamp(sumAvail / maxAvail * 100, 0, 100));

    // 上限规则：位置抖动大时，无论其它指标多好，评分都不能虚高
    // （散布直接限制可达精度，不能被"卫星多、几何好"掩盖）
    let capped = false;
    if (rms != null) {
      if (rms > 5.0) { if (score > 45) { score = 45; capped = true; } }
      else if (rms > 3.0) { if (score > 69) { score = 69; capped = true; } }
      else if (rms > 1.5) { if (score > 84) { score = 84; capped = true; } }
    }
    // 数据不全时不能给「优」：信噪比/天空剖面拿不到，就无法排除多径与遮挡，
    // 这时候说"点位优秀"是不负责任的。位置本身可能没问题，但评分要保守。
    const partial = (noSnr || noSky);
    if (partial && score > 84) { score = 84; capped = true; }

    let grade, level;
    if (score >= 85) { grade = '优'; level = 'good'; }
    else if (score >= 70) { grade = '良'; level = 'ok'; }
    else if (score >= 50) { grade = '一般'; level = 'warn'; }
    else { grade = '差'; level = 'bad'; }

    // 最佳移动方向：遮挡角最小的扇区
    let bestDir = null;
    const cand = sectors.filter(s => s.obsEl != null).sort((a, b) => a.obsEl - b.obsEl);
    if (cand.length) bestDir = cand[0];

    // ---------------- 多径 / 遮挡 诊断指标 ----------------
    // ⚠️ 这一整段都依赖**信噪比**，所以必须用"带信噪比的那一套"（可能是 $PUBX,03），
    //    而不是用 GSV 那一套（本机 GSV 的 C/No 是空的）。
    //    两套数据的方位/仰角各自自洽，不需要跨源拼接。
    const sats = this._snrSats();
    const avgOf = (arr) => arr.length ? arr.reduce((x, y) => x + y.snr, 0) / arr.length : null;

    // 低空衰减：低仰角信号比高仰角差多少（正常天线衰减 3~8dB，超过 12dB 说明低空有反射/遮挡）
    const lowEl = sats.filter(s => s.el != null && s.el <= 25 && s.snr != null && s.snr > 0);
    const highEl = sats.filter(s => s.el != null && s.el >= 60 && s.snr != null && s.snr > 0);
    const snrLow = avgOf(lowEl);
    const snrHigh = avgOf(highEl);
    const snrDrop = (snrLow != null && snrHigh != null && lowEl.length >= 2 && highEl.length >= 2)
      ? (snrHigh - snrLow) : null;

    // 方位异常：某个方向的平均信噪比明显低于其它方向 → 该侧有反射面
    let worstDir = null;
    const withSnr = sectors.filter(s => (s.snrCount != null ? s.snrCount : s.count) >= 2 && s.avgSnr != null);
    if (withSnr.length >= 4) {
      const vals = withSnr.map(s => s.avgSnr).sort((a, b) => a - b);
      const mid = vals[vals.length >> 1];
      const lowest = withSnr.slice().sort((a, b) => a.avgSnr - b.avgSnr)[0];
      if ((mid - lowest.avgSnr) >= 6) {
        worstDir = { name: lowest.dirName, avgSnr: lowest.avgSnr, deficit: mid - lowest.avgSnr };
      }
    }

    // 正上方遮挡：高仰角信号反而比整体更弱（正常应更强）
    const overheadBlocked = (avgSnr != null && snrHigh != null && highEl.length >= 2
      && (avgSnr - snrHigh) >= 6);

    const advice = this._advice({
      used: this.used, hdop, avgSnr, rms, sectors, bestDir, level,
      snrLow, snrHigh, snrDrop, worstDir, overheadBlocked, noSnr, noSky
    });

    return {
      // ⚠️ 就绪条件：既要有足够观察时间，也要**至少拿到定位或卫星数据**。
      // 信噪比优先等 3 个周期；但如果本机根本不报信噪比（实测有这种情况），
      // 等到 15 秒后仍就绪 —— 否则整个评分页在真机上永远不出分（实测踩过）。
      ready: elapsed >= 5000 && (this.used > 0 || this.sats.length > 0)
             && (this.snrEpochs >= 3 || elapsed >= 15000),
      stage: stage.name,
      stageText: (elapsed >= 5000 && this.snrEpochs < 3 && elapsed < 15000)
        ? '等待卫星信噪比数据…' : stage.text,
      elapsedSec: Math.round(elapsed / 1000),
      progress: Math.round(clamp(elapsed / o.evalMs, 0, 1) * 100),
      score, grade, level, capped, partial,
      components: items.map(it => ({
        k: it.k,
        v: it.ok ? Math.round(it.v) : '—',
        max: it.max,
        na: !it.ok,
        pct: it.ok ? Math.round(it.v / it.max * 100) : 0
      })),
      metrics: {
        used: this.used,
        hdop: hdop == null ? '—' : hdop.toFixed(2),
        avgSnr: avgSnr == null ? '—' : avgSnr.toFixed(1),
        rms: rms == null ? '—' : rms.toFixed(2),
        openSectors: sectors.filter(s => s.level === 'open').length,
        inView: this.sats.length,
        snrEpochs: this.snrEpochs,
        noSnr, noSky,
        snrDrop: snrDrop == null ? '—' : snrDrop.toFixed(0),
        worstDir: worstDir ? worstDir.name : ''
      },
      sectors,
      bestDir: bestDir ? { name: bestDir.dirName, obsEl: bestDir.obsEl } : null,
      worstDir,
      serious: advice.some(x => x.charAt(0) === '★'),
      advice
    };
  }

  /**
   * 生成现场提示。按"先解决看不见卫星 → 再解决多径 → 最后给移动方向"排序。
   * 原则：每条都给出【现象 + 常见原因 + 具体动作】，让业务员不需要懂原理也能执行。
   */
  _advice(m) {
    const { used, hdop, avgSnr, rms, sectors, bestDir, level,
      snrLow, snrHigh, snrDrop, worstDir, overheadBlocked, noSnr, noSky } = m;
    const out = [];
    const blocked = sectors.filter(s => s.level === 'blocked').map(s => s.dirName);

    // ============ 数据缺失说明（放在最后，不抢占业务员该看的行动提示）============
    if (noSky) {
      out.push('⚠ 接收机没有输出 GSV 语句，无法生成天空视图与遮挡剖面（本项已从评分中剔除）');
    }
    if (noSnr) {
      out.push('⚠ 接收机没有上报卫星信噪比（GSV 的 C/No 为空）——多径类诊断不可用，本项已从评分中剔除');
    }
    if (noSnr || noSky) {
      out.push('⚠ 数据不全，无法排除多径/遮挡，因此最高只评到「良」；坐标本身仍然有效');
    }

    // ============ 第一优先：先能看见卫星 ============
    // 门槛按 **GSA 并集** 的量级定（多星座开阔地 25~35，遮挡环境 15~22，严重遮挡 <12）
    if (used < 10) {
      out.push('⚠ 参与定位的卫星只有 ' + used + ' 颗，上方遮挡严重');
      out.push('建议：退到街心或更空旷处 3~5 米后重评');
    } else if (used < 16) {
      out.push('参与定位的卫星偏少（' + used + ' 颗），几何条件一般');
    }

    if (avgSnr != null && avgSnr < 26) {
      out.push('信号整体很弱（平均 ' + avgSnr.toFixed(0) + ' dB-Hz）');
      out.push('常见原因：树冠下、雨棚/骑楼下方、紧贴墙面。建议离开遮挡物再测');
    }

    // ============ 第二优先：正上方遮挡（这不是多径） ============
    if (overheadBlocked) {
      out.push('★ 头顶方向信号反而更弱（高仰角 ' + snrHigh.toFixed(0) + ' dB-Hz），说明【正上方有遮挡】');
      out.push('常见：雨棚、骑楼、树冠、天桥正下方。建议往外走 2~3 米，脱离正下方');
    }

    // ============ 第三优先：多径主诊断 ============
    const geomOk = (hdop != null && hdop <= 2.0);
    if (rms != null && rms > 3.0 && used >= 12 && geomOk) {
      out.push('★ 卫星够、几何也好，但定位跳动大（散布 ' + rms.toFixed(1) + ' m）——典型【强反射】特征');
      out.push('建议：离开玻璃幕墙 / 金属卷帘门 / 铁皮棚 / 厢式货车 / 金属广告牌，往街心退 2~3 米');
    } else if (rms != null && rms > 3.0 && used >= 10) {
      out.push('定位跳动较大（散布 ' + rms.toFixed(1) + ' m），信号质量不稳');
      out.push('建议：换到视野更开阔处再评一次');
    }

    if (snrDrop != null && snrDrop >= 12) {
      out.push('★ 低空信号衰减明显（低仰角 ' + snrLow.toFixed(0) + ' vs 高仰角 ' + snrHigh.toFixed(0)
        + ' dB-Hz，差 ' + snrDrop.toFixed(0) + ' dB）');
      out.push('说明贴地或低矮方向有反射/遮挡。建议抬高天线（用伸缩杆举到 2.5 m 以上），或离开低矮遮挡');
    }

    if (worstDir) {
      out.push('★ ' + worstDir.name + '方向信号明显偏弱（比其它方向低 ' + worstDir.deficit.toFixed(0) + ' dB）');
      out.push('该方向可能有反射面或遮挡物。建议避开这一侧，往' + oppositeDir(worstDir.name) + '侧移动 2~3 米');
    }

    // ============ 第四优先：几何与开阔方向 ============
    if (hdop != null && hdop > 2.0) {
      out.push('卫星几何差（HDOP ' + hdop.toFixed(1) + '）：说明天空被挡住了一部分');
    }

    if (bestDir && bestDir.obsEl <= 25 && blocked.length) {
      out.push('👉 ' + bestDir.dirName + '方向天空最开阔（遮挡角约 ' + bestDir.obsEl + '°），可往该方向移动 2~5 米');
    } else if (bestDir && bestDir.obsEl <= 25) {
      out.push('天空条件良好，' + bestDir.dirName + '方向最开阔');
    } else if (blocked.length >= 5) {
      out.push('四周遮挡较多（' + blocked.join('、') + '方向被挡），周边环境不利于定位');
      out.push('建议：优先找街道开阔处、或按业务约定取店门口/路口坐标');
    }

    // ============ 结尾：只有在没有 ★ 级问题时才允许"可以采点" ============
    const hasSerious = out.some(s => s.charAt(0) === '★');

    if (hasSerious) {
      out.push('⚠ 上面标 ★ 的问题会直接影响坐标精度，建议先按提示处理再采点');
    } else if (level === 'good' || level === 'ok') {
      out.push('✅ 点位质量' + (level === 'good' ? '优秀' : '良好') + '，可以开始采点');
    } else if (level === 'warn') {
      out.push('点位一般：可以采，但换到更开阔处会更准（可点「已移动」重评对比）');
    } else {
      out.push('点位较差：建议换位置后再采，否则坐标可能偏好几米');
    }
    return out;
  }
}

/** 取相反方位：北↔南、东北↔西南 … */
function oppositeDir(name) {
  const i = DIR_NAMES.indexOf(name);
  if (i < 0) return name;
  return DIR_NAMES[(i + 4) % DIR_NAMES.length];
}

module.exports = { SiteQuality, DIR_NAMES };
