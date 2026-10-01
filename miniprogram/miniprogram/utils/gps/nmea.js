// utils/gps/nmea.js —— NMEA 0183 解析（GGA / GSV / GSA / RMC / VTG）
// 说明：所有解析函数都先校验 checksum；校验失败返回 null。

function checksumOk(line) {
  const star = line.indexOf('*');
  if (star < 0) return true; // 无校验和，放行
  let sum = 0;
  for (let i = 1; i < star; i++) sum ^= line.charCodeAt(i);
  const given = parseInt(line.slice(star + 1, star + 3), 16);
  return !isNaN(given) && sum === given;
}

function checksum(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum ^= body.charCodeAt(i);
  return (sum & 0xFF).toString(16).toUpperCase().padStart(2, '0');
}

// 由句体（不含 $ 和 *CS）生成完整语句
function buildSentence(body) {
  return '$' + body + '*' + checksum(body) + '\r\n';
}

function bodyOf(line) {
  const star = line.indexOf('*');
  return star < 0 ? line.slice(1) : line.slice(1, star);
}

function fields(line) {
  return bodyOf(line).split(',');
}

function typeOf(line) {
  return line.slice(3, 6);          // GGA / GSV / GSA / RMC / VTG / GLL
}

function talkerOf(line) {
  return line.slice(1, 3);          // GP / GB / GL / GA / GQ / GN
}

const TALKER_SYS = {
  GP: 'GPS',
  GB: 'BD',
  BD: 'BD',
  GL: 'GLO',
  GA: 'GAL',
  GQ: 'QZS',
  GS: 'SBS',
  GN: 'MIX'
};

const SYS_LABEL = {
  GPS: 'GPS',
  BD: '北斗',
  GLO: 'GLONASS',
  GAL: 'Galileo',
  QZS: 'QZSS',
  SBS: 'SBAS',
  NAV: 'NavIC',
  MIX: '组合'
};

// NMEA 4.1 GSA 末尾的系统 ID 字段 → 系统名
const NMEA_SYSID = { 1: 'GPS', 2: 'GLO', 3: 'GAL', 4: 'BD', 5: 'QZS', 6: 'NAV' };

// 参照 u-center 的习惯配色，便于专业用户识别
const SYS_COLOR = {
  GPS: '#22c55e',
  BD: '#ef4444',
  GLO: '#eab308',
  GAL: '#3b82f6',
  QZS: '#a855f7',
  SBS: '#06b6d4',
  MIX: '#94a3b8'
};

function sysOf(line) {
  return TALKER_SYS[talkerOf(line)] || 'MIX';
}

// NMEA ddmm.mmmm / dddmm.mmmmm -> 十进制度
// 必须字符串定点拆分，避免 parseFloat 全串转换丢精度
function nmeaToDeg(v, hemi) {
  if (!v) return NaN;
  const dot = v.indexOf('.');
  if (dot < 3) return NaN;
  const deg = Number(v.slice(0, dot - 2));
  const min = Number(v.slice(dot - 2));
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return NaN;
  const d = deg + min / 60;
  return (hemi === 'S' || hemi === 'W') ? -d : d;
}

// 十进制度 -> NMEA ddmm.mmmmm / dddmm.mmmmm
// ⚠️ 分字段固定 8 字符（"MM.mmmmm"），宽度写错会导致度数错位（如 34.x 变成 340.x）
function degToNmea(deg, isLat) {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const min = (abs - d) * 60;
  let minStr = min.toFixed(5);
  if (minStr.length < 8) minStr = '0'.repeat(8 - minStr.length) + minStr;
  return String(d).padStart(isLat ? 2 : 3, '0') + minStr;
}

function fixQualityText(q) {
  switch (q) {
    case 0: return '无效';
    case 1: return '单点';
    case 2: return '差分/SBAS';
    case 4: return 'RTK固定';
    case 5: return 'RTK浮点';
    case 6: return '组合导航';
    case 7: return '人工输入';
    default: return '未知';
  }
}

