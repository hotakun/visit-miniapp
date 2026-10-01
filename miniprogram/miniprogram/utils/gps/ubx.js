// utils/gps/ubx.js —— u-blox UBX 报文构造与解析
// 用途：通过 BLE（Write 特征 FFE2）向接收机下发配置，或先 Poll 读回当前配置。
//
// UBX 帧格式：
//   B5 62 | class | id | len(2, LE) | payload | CK_A CK_B
//   校验：对 class..payload 做 8 位 Fletcher 校验
//
// 重要：本模块只负责"生成正确的字节"。下发前建议先 poll 读回，
//       确认字段含义与当前值，再改（见 cfgNav5Poll）。

/* ==================================================================
 * 重要：M10 / F10（SPG 5.10 与 SPG 7.0x）【不支持】旧式 UBX-CFG-NAV5 (0x06 0x24)。
 * 在两代官方 Interface Description 中检索 "CFG-NAV5" 与 "0x06 0x24" 均为 0 命中。
 * 配置必须走新的键值接口：
 *   UBX-CFG-VALSET (0x06 0x8a) 写
 *   UBX-CFG-VALGET (0x06 0x8b) 读
 *   UBX-CFG-VALDEL (0x06 0x8c) 删
 * 下面的 cfgNav5 仅作参考保留，实际不要下发。
 * ================================================================== */

const VALSET_CLASS = 0x06, VALSET_ID = 0x8a;
const VALGET_CLASS = 0x06, VALGET_ID = 0x8b;

// 配置层（VALSET 的 layers 是位掩码；VALGET 的 layer 是单值）
const LAYER_BIT = { RAM: 0x01, BBR: 0x02, FLASH: 0x04 };
const LAYER_ONE = { RAM: 0, BBR: 1, FLASH: 2, DEFAULT: 7 };

/**
 * 配置键 ID（来自 UBX-F10/M10 SPG 7.0x Interface Description 的 CFG-NAVSPG 键表）
 * 键 ID 编码：bits0-11=item, bits16-23=group, bits28-30=size
 *   size: 1=1bit 2=1byte 3=2bytes 4=4bytes 5=8bytes
 */
const KEY = {
  NAVSPG_FIXMODE: 0x20110011,      // 1 byte
  NAVSPG_INIFIX3D: 0x10110013,     // 1 bit
  NAVSPG_WKNROLLOVER: 0x30110017,  // 2 bytes
  NAVSPG_UTCSTANDARD: 0x2011001c,  // 1 byte
  NAVSPG_DYNMODEL: 0x20110021,     // 1 byte
  NAVSPG_ACKAIDING: 0x10110025,    // 1 bit
  NAVSPG_USE_USRDAT: 0x10110061,   // 1 bit
  NAVSPG_INFIL_MINSVS: 0x201100a1, // 1 byte —— 最少卫星数
  NAVSPG_INFIL_MAXSVS: 0x201100a2, // 1 byte —— 最多卫星数
  NAVSPG_INFIL_MINCNO: 0x201100a3, // 1 byte —— 最低信噪比
  NAVSPG_INFIL_MINELEV: 0x201100a4,// 1 byte —— ★ 仰角门限（度）
  NAVSPG_INFIL_NCNOTHRS: 0x201100aa,
  NAVSPG_INFIL_CNOTHRS: 0x201100ab,
  NAVSPG_OUTFIL_PDOP: 0x201100c4,
  NAVSPG_OUTFIL_TDOP: 0x201100c5,
  NAVSPG_OUTFIL_PACC: 0x301100b1,  // 2 bytes
  NAVSPG_OUTFIL_TACC: 0x301100b2,
  NAVSPG_OUTFIL_FACC: 0x301100b3,
  NAVSPG_CONSTR_ALT: 0x401100c1,   // 4 bytes
  NAVSPG_CONSTR_ALTVAR: 0x401100c2
};

/** 由键 ID 推导值的字节长度 */
function keySize(keyId) {
  const code = (keyId >>> 28) & 0x07;
  switch (code) {
    case 1: return 1;   // 1 bit → 按 1 字节传
    case 2: return 1;
    case 3: return 2;
    case 4: return 4;
    case 5: return 8;
    default: return 0;
  }
}

function putU4(arr, v) {
  arr.push(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF);
}

/**
 * UBX-CFG-VALSET：写配置项
 * 载荷（对齐 M10 SPG 7.0x §3.10.5，结构标注为 "4 + [0..n]"）：
 *   version(1) layers(1) reserved0(2)  然后重复 { keyID(4) value(n) }
 * 注：version 0 的头部**没有** transaction 字段（transaction 是 version 1 才有的）。
 * 头部 4 字节里后两字节是 reserved0，必须填 0。
 * 单条报文最多 64 组键值；同一键重复出现时以最后一次为准。
 * @param {Array} pairs [{key, value}]，value 可为 number
 * @param {number} layers 位掩码：bit0=RAM 0x01、bit1=BBR 0x02、bit2=Flash 0x04
 */
function cfgValSet(pairs, layers) {
  const p = [0x00, layers & 0xFF, 0x00, 0x00];
  for (const it of pairs) {
    const n = keySize(it.key);
    putU4(p, it.key);
    for (let i = 0; i < n; i++) p.push((it.value >>> (8 * i)) & 0xFF);
  }
  return frame(VALSET_CLASS, VALSET_ID, p);
}

/**
 * UBX-CFG-VALGET：读配置项
 * 载荷：version(1) layer(1) position(2) 然后重复 { keyID(4) }
 * @param {number[]} keys
 * @param {number} layer 单值：0=RAM 1=BBR 2=Flash 7=Default
 */
function cfgValGet(keys, layer) {
  const p = [0x00, layer & 0xFF, 0x00, 0x00];
  for (const k of keys) putU4(p, k);
  return frame(VALGET_CLASS, VALGET_ID, p);
}

