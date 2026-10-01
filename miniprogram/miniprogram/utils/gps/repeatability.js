// utils/gps/repeatability.js —— 「预计重复性」：这个点位采下来的坐标，换个时间再来还认得上吗？
//
// 为什么必须有这个模块
// ---------------------------------------------------------------------------
// 页面上的「散布（rms）」和「均值标准误（SE）」只反映**这一次驻留内部**的离散程度，
// 它们回答不了"换个时间、换个人再来采一遍，坐标会差多少"。实测两者能差 3~5 倍：
//
//   点位                        接收机自估    页面上的散布/SE        换时间复采实测
//   金属桶盖凹槽（31~32 星）      ±0.27~0.36    0.08~0.38 / 0.10~0.21   0.43~0.54 m
//   院子（24~27 星）             ±0.71~1.19    0.25~0.63              1.70 m
//
// 所以只显示 SE 会让所有人（包括我们自己）以为"这个是 0.1 米级的点"。
// 这个模块给出的是**从现场数据标定出来的经验区间**，唯一用途就是防止这种误读。
//
// 数据出处与复算方式（改了下面的常量必须重新跑一遍）
// ---------------------------------------------------------------------------
//   现场文件：docs/空旷地采集/18次采点信息.txt、24次采样信息.txt
//   复算命令：node tools/repeat-report.js docs/空旷地采集/18次采点信息.txt \
//                                        docs/空旷地采集/24次采样信息.txt 5
//             node tools/repeat-report.js <文件...> 5 --since "..." --until "..."  # 只看某一轮
//   引用到的实测值（tools/repeatability-test.js 会用上面那两份文件**重新算一遍**钉住）：
//     · 好点位同一轮 4~5 次：**0.434 m**（5 点 / 18 分钟）、**0.544 m**（4 点 / 92 分钟）
//     · 其中"设备一动不动连采 3 次"（21:02/21:06/21:11）：**0.235 m** ← 静止时最好的那档
//     · 跨天 11 次：**0.795 m**，最坏两两 **2.495 m**
//     · 差点位（院子）3 次：**1.704 m**
//     · 固定点位的坐标会随时间**单调漂移 1 米量级**（20 分钟内 −1.0 m，去趋势后 RMS 0.21~0.40 m）
//
// ⚠️ 这是**经验估计**，不是指标、更不是承诺：只有两个点位的实测支撑。
//    它的方向是"宁可说保守"，不允许被用来对外宣称精度。
'use strict';

// 三档，判据是「接收机自报水平精度」（accH，米）——它逐颗反映实际测距质量，
// 比我们自己的散布更早、更稳地反映环境好坏；拿不到时退回用散布（阈值另给）。
const TIERS = [
  {
    name: 'good',
    maxAcc: 0.5,      // 实测：好点位 0.27~0.36
    maxRms: 0.4,      // 退回口径时的对应阈值
    m: 0.5,
    label: '±0.5 米',
    note: '好点位实测复采 4~5 次差 0.43~0.54 米；其中「设备一动不动连采 3 次」只差 0.24 米。'
      + '所以采点时人别走开、别中途断电重启 —— 实测走动后重新放回，落点会偏 0.2~0.9 米。'
  },
  {
    name: 'fair',
    maxAcc: 1.5,      // 实测：院子 0.71~1.19
    maxRms: 1.5,
    m: 1.5,
    label: '±1.5 米',
    note: '这个点位环境一般（遮挡/反射偏多）：实测同类点位（院子）复采 3 次差 1.7 米。'
      + '能定位、能记录，但别指望它对准某扇门。'
  },
  {
    name: 'poor',
    maxAcc: Infinity,
    maxRms: Infinity,
    m: 4,
    label: '±4 米以上',
    note: '这个点位环境差（自报精度 >1.5 米，例如阳台/强反射面旁）：实测这类点位会偏好几米。'
      + '不建议把它当门牌定位依据 —— 换到开阔处重采，或改用「照片 + 文字说明」辅助。'
  }
];

// 跨时间的那句话：每一档都要带上。这是本轮最重要的实测结论，也必须让现场看到 ——
// 否则业务员会以为"换个时间再采也一样准"。
const CROSS_NOTE = '换个时间再采会更差：实测同一固定点位 20 分钟内坐标就单调漂掉 1 米，'
  + '跨天复采 11 次的 RMS 是 0.80 米、最坏 2.5 米。'
  + '这不是设备故障，是单点定位的慢变偏差 —— 多站一会儿、提高采样率都压不掉它。';

/**
 * 估计这个点位的重复性。
 *
 * @param {Object} o
 * @param {number} [o.accH]  接收机自报水平精度（米）—— 优先用它。
 *   采集页可直接传 `est.sigMed`（估计器里那个 σ 的中位数，就来自 $GNGST / NAV-PVT hAcc）。
 * @param {number} [o.rms]   本轮散布（米）—— 拿不到 accH 时的退路。
 * @returns {{tier:string,m:number|null,label:string,basis:string|null,
 *            value:number|null,note:string,cross:string}}
 */
function estimateRepeatability(o) {
  const opts = o || {};
  const num = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
  const accH = num(opts.accH);
  const rms = num(opts.rms);

  // ★ 判据优先用"接收机自报水平精度"：它逐颗反映测距质量，环境一差它就先变大
  //   （实测好点位 0.34 / 院子 0.9 —— 分得比我们自己的散布更开）。
  const basis = accH != null ? 'accH' : (rms != null ? 'rms' : null);
  if (!basis) {
    return {
      tier: 'unknown', m: null, label: '—', basis: null, value: null,
      note: '还没拿到精度数据（既没有接收机自报精度，也没有散布）——继续采样后会出现',
      cross: CROSS_NOTE
    };
  }
  const value = basis === 'accH' ? accH : rms;
  let t = TIERS[TIERS.length - 1];
  for (const x of TIERS) {
    if (value <= (basis === 'accH' ? x.maxAcc : x.maxRms)) { t = x; break; }
  }
  return {
    tier: t.name,
    m: t.m,
    label: t.label,
    basis: basis,
    value: value,
    note: t.note,
    cross: CROSS_NOTE
  };
}

module.exports = { estimateRepeatability, TIERS, CROSS_NOTE };