// ---------------------------------------------------------------- GGA
// $GNGGA,123519.00,4807.038,N,01131.000,E,1,08,0.9,545.4,M,46.9,M,,*47
function parseGGA(line) {
  if (!line || line[0] !== '$' || line.indexOf('GGA') < 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 10) return null;

  const lat = nmeaToDeg(t[2], t[3]);
  const lng = nmeaToDeg(t[4], t[5]);
  const fixQuality = Number(t[6]) || 0;
  const sats = Number(t[7]) || 0;
  const hdop = Number(t[8]) || 99;
  const alt = Number(t[9]);

  const usable = (fixQuality > 0)
    && Number.isFinite(lat) && Number.isFinite(lng)
    && !(lat === 0 && lng === 0);

  return {
    type: 'GGA', sys: sysOf(line),
    utc: t[1], lat, lng, fixQuality, sats, hdop,
    alt: Number.isFinite(alt) ? alt : null,
    usable
  };
}

// ---------------------------------------------------------------- GSV
// $GPGSV,3,1,11,03,03,111,00,04,15,270,00,06,01,010,00,13,06,292,00*74
//
// ⚠️⚠️ NMEA 4.11 的 GSV 末尾还有一个 **signalId** 字段，而且 u-blox 会**按 signalId 分组**
//   重复输出多套 GSV（官方原文："The messages are grouped by the signal ID and separate
//   messages are output for each signal ID"）。实测本机就是这样：
//
//     $GPGSV,3,1,12,10,80,280,42,...,1*64   ← signalId=1：已跟踪，**有 cno**，一轮 3 条
//     $GPGSV,1,1,04,02,07,309,,...,0*69     ← signalId=0：未跟踪的低仰角星，cno 为空，一轮 1 条
//     $GAGSV,3,1,10,...,7*7B                ← Galileo 是 signalId=7（E1）
//
//   两组的 msgNum 各自从 1 开始。**必须把 signalId 解析出来**，
//   否则聚合时会把"signalId=0 那条 msgNum=1 的小报文"误当成"该星座新一轮枚举开始"，
//   把整星座的数据连同信噪比一起抹掉（实测踩了很久的坑，见 gnssState._applyGSV）。
function parseGSV(line) {
  if (!line || line[0] !== '$' || line.indexOf('GSV') < 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 4) return null;

  const totalMsgs = Number(t[1]) || 1;
  const msgNum = Number(t[2]) || 1;
  const satsInView = Number(t[3]) || 0;
  const sentSys = sysOf(line);
  const sats = [];
  for (let i = 4; i + 3 < t.length; i += 4) {
    const prn = Number(t[i]);
    if (!prn) continue;
    sats.push({
      prn,
      // ★★ SBAS 藏在 GPS 组里（官方手册原文）：
      //   "The SV numbers (fields 'svid') are in the range of 1 to 32 for GPS
      //    satellites, and **33 to 64 for SBAS**."
      //   真机实证：$GPGSV 里的 PRN50 与 UBX-NAV-SAT 的 SBS137(gnssId=1, svId=137)
      //   cno/仰角/方位三个数完全一致（50 = 137-87）；PRN40↔SBS127、PRN41↔SBS128 同理。
      //   所以按报文头把 33~64 号一律当成 GPS 是错的 —— 星座计数、天空视图配色、
      //   以及"GPS 有一颗 PRN 50"这种看不懂的记录，都出自这里。
      sys: (sentSys === 'GPS' && prn >= 33 && prn <= 64) ? 'SBS' : sentSys,
      el: t[i + 1] === '' ? null : Number(t[i + 1]),
      az: t[i + 2] === '' ? null : Number(t[i + 2]),
      snr: t[i + 3] === '' ? null : Number(t[i + 3])   // 空 = 未跟踪
    });
  }
  // 每组卫星占 4 个字段；剩余 1 个字段就是 signalId（NMEA 4.11 才有）
  const extra = (t.length - 4) % 4;
  const signalId = (extra === 1 && t[t.length - 1] !== '') ? Number(t[t.length - 1]) : null;
  return { type: 'GSV', sys: sysOf(line), totalMsgs, msgNum, satsInView, sats, signalId };
}