/** 解析 CFG-VALGET 响应，返回 { layer, position, items: [{key, value}] } */
function decodeValGet(payload) {
  if (!payload || payload.length < 4) return null;
  const layer = payload[1];
  const position = payload[2] | (payload[3] << 8);
  const items = [];
  let i = 4;
  while (i + 4 <= payload.length) {
    const key = (payload[i] | (payload[i + 1] << 8) | (payload[i + 2] << 16) | (payload[i + 3] << 24)) >>> 0;
    i += 4;
    const n = keySize(key);
    if (n === 0 || i + n > payload.length) break;
    let v = 0;
    for (let k = 0; k < n; k++) v |= payload[i + k] << (8 * k);
    items.push({ key, value: v });
    i += n;
  }
  return { layer, position, items };
}

/** 把键 ID 转成可读名字 */
const KEY_NAME = {};
Object.keys(KEY).forEach(k => { KEY_NAME[KEY[k]] = k; });

// CFG-NMEA 组里**与"卫星数怎么算/怎么报"直接相关**的键。
//
// ⚠️ 只列已经逐条核对过的四个。手册提取稿里这张表会把 ID 与名称错开一行，
//    我因此把 MAXSVS / PROTVER 张冠李戴过一次；其余（FILT_* / HIGHPREC / LIMIT82）
//    的 ID 归属在两处提取里互相矛盾，**没核实就不写进来**，免得又把错的当依据。
//    核实方法：在手册里搜 "0xID" 紧跟的键名（直接拼接的那种最可靠）。
const KEY_NMEA = {
  0x10930003: 'NMEA-COMPAT',     // 兼容模式：开启则 GGA numSV 限 12（出厂默认 0）
  0x10930004: 'NMEA-CONSIDER',   // 考虑模式：开启则"考虑过但被剔除"的卫星也计入（出厂默认 1）
  0x20930002: 'NMEA-MAXSVS',     // NMEA 每 Talker 最多上报几颗（出厂默认 0=UNLIM）
  0x20930001: 'NMEA-PROTVER'     // NMEA 协议版本
};
Object.keys(KEY_NMEA).forEach(k => { KEY_NAME[Number(k)] = KEY_NMEA[k]; });

// CFG-MSGOUT-*_UART1 —— 「每条报文在 UART1 上的输出速率」（值 = 每几个导航解输出一次，0 = 不输出）
//
// 全部逐条核对过：核实方法是看手册默认值表里 "0x<ID>CFG-MSGOUT-<名字>_UART1U1--<默认值>"
// 这个紧邻的拼接（tools/manual-class-scan.js --msgout <名字> 可复现）。
// ⚠️ 手册默认值表里**这些几乎全是 0**（连 NMEA-GST 也是 0），而真机上它们都在 1 Hz 输出
//    —— 是**模组厂商固件把它们打开的**。所以把它们写回 0 属于"关掉厂商多开的输出"。
const KEY_MSGOUT = {
  0x20910007: 'MSGOUT-NAV-PVT/UART1',       // ★ 要用：差分/载波位、真实卫星数
  0x20910011: 'MSGOUT-NAV-ORB/UART1',       // 没用（代码只把它当名字表）
  0x20910016: 'MSGOUT-NAV-SAT/UART1',       // ★ 要用：每颗星 C/No
  0x20910066: 'MSGOUT-NAV-CLOCK/UART1',     // 没用
  0x2091007a: 'MSGOUT-NAV-AOPSTATUS/UART1', // 没用
  0x209100ac: 'MSGOUT-NMEA-RMC/UART1',      // 留着（日期时间、测试交叉验证）
  0x209100b1: 'MSGOUT-NMEA-VTG/UART1',      // 留着（速度航向）
  0x209100bb: 'MSGOUT-NMEA-GGA/UART1',      // ★ 命脉：坐标与历元
  0x209100c0: 'MSGOUT-NMEA-GSA/UART1',      // ★ 命脉：真实卫星数（并集）
  0x209100c5: 'MSGOUT-NMEA-GSV/UART1',      // ★ 命脉：信噪比/天空视图
  0x209100ca: 'MSGOUT-NMEA-GLL/UART1' ,     // 我们不解析（默认就是开着的）
  0x209100d4: 'MSGOUT-NMEA-GST/UART1',      // ★ 命脉：接收机自估精度
  0x20910197: 'MSGOUT-MON-MSGPP/UART1',     // 没用
  0x209101a6: 'MSGOUT-MON-IO/UART1',        // 没用
  0x20910346: 'MSGOUT-NAV-SIG/UART1',       // 监测台用它证明 SBAS 是否生效（生产不用）
  0x20910350: 'MSGOUT-MON-COMMS/UART1'      // 没用
};
Object.keys(KEY_MSGOUT).forEach(k => { KEY_NAME[Number(k)] = KEY_MSGOUT[k]; });

function keyLabel(keyId) {
  const n = KEY_NAME[keyId] || ('0x' + (keyId >>> 0).toString(16));
  return n.replace('NAVSPG_', '');
}

/* ---------------- 旧式 CFG-NAV5（M10 不支持，仅作参考保留） ---------------- */
const NAV5_CLASS = 0x06;
const NAV5_ID = 0x24;
const NAV5_LEN = 36;

/** 8 位 Fletcher 校验（对 class,id,len,payload 计算） */
function checksum(bytes) {
  let a = 0, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) & 0xFF;
    b = (b + a) & 0xFF;
  }
  return [a, b];
}

/** 组装一帧 UBX */
function frame(cls, id, payload) {
  const len = payload.length;
  const head = [0xB5, 0x62, cls, id, len & 0xFF, (len >> 8) & 0xFF];
  const body = head.slice(2).concat(payload);
  const ck = checksum(body);
  return head.concat(payload, ck);
}