// ---------------------------------------------------------------- GSA
// $GPGSA,A,3,04,05,,09,12,,,24,,,,,2.5,1.3,2.1*39
function parseGSA(line) {
  if (!line || line[0] !== '$' || line.indexOf('GSA') < 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 18) return null;

  const prns = [];
  for (let i = 3; i <= 14; i++) {
    const v = Number(t[i]);
    if (v) prns.push(v);
  }
  // 系统判定：NMEA 4.1 的多星座设备会输出多条 $GNGSA，用**末尾的系统 ID 字段**区分星座。
  // 若只按报文头判断，三条都会被当成 GN/MIX → "参与解算"标记全部落空（实测踩过）。
  let sys = sysOf(line);
  let sysId = null;
  if (t.length >= 19) {
    const sid = Number(t[18]);
    if (NMEA_SYSID[sid]) {
      sysId = sid;
      if (sys === 'MIX') sys = NMEA_SYSID[sid];
    }
  }
  return {
    type: 'GSA', sys, sysId,
    mode: t[1],
    fixType: Number(t[2]) || 1,          // 1=无 2=2D 3=3D
    prns,
    pdop: Number(t[15]) || null,
    hdop: Number(t[16]) || null,
    vdop: Number(t[17]) || null
  };
}

// ---------------------------------------------------------------- RMC
// $GNRMC,092725.00,A,3110.46939,N,12123.26000,E,0.06,167.93,040822,,,A*..
function parseRMC(line) {
  if (!line || line[0] !== '$' || line.indexOf('RMC') < 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 10) return null;

  return {
    type: 'RMC', sys: sysOf(line),
    utc: t[1],
    status: t[2],                        // A=有效 V=无效
    lat: nmeaToDeg(t[3], t[4]),
    lng: nmeaToDeg(t[5], t[6]),
    speedKnots: Number(t[7]) || 0,
    course: Number(t[8]) || 0,
    date: t[9]
  };
}

// ---------------------------------------------------------------- VTG
// $GNVTG,167.93,T,167.93,M,0.06,N,0.11,K,A*2F
function parseVTG(line) {
  if (!line || line[0] !== '$' || line.indexOf('VTG') < 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 8) return null;
  return {
    type: 'VTG', sys: sysOf(line),
    courseTrue: Number(t[1]) || 0,
    speedKnots: Number(t[5]) || 0,
    speedKmh: Number(t[7]) || 0
  };
}

// ------------------------------------------- u-blox 私有 NMEA（PUBX,00 / PUBX,03）
//   PUBX,00 = 位置  字段：msgId,time,lat,NS,lon,EW,altRef,navStat,hAcc,vAcc,SOG,COG,
//                        vVel,diffAge,HDOP,VDOP,TDOP,numSvs,reserved,DR
//   PUBX,03 = 卫星状态，**带 cno（信噪比）**  字段：msgId,numSv,{sv,s,az,el,cno,lck}...
//
// 手册原例（M10 SPG 7.0x）：
//   $PUBX,03,11,23,-,,,45,010,29,-,,,46,013,07,-,,,42,015,08,U,067,31,42,025,...
//   注意：az/el 可能为空而 cno 仍有值；s: U=参与解算 e=有星历未用 -=未用。
//
// ★ 轮询：`$PUBX,00*33` 是**只读的纯 NMEA 轮询**。官方原文：
//   "A PUBX,00 message is polled by sending the PUBX,00 message without any data fields."
//   它能把"能不能往模块发东西"和"UBX 能不能用"分开测：
//     回了 = 下行通路通，问题出在 UBX；没回 = 我们写的东西根本到不了模块。
function parsePUBX(line) {
  if (!line || line.indexOf('$PUBX') !== 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 3) return null;
  const msgId = t[1];

  if (msgId === '00') {
    const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
    return {
      type: 'PUBX00',
      utc: t[2] || '',
      lat: num(t[3]), ns: t[4] || '',
      lng: num(t[5]), ew: t[6] || '',
      navStat: t[8] || '',
      hAcc: num(t[9]), vAcc: num(t[10]),
      hdop: num(t[15]), vdop: num(t[16]), tdop: num(t[17]),
      numSvs: num(t[18])
    };
  }

  if (msgId !== '03') return null;

  const numSv = Number(t[2]) || 0;
  const sats = [];
  for (let i = 3; i + 5 < t.length + 1; i += 6) {
    if (i >= t.length) break;
    const sv = Number(t[i]);
    if (!sv) continue;
    sats.push({
      sv,
      status: t[i + 1] || '',
      used: (t[i + 1] || '') === 'U',
      az: t[i + 2] === '' || t[i + 2] === undefined ? null : Number(t[i + 2]),
      el: t[i + 3] === '' || t[i + 3] === undefined ? null : Number(t[i + 3]),
      cno: t[i + 4] === '' || t[i + 4] === undefined ? null : Number(t[i + 4]),
      lock: t[i + 5] === undefined ? '' : t[i + 5]
    });
  }
  const withCno = sats.filter(s => s.cno != null && s.cno > 0);
  return {
    type: 'PUBX03', numSv, sats,
    withCno: withCno.length,
    usedCount: sats.filter(s => s.used).length,
    avgCno: withCno.length
      ? withCno.reduce((a, s) => a + s.cno, 0) / withCno.length : null
  };
}