/** 校验一帧 UBX 是否合法，返回 {ok, cls, id, payload} */
function parse(buf) {
  const b = Array.from(buf);
  if (b.length < 8 || b[0] !== 0xB5 || b[1] !== 0x62) return { ok: false, reason: '前导码错误' };
  const len = b[4] | (b[5] << 8);
  if (b.length < 6 + len + 2) return { ok: false, reason: '长度不足' };
  const body = b.slice(2, 6 + len);
  const ck = checksum(body);
  if (ck[0] !== b[6 + len] || ck[1] !== b[7 + len]) return { ok: false, reason: '校验和错误' };
  return { ok: true, cls: b[2], id: b[3], payload: b.slice(6, 6 + len) };
}

/* ---------------- CFG-NAV5（导航引擎设置，36 字节载荷） ----------------
 * offset size 字段                 说明
 *   0     2   mask                 哪些字段生效（见 MASK）
 *   2     1   dynModel             0=便携 2=静止 3=步行 4=车载 5=船 6~8=航空 9=腕表 10=骑行
 *   3     1   fixMode              1=2D 2=3D 3=自动
 *   4     4   fixedAlt             固定高程（cm）
 *   8     4   fixedAltVar         高程方差
 *  12     1   minElev              ★ 仰角门限（度）—— 抬高可压制低仰角多径
 *  13     1   drLimit             航位推算时间限制
 *  14     2   pDop                位置 DOP 门限
 *  16     2   tDop                时间 DOP 门限
 *  18     2   pAcc                位置精度门限
 *  20     2   tAcc                时间精度门限
 *  22     1   staticHoldThresh    ★ 静态保持阈值（cm/s）—— 冻结位置，测坐标场景【不要开】
 *  23     1   dgpsTimeOut         差分超时
 *  24     1   cnoThreshNumSVs     ★ 触发 CNO 门限所需的最少卫星数
 *  25     1   cnoThresh           ★ CNO 门限（dB-Hz）—— 弱信号自适应剔除
 *  26     2   reserved2
 *  28     4   reserved3
 *  32     4   reserved4
 */
const MASK = {
  DYN_MODEL: 0x0001,
  FIX_MODE: 0x0002,
  FIXED_ALT: 0x0004,
  MIN_ELEV: 0x0010,
  DR_LIMIT: 0x0020,
  POS_DOP: 0x0040,
  TIME_DOP: 0x0080,
  POS_ACC: 0x0100,
  TIME_ACC: 0x0200,
  STATIC_HOLD: 0x0400,
  DGPS_TIMEOUT: 0x0800,
  CNO_THRESH: 0x1000,
  UTC: 0x4000
};

/**
 * 构造 CFG-NAV5 设置报文。只把传入的字段对应的 mask 位置 1，
 * 其余字段保持接收机原值（不会被清零）。
 * @param {object} o { dynModel, fixMode, minElev, staticHoldThresh, cnoThresh, cnoThreshNumSVs, pDop, tDop, pAcc, tAcc, drLimit, dgpsTimeOut }
 * @returns {number[]} 完整 UBX 帧
 */
function cfgNav5(o) {
  const p = new Array(NAV5_LEN).fill(0);
  const setU2 = (off, v) => { p[off] = v & 0xFF; p[off + 1] = (v >> 8) & 0xFF; };
  const setU4 = (off, v) => { for (let i = 0; i < 4; i++) p[off + i] = (v >>> (8 * i)) & 0xFF; };

  let mask = 0;
  if (o.dynModel != null) { p[2] = o.dynModel & 0xFF; mask |= MASK.DYN_MODEL; }
  if (o.fixMode != null) { p[3] = o.fixMode & 0xFF; mask |= MASK.FIX_MODE; }
  if (o.minElev != null) { p[12] = o.minElev & 0xFF; mask |= MASK.MIN_ELEV; }
  if (o.drLimit != null) { p[13] = o.drLimit & 0xFF; mask |= MASK.DR_LIMIT; }
  if (o.pDop != null) { setU2(14, Math.round(o.pDop * 10)); mask |= MASK.POS_DOP; }
  if (o.tDop != null) { setU2(16, Math.round(o.tDop * 10)); mask |= MASK.TIME_DOP; }
  if (o.pAcc != null) { setU2(18, o.pAcc); mask |= MASK.POS_ACC; }
  if (o.tAcc != null) { setU2(20, o.tAcc); mask |= MASK.TIME_ACC; }
  if (o.staticHoldThresh != null) { p[22] = o.staticHoldThresh & 0xFF; mask |= MASK.STATIC_HOLD; }
  if (o.dgpsTimeOut != null) { p[23] = o.dgpsTimeOut & 0xFF; mask |= MASK.DGPS_TIMEOUT; }
  if (o.cnoThreshNumSVs != null) { p[24] = o.cnoThreshNumSVs & 0xFF; }
  if (o.cnoThresh != null) { p[25] = o.cnoThresh & 0xFF; }
  if (o.cnoThreshNumSVs != null || o.cnoThresh != null) mask |= MASK.CNO_THRESH;

  setU2(0, mask);
  return frame(NAV5_CLASS, NAV5_ID, p);
}

/** CFG-NAV5 Poll：读回当前配置（载荷为空） */
function cfgNav5Poll() {
  return frame(NAV5_CLASS, NAV5_ID, []);
}

/** 把 CFG-NAV5 的 36 字节载荷解析成可读对象（用于读回校验） */
function decodeNav5(payload) {
  if (!payload || payload.length < NAV5_LEN) return null;
  const u2 = (off) => payload[off] | (payload[off + 1] << 8);
  const u4 = (off) => (payload[off] | (payload[off + 1] << 8) | (payload[off + 2] << 16) | (payload[off + 3] << 24)) >>> 0;
  return {
    mask: '0x' + u2(0).toString(16).padStart(4, '0'),
    maskBits: Object.keys(MASK).filter(k => u2(0) & MASK[k]),
    dynModel: payload[2],
    fixMode: payload[3],
    fixedAlt: u4(4) / 100,
    fixedAltVar: u4(8) / 10000,
    minElev: payload[12],
    drLimit: payload[13],
    pDop: u2(14) / 10,
    tDop: u2(16) / 10,
    pAcc: u2(18),
    tAcc: u2(20),
    staticHoldThresh: payload[22],
    dgpsTimeOut: payload[23],
    cnoThreshNumSVs: payload[24],
    cnoThresh: payload[25]
  };
}