// 统一入口
// ---------------------------------------------------------------- GST
// $GNGST,100938.00,36,3.2,1.6,149,1.1,0.87,2.8*40
//   time, rangeRms, stdMajor, stdMinor, orient, stdLat, stdLon, stdAlt
//
// ★ 这是**接收机自己给出的精度估计**（伪距残差的统计量），
//   对我们的意义：它是唯一一个**独立于我们评分**的"这个点准不准"的数字。
//   我们算的 qualityScore 是基于卫星几何/信噪比/散布的推断，
//   而 GST 是接收机内部的解算残差 —— 两者对照才看得出评分有没有跑偏。
//   现场实测：阳台内（头顶被挡）stdLat 4.0 m / stdLon 2.1 m；
//             开阔处 stdLat 1.1 m / stdLon 0.87 m —— 相差 3 倍，与环境完全对得上。
function parseGST(line) {
  if (!line || line[0] !== '$' || line.indexOf('GST') < 0) return null;
  if (!checksumOk(line)) return null;
  const t = fields(line);
  if (t.length < 8) return null;
  const num = (i) => (t[i] === '' ? null : Number(t[i]));
  return {
    type: 'GST', sys: sysOf(line),
    utc: t[1],
    rangeRms: num(2), stdMajor: num(3), stdMinor: num(4), orient: num(5),
    stdLat: num(6), stdLon: num(7), stdAlt: num(8),
    // 水平精度：取纬经两向的合成（标准做法是 sqrt(stdLat²+stdLon²)，
    // 但我们同时保留两向原值，界面要显示得具体一点）
    hAcc: (num(6) != null && num(7) != null)
      ? Math.sqrt(num(6) * num(6) + num(7) * num(7)) : null
  };
}

function parseLine(line) {
  if (!line || line[0] !== '$') return null;
  if (line.indexOf('$PUBX') === 0) return parsePUBX(line);
  const t = typeOf(line);
  switch (t) {
    case 'GGA': return parseGGA(line);
    case 'GSV': return parseGSV(line);
    case 'GSA': return parseGSA(line);
    case 'RMC': return parseRMC(line);
    case 'VTG': return parseVTG(line);
    case 'GST': return parseGST(line);
    default: return null;
  }
}

module.exports = {
  parseLine, parseGGA, parseGSV, parseGSA, parseRMC, parseVTG, parseGST, parsePUBX,
  checksumOk, checksum, buildSentence, nmeaToDeg, degToNmea,
  fixQualityText, sysOf, talkerOf, typeOf,
  SYS_LABEL, SYS_COLOR
};