function toHex(bytes) {
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/* ---------------- UBX-NAV-SAT (0x01 0x35) 卫星信息 ----------------
 * 为什么它比 GSV 强：**它是轮询式的**——发一个空载荷请求，接收机立刻回一帧
 * 含全部卫星的 cno/elev/azim/svUsed。全程不需要改任何设备配置，
 * 因此在"保守测试、不动设备参数"的阶段完全可用。
 *
 * 实测背景：这台 SR1612U10 的 NMEA GSV 里 C/No 字段整段为空，
 * 导致多径的信噪比类诊断全废；而 UBX-NAV-SAT 是另一条完全独立的取数通道。
 *
 * 载荷（协议 27 / M10，version 1）：
 *   头 8 字节：iTOW U4 | version U1 | numSvs U1 | reserved0 U1[2]
 *   随后每颗卫星 12 字节：
 *     +0 gnssId U1 | +1 svId U1 | +2 cno U1(dBHz) | +3 elev I1(deg)
 *     +4 azim I2(deg) | +6 prRes I2 | +8 flags X4
 *   flags: bit0-2 qualityInd | bit3 svUsed | bit4-5 health
 */
const NAV_SAT_GNSS = {
  0: 'GPS', 1: 'SBS', 2: 'GAL', 3: 'BD', 4: 'IMES', 5: 'QZS', 6: 'GLO', 7: 'NAV'
};

/**
 * UBX 报文名表 —— 从官方手册 M10/F10 SPG 7.0x 的报文清单逐条提取（共 90 条）。
 *
 * 为什么要这张表：真机日志里冒出了 `0x27/0x00`（397 帧）、`0x03/0x09`、`0x0C/0x31`
 * 这些**手册里根本没有**的帧。以前只能看到 `class=0x27 id=0x0 len=68` 这种天书，
 * 现在能一眼分出"这是手册里有的报文"和"这是手册里没有的、得去查原始字节"。
 *
 * ⚠️ 表里没有 ≠ 帧是坏的 —— 帧的校验和是验过的。只说明它不是 u-blox 公开协议的一部分
 *    （可能是厂商私有、也可能是更新固件新增的）；结论要落在原始字节上，不能靠推测。
 */
const UBX_MSG_NAMES = {
  '0x01/0x01': 'NAV-POSECEF',
  '0x01/0x02': 'NAV-POSLLH',
  '0x01/0x03': 'NAV-STATUS',
  '0x01/0x04': 'NAV-DOP',
  '0x01/0x07': 'NAV-PVT',
  '0x01/0x09': 'NAV-ODO',
  '0x01/0x10': 'NAV-RESETODO',
  '0x01/0x11': 'NAV-VELECEF',
  '0x01/0x12': 'NAV-VELNED',
  '0x01/0x20': 'NAV-TIMEGPS',
  '0x01/0x21': 'NAV-TIMEUTC',
  '0x01/0x22': 'NAV-CLOCK',
  '0x01/0x23': 'NAV-TIMEGLO',
  '0x01/0x24': 'NAV-TIMEBDS',
  '0x01/0x25': 'NAV-TIMEGAL',
  '0x01/0x26': 'NAV-TIMELS',
  '0x01/0x27': 'NAV-TIMEQZSS',
  '0x01/0x32': 'NAV-SBAS',
  '0x01/0x34': 'NAV-ORB',
  '0x01/0x35': 'NAV-SAT',
  '0x01/0x36': 'NAV-COV',
  '0x01/0x39': 'NAV-GEOFENCE',
  '0x01/0x42': 'NAV-SLAS',
  '0x01/0x43': 'NAV-SIG',
  '0x01/0x60': 'NAV-AOPSTATUS',
  '0x01/0x61': 'NAV-EOE',
  '0x01/0x63': 'NAV-TIMENAVIC',
  '0x02/0x13': 'RXM-SFRBX',
  '0x02/0x14': 'RXM-MEASX',
  '0x02/0x15': 'RXM-RAWX',
  '0x02/0x41': 'RXM-PMREQ',
  '0x02/0x59': 'RXM-RLM',
  '0x04/0x00': 'INF-ERROR',
  '0x04/0x01': 'INF-WARNING',
  '0x04/0x02': 'INF-NOTICE',
  '0x04/0x03': 'INF-TEST',
  '0x04/0x04': 'INF-DEBUG',
  '0x05/0x00': 'ACK-NAK',
  '0x05/0x01': 'ACK-ACK',
  '0x06/0x04': 'CFG-RST',
  '0x06/0x13': 'CFG-ANT',
  '0x06/0x8a': 'CFG-VALSET',
  '0x06/0x8b': 'CFG-VALGET',
  '0x06/0x8c': 'CFG-VALDEL',
  '0x09/0x14': 'UPD-SOS',
  '0x0a/0x02': 'MON-IO',
  '0x0a/0x04': 'MON-VER',
  '0x0a/0x06': 'MON-MSGPP',
  '0x0a/0x07': 'MON-RXBUF',
  '0x0a/0x08': 'MON-TXBUF',
  '0x0a/0x21': 'MON-RXR',
  '0x0a/0x27': 'MON-PATCH',
  '0x0a/0x28': 'MON-GNSS',
  '0x0a/0x31': 'MON-SPAN',
  '0x0a/0x32': 'MON-BATCH',
  '0x0a/0x36': 'MON-COMMS',
  '0x0a/0x37': 'MON-HW3',
  '0x0a/0x38': 'MON-RF',
  '0x0a/0x39': 'MON-SYS',
  '0x0a/0x3b': 'MON-POST',
  '0x0d/0x01': 'TIM-TP',
  '0x0d/0x03': 'TIM-TM2',
  '0x0d/0x06': 'TIM-VRFY',
  '0x13/0x00': 'MGA-GPS',
  '0x13/0x02': 'MGA-GAL',
  '0x13/0x03': 'MGA-BDS',
  '0x13/0x05': 'MGA-QZSS',
  '0x13/0x06': 'MGA-GLO',
  '0x13/0x20': 'MGA-ANO',
  '0x13/0x21': 'MGA-FLASH',
  '0x13/0x40': 'MGA-INI',
  '0x13/0x60': 'MGA-ACK',
  '0x13/0x80': 'MGA-DBD',
  '0x21/0x03': 'LOG-ERASE',
  '0x21/0x04': 'LOG-STRING',
  '0x21/0x07': 'LOG-CREATE',
  '0x21/0x08': 'LOG-INFO',
  '0x21/0x09': 'LOG-RETRIEVE',
  '0x21/0x0b': 'LOG-RETRIEVEPOS',
  '0x21/0x0e': 'LOG-FINDTIME',
  '0x21/0x0f': 'LOG-',
  '0x21/0x10': 'LOG-RETRIEVEBATCH',
  '0x27/0x03': 'SEC-UNIQID',
  '0x27/0x09': 'SEC-SIG',
  '0x27/0x10': 'SEC-SIGLOG',
  '0xf1/0x00': 'POSITION',
  '0xf1/0x03': 'SVSTATUS',
  '0xf1/0x04': 'TIME',
  '0xf1/0x40': 'RATE',
  '0xf1/0x41': 'CONFIG'
};

/** class/id 的短写，日志里统一用它 */
function msgKey(cls, id) {
  return '0x' + cls.toString(16).padStart(2, '0') + '/0x' + id.toString(16).padStart(2, '0');
}

/** 报文名；手册里没有的返回 ''（调用方据此标"未知"） */
function msgName(cls, id) {
  return UBX_MSG_NAMES[msgKey(cls, id)] || '';
}

const NAV_SAT_QUALITY = {
  0: '无信号', 1: '搜索中', 2: '已捕获', 3: '有信号但不可用',
  4: '码锁定+时间同步', 5: '码/载波锁定', 6: '码/载波锁定', 7: '码/载波锁定'
};

/** UBX-NAV-SAT 轮询请求（空载荷，8 字节） */
function navSatPoll() {
  return frame(0x01, 0x35, []);
}

// ---------------------------------------------------------------- NAV-SIG
// 16 字节/信号（手册：structure 0xb5 0x62 0x01 0x43   8 + numSigs·16）。
// 偏移已逐条与手册核对：gnssId 8+n·16 / svId 9+n·16 / sigId 10+n·16 /
// freqId 11+n·16 / prRes 12+n·16 / cno 14+n·16 / qualityInd 15+n·16 /
// corrSource 16+n·16 / ionoModel 17+n·16 / sigFlags 18+n·16。
const NAV_SIG_CORR = {
  0: '无改正', 1: 'SBAS', 2: '北斗', 3: 'RTCM2', 4: 'RTCM3-OSR', 5: 'RTCM3-SSR',
  6: 'QZSS-SLAS', 7: 'SPARTN', 9: 'CLAS', 10: 'LPP-OSR', 11: 'LPP-SSR', 12: 'GAL-HAS'
};
const NAV_SIG_IONO = {
  0: '无模型', 1: 'GPS Klobuchar', 2: 'SBAS 模型', 3: '北斗 Klobuchar',
  4: 'Galileo NTCM', 7: '本地估计', 8: '双频反演', 9: '多频观测', 11: '默认延迟值'
};
const NAV_SIG_QUALITY = {
  0: '无信号', 1: '搜索中', 2: '已捕获', 3: '有信号但不可用',
  4: '码锁定+时间同步', 5: '码/载波锁定', 6: '码/载波锁定+同步', 7: '码/载波锁定+同步'
};

/**
 * 解析 UBX-NAV-SIG（每颗星每个频点的信号信息）。
 *
 * ★★ 这条报文一直是链路上收得到的（真机每次会话 98~100 帧），却从来没解析过 ——
 *    而它恰好装着回答"SBAS 到底有没有在起作用""载波用没用上"的全部证据：
 *
 *   · `corrSource`  —— 该信号用的是哪种**改正源**（1 = SBAS 改正，2 = 北斗改正 …）
 *   · `ionoModel`   —— 该信号用的是哪个**电离层模型**（2 = SBAS 模型，
 *                      1 = GPS Klobuchar，3 = 北斗 Klobuchar，7 = 本地估计 …）
 *   · `prCorrUsed`  —— ★ 伪距改正**是否真的被应用**到这个信号上
 *   · `crUsed`      —— ★ 载波测距**是否被用于**这个信号（逐信号回答载波相位问题）
 *   · `crCorrUsed`  —— 载波测距改正是否被应用
 *   · `prSmoothed`  —— 伪距是否已被**载波平滑**（即"载波平滑伪距"是不是本来就开着）
 *
 * ⚠️ 长度 != 8 + numSigs·16 就拒绝，绝不硬解。
 */
function decodeNavSig(payload) {
  const b = Array.from(payload);
  if (b.length < 8) return { ok: false, reason: '载荷过短（' + b.length + ' 字节）' };
  const numSigs = b[5];
  const expect = 8 + numSigs * 16;
  if (b.length !== expect) {
    return {
      ok: false,
      reason: '布局不符：numSigs=' + numSigs + ' 实际载荷 ' + b.length
        + ' 字节，按 16 字节/信号应为 ' + expect + ' 字节'
    };
  }
  const u2 = (o) => b[o] | (b[o + 1] << 8);
  const i2 = (o) => { const v = u2(o); return v > 32767 ? v - 65536 : v; };

  const sigs = [];
  for (let i = 0; i < numSigs; i++) {
    const o = 8 + i * 16;
    const f = u2(o + 10);                    // sigFlags（X2）
    const corrSource = b[o + 8];
    const ionoModel = b[o + 9];
    sigs.push({
      gnssId: b[o], sys: NAV_SAT_GNSS[b[o]] || ('ID' + b[o]),
      svId: b[o + 1], sigId: b[o + 2], freqId: b[o + 3],
      prRes: i2(o + 4) / 10,                 // 0.1 m
      cno: b[o + 6],
      qualityInd: b[o + 7], qualityText: NAV_SIG_QUALITY[b[o + 7]] || '—',
      corrSource, corrText: NAV_SIG_CORR[corrSource] || ('未知(' + corrSource + ')'),
      ionoModel, ionoText: NAV_SIG_IONO[ionoModel] || ('未知(' + ionoModel + ')'),
      health: f & 0x03,                      // 0 未知 / 1 健康 / 2 不健康
      prSmoothed: !!(f & 0x04),
      prUsed: !!(f & 0x08),
      crUsed: !!(f & 0x10),
      doUsed: !!(f & 0x20),
      prCorrUsed: !!(f & 0x40),
      crCorrUsed: !!(f & 0x80),
      doCorrUsed: !!(f & 0x100)
    });
  }
  const count = (fn) => sigs.filter(fn).length;
  const tally = (key) => {
    const m = {};
    for (const s of sigs) m[s[key]] = (m[s[key]] || 0) + 1;
    return m;
  };
  return {
    ok: true, numSigs, sigs,
    used: count(s => s.prUsed),
    smoothed: count(s => s.prSmoothed),
    crUsed: count(s => s.crUsed),
    prCorrUsed: count(s => s.prCorrUsed),
    crCorrUsed: count(s => s.crCorrUsed),
    doCorrUsed: count(s => s.doCorrUsed),
    corrSources: tally('corrSource'),
    ionoModels: tally('ionoModel')
  };
}

/**
 * 把 corrSources / ionoModels 这类"值→条数"的表转成可读文本，例如
 *   {0: 30, 1: 12} + NAV_SIG_CORR  →  "SBAS×12  无改正×30"
 */
function tallyText(map, dict) {
  const keys = Object.keys(map || {}).sort((a, b) => map[b] - map[a]);
  if (!keys.length) return '—';
  return keys.map(k => (dict[k] || ('未知' + k)) + '×' + map[k]).join('  ');
}

// 固定 92 字节（手册：structure 0xb5 0x62 0x01 0x07 92）。
// 布局锚点已逐条与官方手册核对：iTOW@0 / year@4 / month@6 / day@7 / hour@8 /
// min@9 / sec@10 / valid@11 / numSV@23 / headVeh@84 / magDec@88 / reserved0@80。
const NAV_PVT_LEN = 92;
const PVT_FIX_TYPE = {
  0: '无定位', 1: '航位推算', 2: '2D', 3: '3D', 4: 'GNSS+航位推算', 5: '仅时间'
};

/**
 * ★★ 载波相位解算状态（flags 的 bit7…6）。手册原文：
 *   "Carrier phase range solution status:
 *      • 2 = carrier phase range solution with fixed ambiguities
 *      • 1 = carrier phase range solution with floating ambiguities
 *      • 0 = no carrier phase range solution"
 *
 *   这是**判断"这台设备到底做不做载波相位/RTK"最直接的证据** ——
 *   比看芯片型号、比猜都硬。而且它就在我们每秒都在收的 NAV-PVT 里。
 */
const PVT_CARR_SOLN = {
  0: '无载波相位解（单点）',
  1: '浮点解 float（载波相位，模糊度未固定）',
  2: '固定解 fixed（载波相位，模糊度已固定）'
};

/**
 * 解析 UBX-NAV-PVT（定位/速度/时间解，固定 92 字节）。
 *
 * ⚠️ 长度不等于 92 就**拒绝解析**，绝不按固定布局硬解 —— 宁可没有，也不要给出错位的数。
 */
function decodeNavPvt(payload) {
  const b = Array.from(payload);
  if (b.length !== NAV_PVT_LEN) {
    return {
      ok: false,
      reason: 'NAV-PVT 载荷应为 ' + NAV_PVT_LEN + ' 字节，实际 ' + b.length
        + '（拒绝按固定布局硬解）'
    };
  }
  const u2 = (o) => b[o] | (b[o + 1] << 8);
  const u4 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const i4 = (o) => { const v = u4(o); return v > 0x7fffffff ? v - 0x100000000 : v; };
  const i2 = (o) => { const v = u2(o); return v > 32767 ? v - 65536 : v; };

  const flags = b[21], flags2 = b[22];
  const carrSoln = (flags >> 6) & 0x03;
  return {
    ok: true,
    iTOW: u4(0),
    year: u2(4), month: b[6], day: b[7], hour: b[8], min: b[9], sec: b[10],
    valid: b[11],
    tAcc: u4(12), nano: i4(16),
    fixType: b[20],
    fixText: PVT_FIX_TYPE[b[20]] || ('未知(' + b[20] + ')'),
    // ★ flags
    gnssFixOK: !!(flags & 0x01),     // bit0 有效定位
    diffSoln: !!(flags & 0x02),      // bit1 ★ 差分改正**已应用**（SBAS 有没有真在用，看这里）
    psmState: (flags >> 2) & 0x07,
    headVehValid: !!(flags & 0x20),
    carrSoln,                        // bit7…6 ★ 载波相位解算状态
    carrSolnText: PVT_CARR_SOLN[carrSoln] || '—',
    // ★ flags2
    diffCorr: !!(flags2 & 0x01),     // bit0 差分改正**可用**
    carrSolnValid: !!(flags2 & 0x02),// bit1 carrSoln 字段本身是否有效
    numSV: b[23],                    // ★ 不受 NMEA 兼容模式 12 上限约束
    lon: i4(24) * 1e-7, lat: i4(28) * 1e-7,
    height: i4(32) / 1000, hMSL: i4(36) / 1000,
    hAcc: u4(40) / 1000, vAcc: u4(44) / 1000,   // ★ 接收机自估水平/垂直精度（米）
    velN: i4(48), velE: i4(52), velD: i4(56),
    gSpeed: i4(60),                  // mm/s
    headMot: i4(64) * 1e-5, sAcc: u4(68), headAcc: u4(72) * 1e-5,
    pDOP: u2(76) / 100,
    headVeh: i4(84) * 1e-5,
    magDec: i2(88) * 1e-2, magAcc: i2(90) * 1e-2
  };
}

/**
 * 解析 UBX-NAV-SAT 响应。
 * ⚠️ 布局是按 version 1（12 字节/颗）解析的。若实际长度对不上，
 *    不猜、不硬解——把实际长度与推算长度都返回，用真实数据来定布局。
 */
function decodeNavSat(payload) {
  const b = Array.from(payload);
  if (b.length < 8) return { ok: false, reason: '载荷过短（' + b.length + ' 字节）' };
  const u4 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const i1 = (o) => (b[o] > 127 ? b[o] - 256 : b[o]);
  const i2 = (o) => { const v = b[o] | (b[o + 1] << 8); return v > 32767 ? v - 65536 : v; };

  const version = b[4];
  const numSvs = b[5];
  const GROUP = 12;
  const expect = 8 + numSvs * GROUP;
  if (b.length !== expect) {
    return {
      ok: false,
      reason: '布局不符：version=' + version + ' numSvs=' + numSvs
        + ' 实际载荷 ' + b.length + ' 字节，按 v1（12字节/颗）应为 ' + expect + ' 字节',
      version, numSvs, actualLen: b.length, expectLen: expect
    };
  }

  const sats = [];
  for (let i = 0; i < numSvs; i++) {
    const o = 8 + i * GROUP;
    const flags = u4(o + 8);
    sats.push({
      gnssId: b[o],
      sys: NAV_SAT_GNSS[b[o]] || ('ID' + b[o]),
      svId: b[o + 1],
      cno: b[o + 2],                       // ★ 这就是 NMEA GSV 里缺的那个信噪比
      elev: i1(o + 3),
      azim: i2(o + 4),
      prRes: i2(o + 6),
      qualityInd: flags & 0x07,
      qualityText: NAV_SAT_QUALITY[flags & 0x07] || '—',
      used: !!(flags & 0x08),              // bit3 = svUsed
      health: (flags >> 4) & 0x03,
      healthy: ((flags >> 4) & 0x03) === 1
    });
  }
  const withCno = sats.filter(s => s.cno > 0);
  const used = sats.filter(s => s.used);
  const avg = withCno.length
    ? withCno.reduce((a, s) => a + s.cno, 0) / withCno.length : 0;
  return {
    ok: true,
    version, numSvs,
    iTOW: u4(0),
    sats,
    withCno: withCno.length,
    usedCount: used.length,
    avgCno: avg ? avg.toFixed(1) : '—'
  };
}

/**
 * 字节流分离器：BT 透传通道上 NMEA 文本与 UBX 二进制会混在一起，
 * 必须按前导码 B5 62 切出 UBX 帧，其余按文本（NMEA）交给解析管线。
 * 否则 UBX 里的任意字节（含 \n）会污染 NMEA 解析。
 */
class FrameSplitter {
  constructor(maxBuf = 4096) {
    this.buf = [];
    this.maxBuf = maxBuf;
  }

  reset() { this.buf = []; }

  /**
   * @param {Uint8Array|number[]} bytes
   * @returns {{frames: number[][], text: string, invalid: number}}
   */
  push(bytes) {
    const out = { frames: [], text: '', invalid: 0 };
    for (let k = 0; k < bytes.length; k++) this.buf.push(bytes[k]);
    const B = this.buf;
    const textBytes = [];
    let i = 0;

    while (i < B.length) {
      // 找下一个前导码
      let p = -1;
      for (let j = i; j + 1 < B.length; j++) {
        if (B[j] === 0xB5 && B[j + 1] === 0x62) { p = j; break; }
      }
      if (p < 0) {
        // 没有前导码：全部按文本，但末尾可能的 0xB5 留给下一批
        let end = B.length;
        if (B[end - 1] === 0xB5) end -= 1;
        for (let j = i; j < end; j++) textBytes.push(B[j]);
        i = end;
        break;
      }
      // 前导码之前的字节是文本
      for (let j = i; j < p; j++) textBytes.push(B[j]);

      if (B.length - p < 6) { i = p; break; }              // 头部还不全
      const len = B[p + 4] | (B[p + 5] << 8);
      const total = 6 + len + 2;
      if (B.length - p < total) { i = p; break; }           // 载荷还不全

      const f = B.slice(p, p + total);
      if (parse(f).ok) out.frames.push(f);
      else out.invalid++;
      i = p + total;
    }

    this.buf = B.slice(i);
    if (this.buf.length > this.maxBuf) this.buf = this.buf.slice(-1024);

    let s = '';
    for (let k = 0; k < textBytes.length; k++) s += String.fromCharCode(textBytes[k]);
    out.text = s;
    return out;
  }
}

/**
 * 精度字段的「无效值」。
 *
 * ⚠️ 现场实测（2026-09-18 无定位状态）：NAV-PVT 在**没有定位解**时，
 * hAcc/vAcc 返回的是 **0xFFFFFFFF mm = 4294967.295 m** —— 这是 u-blox 的
 * "无效"哨兵值，不是精度。我们一度把它当真值显示，界面上出现
 * 「接收机自估 水平 ±4294967.29 m」，现场看到只会以为设备坏了。
 * $GNGST 无定位时也回一串同类垃圾（stdLat/stdLon/stdAlt 都是 3750023）。
 *
 * 判据：**没有定位解，精度就无从谈起**；另外真值也不可能超过 1 km。
 */
const ACC_ABSURD_M = 1000;

/** 精度估计是否可用（fixOk = NAV-PVT 的 gnssFixOK，或 GGA/GSA 的定位质量 > 0） */
function accValid(v, fixOk) {
  return !!fixOk && typeof v === 'number' && isFinite(v) && v >= 0 && v < ACC_ABSURD_M;
}

/** 精度估计的显示文本：不可用时一律 '—'，绝不把哨兵值当数字显示 */
function accText(v, fixOk, digits) {
  if (!accValid(v, fixOk)) return '—';
  return v.toFixed(digits == null ? 2 : digits);
}

/**
 * UBX-MON-COMMS (0x0a/0x36) —— 通信端口状态。
 *
 * ★★ 这条报文是我们解开「蓝牙下行到底通不通」这个悬案的钥匙。
 *    它按端口给出 **rxBytes（本端口收到过多少字节）**、txBytes、msgs（每种协议
 *    成功解析了多少条）、overrunErrs、skipped。手册载荷结构（已逐字段核对）：
 *
 *      偏移            类型      含义
 *      0  version      U1
 *      1  nCh          U1        端口数
 *      2  flags        X1
 *      3  reserved0    U1
 *      4  protIds      U1[4]     每种协议的编号
 *      之后每个端口 40 字节（n = 0..nCh-1，偏移都相对载荷起点）：
 *      8+n·40  chInfo      X1     低 2 位 = 端口号
 *      9+n·40  txPending   U2
 *      12+n·40 txBytes     U4     本端口发出过的字节数
 *      16+n·40 txUsage     U1 %
 *      17+n·40 txPeakUsage U1 %
 *      18+n·40 rxPending   U2     接收缓冲里还有多少字节
 *      20+n·40 rxBytes     U4 ★★ 本端口**收到过**的字节数
 *      24+n·40 rxUsage     U1 %
 *      25+n·40 rxPeakUsage U1 %
 *      26+n·40 overrunErrs U2
 *      28+n·40 msgs        U2[4]  每种协议成功解析的条数
 *      36+n·40 reserved1   U1[8]
 *      44+n·40 skipped     U4
 *
 * 怎么用它定性下行问题（我们卡了很久的那个）：
 *   · 我们通过蓝牙写一批字节 → 再看 rxBytes：
 *       没变   → 字节**根本没到接收机**（BT04 的下行线没接）
 *       变了但 msgs 没变 → 到了但没被解析（该端口输入协议没开）
 *       都变了 → 到了也解析了，那就只是没回 ACK
 */
const MON_COMMS_PORT_BYTES = 40;
const MON_COMMS_PORT_NAME = {
  0: 'I2C', 1: 'UART1', 2: 'UART2', 3: 'USB', 4: 'SPI'
};
const MON_COMMS_PROTO = { 0: 'UBX', 1: 'NMEA', 2: 'RTCM3', 5: 'SPARTN' };

function decodeMonComms(payload) {
  const b = payload;
  if (!b || b.length < 8) return { ok: false, reason: '载荷过短（至少要 8 字节头）' };
  const nCh = b[1];
  const expect = 8 + nCh * MON_COMMS_PORT_BYTES;
  if (b.length !== expect) {
    return { ok: false, reason: '长度对不上：头里 nCh=' + nCh
      + ' 应为 ' + expect + ' 字节（8 + nCh·40），实际 ' + b.length + ' 字节' };
  }
  const u2 = (o) => b[o] | (b[o + 1] << 8);
  const u4 = (o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const ports = [];
  for (let n = 0; n < nCh; n++) {
    const o = 8 + n * MON_COMMS_PORT_BYTES;
    const chInfo = b[o];
    const msgs = [];
    for (let k = 0; k < 4; k++) {
      const v = u2(o + 20 + k * 2);
      if (v > 0) msgs.push((MON_COMMS_PROTO[k] || ('协议' + k)) + '×' + v);
    }
    ports.push({
      portId: chInfo & 0x03,
      portName: MON_COMMS_PORT_NAME[chInfo & 0x03] || ('端口' + (chInfo & 0x03)),
      txBytes: u4(o + 4),
      txUsage: b[o + 8], txPeakUsage: b[o + 9],
      rxPending: u2(o + 10),
      rxBytes: u4(o + 12),          // ★ 收到的字节总数
      rxUsage: b[o + 16], rxPeakUsage: b[o + 17],
      overrunErrs: u2(o + 18),
      msgs, msgsText: msgs.length ? msgs.join(' ') : '无',
      skipped: u4(o + 36)
    });
  }
  return {
    ok: true, version: b[0], nCh, flags: b[2],
    protIds: [b[4], b[5], b[6], b[7]], ports
  };
}

module.exports = {
  checksum, frame, parse, toHex, FrameSplitter,
  // 新式键值配置接口（M10/F10 实际使用）
  cfgValSet, cfgValGet, decodeValGet, keySize, keyLabel, KEY, KEY_NAME,
  LAYER_BIT, LAYER_ONE,
  // 卫星信息轮询（无需改设备配置，是 NMEA GSV 缺 C/No 时的替代取数通道）
  navSatPoll, decodeNavSat, NAV_SAT_GNSS,
  // 定位/速度/时间解（含 diffSoln 与 carrSoln —— 回答"SBAS 用上了吗""做不做载波相位"）
  decodeNavPvt, NAV_PVT_LEN, PVT_CARR_SOLN, PVT_FIX_TYPE,
  // ★ 精度的"无效值"判据：无定位时 hAcc/vAcc 是 0xFFFFFFFF 哨兵，不能当数字显示
  ACC_ABSURD_M, accValid, accText,
  // 逐信号的改正来源/电离层模型/伪距与载波是否被使用（回答"SBAS 到底有没有在起作用"）
  decodeNavSig, tallyText,
  NAV_SIG_CORR, NAV_SIG_IONO, NAV_SIG_QUALITY,
  // ★ 端口收发字节数（回答"蓝牙下行到底通不通"：看 rxBytes 动不动）
  decodeMonComms, MON_COMMS_PORT_NAME, MON_COMMS_PROTO,
  // 报文名表（手册里没有的帧要能一眼认出来）
  UBX_MSG_NAMES, msgKey, msgName,
  // 旧式（M10 不支持，保留作参考）
  cfgNav5, cfgNav5Poll, decodeNav5, MASK,
  DYN_MODEL: { PORTABLE: 0, STATIONARY: 2, PEDESTRIAN: 3, AUTOMOTIVE: 4, SEA: 5 }
};
