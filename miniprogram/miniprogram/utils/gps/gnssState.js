// utils/gps/gnssState.js —— 聚合 NMEA 各语句，维护一份可按帧渲染的 GNSS 状态
const {
  parseLine, fixQualityText, checksumOk,
  SYS_LABEL, SYS_COLOR
} = require('./nmea');
// 只借一个判据：精度字段是不是"无效哨兵值"。
// 无定位时 $GNGST 与 UBX-NAV-PVT 都会返回哨兵（实测 stdLat/stdLon/stdAlt 全是
// 3750023，hAcc 是 0xFFFFFFFF mm），两边必须用同一把尺子，否则界面和门面会各说各话。
// ubx.js 不依赖本文件，不存在循环引用。
const { accValid } = require('./ubx');

const STALE_MS = 6000;        // 超过此时长未出现的卫星视为已消失
const GSA_FRESH_MS = 3000;    // GSA 的"在用"标记超过此时长就不再用于回填新卫星
const RAW_KEEP = 40;          // 原始语句环形缓冲长度

// 单点/差分等不同解算质量对应的等效测距误差（米），用于估算水平精度
const UERE = { 0: 5.0, 1: 2.0, 2: 0.8, 4: 0.02, 5: 0.3, 6: 1.5, 7: 1.0 };
const FIX_TYPE_TEXT = { 1: 'NO FIX', 2: '2D FIX', 3: '3D FIX' };

class GnssState {
  constructor() {
    this.reset();
  }

  reset() {
    this.sats = {};                 // 'SYS-PRN' -> {sys,prn,el,az,snr,used,seen}
    this.dop = { pdop: null, hdop: null, vdop: null };
    this.gsaFix = 1;
    this.pos = { lat: null, lng: null, alt: null, sats: 0, hdop: null, fixQuality: 0, utc: '' };
    this.motion = { speedKnots: 0, speedKmh: 0, course: 0 };
    this.date = '';
    this.raw = [];
    this._rawSeq = 0;
    this._gsvSeenSys = {};          // GSV 枚举过的星座（GSA 一致性统计的预热判断用）
    this._gsaUsed = {};             // 各星座最近一次 GSA 的"在用"集合（权威依据）
    this.lastPubx = null;           // 最近一次 $PUBX,03（带 cno）
    this.lastPubxAt = 0;            // 它的到达时间（判断新鲜度）
    this.lastPubx00 = null;
    this.gst = null;                // 最近一条 （接收机自估精度）
    this.gstAt = 0;
    this.io = {
      sentences: 0, bytes: 0, gsv: 0, gsa: 0, gga: 0,
      gsvTalker: {}, gsaTalker: {},      // 按报文头统计，用来区分"没收到"和"报文头不认识"
      gsvInView: {},                     // 各报文头 GSV 自报的"可见卫星数"
      gsvShape: {},                      // 各报文头 GSV 的 totalMsgs/msgNum/本句星数 分布
      gsvSigIds: {}, gsvNoSigId: 0,       // signalId 分组统计（u-blox 按 signalId 重复输出多套 GSV）
      pubx: 0, pubxSample: '',           // $PUBX 语句条数 / 第一条原文（u-blox 私有，带 cno）
      pubx00: 0, pubx00Sample: '',       // $PUBX,00 条数 —— 只有被轮询才会出现，是下行通路的证据
      badCk: 0,                          // 校验和失败的语句数（数据在传输中损坏的直接证据）
      gsvSnrOk: 0, gsvSnrEmpty: 0,       // GSV 里带 cno 的条数 / cno 全空的条数
      gsaPrns: 0, gsaUnknown: 0,         // GSA 列出的编号总数 / 其中 GSV 里根本没有的
      gst: 0,                            // $GNGST 条数（接收机自估精度）
      // ★ 导航频率：GGA 每个导航历元输出一条，所以 GGA 条数 = 历元数。
      //   接收机被改成几 Hz，看这个最快 —— 比数"句/秒"可靠得多
      //   （句/秒还受 GSV 条数随可见卫星数变化的影响）。
      firstAt: 0,                        // 第一条语句的时刻（算平均频率的基准）
      _winStart: Date.now(), _winCount: 0, rate: 0
    };
    this.lastAt = 0;
  }

  /** 喂入一行 NMEA；返回解析结果（未识别返回 null） */
  feed(line) {
    if (!line || line[0] !== '$') return null;
    const now = Date.now();
    this.lastAt = now;
    this.io.sentences++;
    if (!this.io.firstAt) this.io.firstAt = now;
    this.io.bytes += line.length + 2;
    this.io._winCount++;

    // 每秒统计一次语句速率
    if (now - this.io._winStart >= 1000) {
      const secs = (now - this.io._winStart) / 1000;
      this.io.rate = Math.round(this.io._winCount / secs);
      this.io._winStart = now;
      this.io._winCount = 0;
    }

    this.raw.push({ seq: ++this._rawSeq, text: line });
    if (this.raw.length > RAW_KEEP) this.raw.shift();

    const m = parseLine(line);
    if (!m) {
      // ⚠️ 必须区分"校验和失败"与"我们不认识的语句类型"：
      //    前者是**数据在传输中损坏**的直接证据（BLE 分片/丢字节），后者只是没解析而已。
      //    实测：监测台的卫星明细里信噪比条会"闪现一两秒就消失"，
      //    而校验和失败次数此前从未统计 —— 这个盲区必须补上。
      if (line.indexOf('*') > 0 && !checksumOk(line)) this.io.badCk++;
      return null;
    }

    switch (m.type) {
      case 'GSV':
        this.io.gsv++;
        {
          const tk = line.slice(1, 3);
          this.io.gsvTalker[tk] = (this.io.gsvTalker[tk] || 0) + 1;
          // GSV 第 4 字段 = 接收机自报的"可见卫星数"。
          // 与 rawSats().length 对照，就能区分"接收机真的只看见这么多"
          // 和"我们聚合时把它漏掉了"（实测出现过后者）。
          // ⚠️ 必须按 (报文头 + signalId) 分别记！同一星座有多组 GSV，
          //    每组自报的"可见数"只覆盖该组。只按报文头记的话，
          //    后到的那组会把前一组的数字覆盖掉（实测：读到的是 signalId=0
          //    那条小报文的 "3 颗"，而真正在跟踪的有 12 颗）。
          const sid = m.signalId == null ? '?' : m.signalId;
          if (m.msgNum === 1 || this.io.gsvInView[tk + '/sid' + sid] == null) {
            this.io.gsvInView[tk + '/sid' + sid] = m.satsInView;
          }
          // 【totalMsgs/msgNum 分布】—— 用来判断"到底是几条 GSV 组成一轮枚举"。
          // 实测矛盾：GP 约 4 条/秒，但自报可见只有 3 颗（3 颗只需 1 条）。
          // 只有看到这个分布才能确定是"模块重复发"还是"字段含义与预期不同"。
          const sh = this.io.gsvShape[tk] || (this.io.gsvShape[tk] = {});
          const sk = m.totalMsgs + '/' + m.msgNum + '/' + m.sats.length;
          sh[sk] = (sh[sk] || 0) + 1;
          // 【signalId 分组统计】—— u-blox 按 signalId 重复输出多套 GSV，
          // 每组的 msgNum 各自从 1 开始。这是本机卫星数/信噪比长期对不上的根因，
          // 单独统计出来，避免以后再被"某一条 msgNum=1 的小报文"误导。
          const sidKey = tk + '/sid' + (m.signalId == null ? '?' : m.signalId);
          this.io.gsvSigIds[sidKey] = (this.io.gsvSigIds[sidKey] || 0) + 1;
          if (m.signalId == null) this.io.gsvNoSigId++;
        }
        this._applyGSV(m, now);
        break;
      case 'GSA':
        this.io.gsa++;
        { const tk = line.slice(1, 3); this.io.gsaTalker[tk] = (this.io.gsaTalker[tk] || 0) + 1; }
        this._applyGSA(m, now);
        break;
      case 'GGA': this.io.gga++; this._applyGGA(m); break;
      case 'RMC': this._applyRMC(m); break;
      case 'VTG': this._applyVTG(m); break;
      // ★ $GNGST：接收机自己给出的精度估计（伪距残差统计）。
      //   它是唯一一个**独立于我们评分**的"这个点准不准"的数字，
      //   用来对照 qualityScore 有没有跑偏（见 nmea.parseGST 的说明）。
      case 'GST':
        this.io.gst++;
        this.gst = m;
        this.gstAt = now;
        break;
      case 'PUBX03':
        // u-blox 私有语句，带 cno。GSV 的 C/No 为空时这是另一条纯 NMEA 取数通道。
        // ★ $PUBX,03*30 是官方定义的**只读轮询**，回一条就带全部卫星的信噪比。
        this.io.pubx++;
        if (!this.io.pubxSample) this.io.pubxSample = line.slice(0, 110);
        this.lastPubx = m;
        this.lastPubxAt = now;
        break;
      case 'PUBX00':
        // 只有被轮询时才会出现 → 收到它就证明「我们写下去的东西到达了接收机」
        this.io.pubx00++;
        if (!this.io.pubx00Sample) this.io.pubx00Sample = line.slice(0, 110);
        this.lastPubx00 = m;
        break;
    }
    return m;
  }

  _applyGSV(m, now) {
    // ★ 把"这条 GSV 到底带不带信噪比"记下来。
    //   实测现象：监测台的卫星明细里信噪比条会闪现一两秒就消失 ——
    //   说明 C/No 不是"从来没有"，而是**间歇性出现**。
    //   这两个计数器把"肉眼可见的闪动"变成可以对照的数字。
    let anyCno = false;
    for (const s of m.sats) { if (s.snr != null && s.snr > 0) { anyCno = true; break; } }
    if (anyCno) this.io.gsvSnrOk++; else this.io.gsvSnrEmpty++;

    // 每个星座的第 1 条消息到达时，重新开始枚举该星座的卫星。
    //
    // ⚠️ 真机的发送顺序是 RMC → VTG → GGA → GSA×3 → GSV…
    //    GSA 在 GSV **之前**。所以：
    //    ① 重建卫星时不能用"默认 false"，否则 GSA 刚打上的"在用"标记会被
    //       紧接着的 GSV 抹掉，activeCount() 永远是 0（实测踩过）；
    //    ② 第一轮尤其明显 —— GSA 到达时 GSV 还没来，一颗卫星都还没有，
    //       等 GSV 建出卫星时 GSA 已经过去了，于是第一秒的"在用"也是 0。
    //    解决：把最近一次 GSA 的"在用"集合作为权威依据，GSV 建卫星时据此回填。
    // ★★★ 这里曾经是最大的一个坑：原来是"看到 msgNum===1 就把该星座整个删掉重建"。
    //
    //   为什么错：u-blox 会**按 signalId 分组**重复输出 GSV，每组的 msgNum 各自从 1 开始。
    //   实测本机：
    //     $GPGSV,3,1,12,...,1*64   ← signalId=1：已跟踪的 12 颗，**带 cno**，一轮 3 条
    //     $GPGSV,1,1,04,...,0*69   ← signalId=0：未跟踪的低仰角星，cno 为空，一轮 1 条
    //   那条 signalId=0 的小报文也是 msgNum===1，于是每一轮它都把整星座的好数据
    //   （连同信噪比）**整体抹掉**，只剩下那 4 颗没信号的星。
    //
    //   三个症状全部由此而来：卫星数只有 2~4 颗（不是 12~14）、
    //   信噪比条一闪就没、"自报可见"读到的是一条小报文里的数字。
    //
    //   正确做法：**不在 GSV 里删卫星**。卫星"消失"交给 _prune() 按时间陈旧度处理
    //   （GSV 约 1Hz 循环，超过 STALE_MS 没再出现才删），这样多组信号之间不会互相踩。
    const gu = this._gsaUsed && this._gsaUsed[m.sys];
    // GSA 也会过期：某星座连续几秒不再输出 GSA 时，不能拿旧标记硬套
    const gsaFresh = (gu && (now - gu.at) < GSA_FRESH_MS) ? gu.set : null;

    this._gsvSeenSys[m.sys] = true;    // GSV 已枚举过这个星座（GSA 一致性统计的预热判断用）
    for (const s of m.sats) {
      // ⚠️ 逐颗用 s.sys，不要用整句的 m.sys —— $GPGSV 里 33~64 号是 **SBAS**（手册规定），
      //    nmea.js 已经逐颗判好了。按整句走会把 SBAS 记成 GPS。
      const sys = s.sys || m.sys;
      const key = sys + '-' + s.prn;
      const prev = this.sats[key];
      this.sats[key] = {
        sys,
        prn: s.prn,
        signalId: m.signalId,
        el: s.el == null ? (prev ? prev.el : null) : s.el,
        az: s.az == null ? (prev ? prev.az : null) : s.az,
        // ⚠️ 不能用空值覆盖已知信噪比：同一颗星可能先在有信号的组里出现（cno=42），
        //    又在 signalId=0 那组里被列为"未跟踪"（cno 空）。直接覆盖就造成闪动。
        snr: (s.snr != null && s.snr > 0) ? s.snr
          : (prev && prev.snr != null && prev.snr > 0 ? prev.snr : null),
        used: prev ? prev.used : !!(gsaFresh && gsaFresh[s.prn]),
        seen: now
      };
    }
  }

  _applyGSA(m, now) {
    this.gsaFix = m.fixType;
    this.dop = { pdop: m.pdop, hdop: m.hdop, vdop: m.vdop };
    // 该星座本轮参与解算的卫星
    const usedSet = {};
    m.prns.forEach(p => { usedSet[p] = true; });
    // 记为权威依据：GSV 稍后重建卫星时会据此回填（真机 GSA 在前、GSV 在后）
    this._gsaUsed[m.sys] = { set: usedSet, at: now };

    // GSA 与 GSV 的一致性统计。
    // ⚠️ 实测遇到过：GSA 列出 26 个编号，而 GSV 自报"总共只看得见 15 颗" ——
    //    用 26 颗去解算 15 颗可见卫星在物理上不可能，说明该模块的 GSA 不可信。
    //    这里统计"GSA 列了、但 GSV 根本没枚举到"的编号数，用来识别这种情况。
    //
    // ⚠️ 必须跳过预热：真机顺序是 GSA 在前、GSV 在后，所以第一轮的 GSA 到达时
    //    一颗卫星都还没有，会把整轮都算成"对不上"（实测踩过，33% 的假阳性）。
    //    只有在 GSV 已经枚举过该星座之后才开始统计。
    if (this._gsvSeenSys[m.sys]) {
      this.io.gsaPrns += m.prns.length;
      for (const p of m.prns) {
        if (!this.sats[m.sys + '-' + p]) this.io.gsaUnknown++;
      }
    }

    let matched = 0;
    for (const k of Object.keys(this.sats)) {
      const sat = this.sats[k];
      if (sat.sys === m.sys) {
        sat.used = !!usedSet[sat.prn];
        matched++;
      }
    }

    // 兜底：若系统名对不上（例如 GSA 报文头为 GN 且固件未给系统 ID 字段），
    // 退化为"按 PRN 在所有星座中标记"，否则会出现"一颗卫星都没参与解算"的假象
    if (matched === 0 && m.prns.length) {
      for (const k of Object.keys(this.sats)) {
        const sat = this.sats[k];
        if (usedSet[sat.prn]) sat.used = true;
      }
      this._gsaFallback = (this._gsaFallback || 0) + 1;
    }
  }

  _applyGGA(m) {
    this.pos.fixQuality = m.fixQuality;
    this.pos.utc = m.utc;
    this.pos.sats = m.sats;
    if (m.usable) {
      this.pos.lat = m.lat;
      this.pos.lng = m.lng;
      this.pos.alt = m.alt;
      this.pos.hdop = m.hdop;
    } else {
      this.pos.lat = null;
      this.pos.lng = null;
      this.pos.alt = null;
      this.pos.hdop = m.hdop;
    }
  }

  _applyRMC(m) {
    this.date = m.date;
    if (m.utc) this.pos.utc = m.utc;
    this.motion.speedKnots = m.speedKnots;
    this.motion.course = m.course;
  }

  _applyVTG(m) {
    this.motion.speedKnots = m.speedKnots || this.motion.speedKnots;
    this.motion.speedKmh = m.speedKmh;
    if (m.courseTrue) this.motion.course = m.courseTrue;
  }

  _prune(now) {
    for (const k of Object.keys(this.sats)) {
      if (now - this.sats[k].seen > STALE_MS) delete this.sats[k];
    }
  }

  /** 原始卫星列表（供点位质量评估等外部模块使用） */
  rawSats() {
    this._prune(Date.now());
    return Object.keys(this.sats).map(k => this.sats[k]);
  }

  /**
   * 参与定位解算的卫星数。
   *
   * ⚠️⚠️ 这里**不能**用 GGA 的 numSV！官方手册（M10 SPG 7.0x，GGA 字段表）原文：
   *   "numSV ... Number of satellites used. **If compatibility mode is enabled,
   *    the range is limited to 12 satellites** (see configuration item CFG-NMEA-COMPAT)."
   * 本机 CFG-NMEA-COMPAT 是开着的，所以 numSV 恒为 12 —— 五次真机日志里
   * 每一次都恰好是 12，一次没变过，正是这个上限造成的（厂家也确认了）。
   *
   * 正确的口径：**GSA 各星座"参与导航"列表的并集**。
   *   手册对 GSA 的说明："If more than 12 SVs are used for navigation, only the IDs
   *   of the first 12 are output." —— 即**每个星座**最多列 12 个，
   *   而多星座取并集就不受 12 这个总数上限约束了，这才是真实的使用数。
   *
   * 分层兜底：GSA 并集 → GGA numSV → 0
   */
  usedCount() {
    const active = this.activeCount();
    if (active > 0) return active;
    return this.pos.sats > 0 ? this.pos.sats : 0;
  }

  /** GSA 口径：接收机列为"参与导航"的卫星数（各星座并集，单星座最多 12 个） */
  activeCount() {
    return this.rawSats().filter(x => x.used).length;
  }

  /**
   * 导航频率（Hz）= GGA 条数 / 已运行秒数。
   *
   * 为什么用 GGA 而不是"句/秒"：**GGA 每个导航历元输出一条**，
   * 而 GSV 的条数随可见卫星数变化（真机一轮 14 条，空旷处更多），
   * 拿句/秒去反推频率会被带偏 —— 实测两次日志都是 1 Hz，
   * 但"23 句/秒"看上去完全不像 1 Hz，光看那个数会判断错。
   *
   * 为什么用平均值：接收机改完速率后前几秒可能还是旧节奏，20~30 秒后平均值就稳了。
   */
  _epochRate() {
    const n = this.io.gga;
    const t0 = this.io.firstAt;
    if (!t0 || n < 2) return 0;
    const secs = (Date.now() - t0) / 1000;
    if (secs <= 0) return 0;
    return Math.round((n / secs) * 100) / 100;
  }

  /**
   * 是否检测到 GGA 的 numSV 被兼容模式压到 12。
   * 判据：GGA 自报恰好 12，而 GSA 并集明显更多。
   * 记录它有两个用途：① 界面上如实说明；② 用现场数据反过来验证这个上限。
   */
  ggaNumSvCapped() {
    return this.pos.sats === 12 && this.activeCount() > 12;
  }

  /**
   * 信噪比统计（dB-Hz）。**avg / max 是未取整的数值**；一颗有效信噪比都没有时返回 null。
   *
   * 为什么单独抽一个方法：这个口径（`snr != null && snr > 0`）以前散在 4 个地方，
   * 而"可以直接用的数值"只有 snapshot() 里那个格式化好的字符串（'—' 或 '38.7'）。
   * 门面里想要数值就只能自己再算一遍 —— 一旦规则分叉，就会出现
   * "界面显示 38.7、接口返回 undefined"这种对不上的情况（实际发生过）。
   */
  snrStats() {
    const vals = this.rawSats().map(x => x.snr).filter(v => v != null && v > 0);
    if (!vals.length) return { count: 0, avg: null, max: null };
    const sum = vals.reduce((a, b) => a + b, 0);
    return {
      count: vals.length,
      avg: Math.round(sum / vals.length * 10) / 10,
      max: Math.max.apply(null, vals)
    };
  }

  /**
   * 诊断用统计：可见卫星总数 / 其中有信噪比的颗数。
   * 用来区分"没收到 GSV"和"GSV 里信噪比为空"这两种完全不同的故障。
   */
  satStats() {
    const s = this.rawSats();
    const bySys = {};
    for (const x of s) bySys[x.sys] = (bySys[x.sys] || 0) + 1;
    return {
      total: s.length,
      withSnr: s.filter(x => x.snr != null && x.snr > 0).length,
      bySys,
      gsvTalker: this.io.gsvTalker,
      gsaTalker: this.io.gsaTalker,
      gsvInView: this.io.gsvInView,
      gsvShape: this.io.gsvShape,
      gsvInViewTotal: Object.keys(this.io.gsvInView)
        .reduce((a, k) => a + (this.io.gsvInView[k] || 0), 0),
      pubx: this.io.pubx,
      pubxSample: this.io.pubxSample,
      pubx00: this.io.pubx00,
      pubx00Sample: this.io.pubx00Sample,
      badCk: this.io.badCk,
      gsvSnrOk: this.io.gsvSnrOk,
      gsvSnrEmpty: this.io.gsvSnrEmpty,
      pubxSnr: this.lastPubx
        ? { numSv: this.lastPubx.numSv, withCno: this.lastPubx.withCno,
            avgCno: this.lastPubx.avgCno } : null,
      gsaPrns: this.io.gsaPrns,
      gsaUnknown: this.io.gsaUnknown,
      gsvPrevSys: Object.keys(this._gsvSeenSys || {}),
      gsvSigIds: this.io.gsvSigIds
    };
  }

  /** 生成用于渲染的快照（所有展示用文本都在这里算好，WXML 里不做运算） */
  snapshot() {
    const now = Date.now();
    this._prune(now);

    const list = Object.keys(this.sats).map(k => this.sats[k]);
    const ORDER = ['GPS', 'BD', 'GLO', 'GAL', 'QZS', 'SBS', 'MIX'];
    list.sort((a, b) => (ORDER.indexOf(a.sys) - ORDER.indexOf(b.sys)) || (a.prn - b.prn));

    // 天空视图坐标：方位角 0=正北(上)，仰角 90=天顶(圆心)
    const sky = list.map(s => {
      const el = s.el == null ? 0 : Math.max(0, Math.min(90, s.el));
      const az = s.az == null ? 0 : s.az;
      const r = (90 - el) / 90;                       // 0=圆心 1=外圈
      const rad = az * Math.PI / 180;
      const x = 50 + r * 46 * Math.sin(rad);
      const y = 50 - r * 46 * Math.cos(rad);
      const snr = s.snr == null ? 0 : s.snr;
      return {
        key: s.sys + '-' + s.prn,
        label: String(s.prn),
        sys: s.sys,
        color: SYS_COLOR[s.sys] || SYS_COLOR.MIX,
        x: x.toFixed(2),
        y: y.toFixed(2),
        used: s.used,
        snr,
        // 有信号=实心且带光晕；无信号=空心
        dotCls: s.used ? 'dot used' : (snr > 0 ? 'dot idle' : 'dot none'),
        size: (s.used ? 26 : 22) + Math.round(snr / 8)
      };
    });

    // 各星座统计
    const bySys = [];
    for (const sys of ORDER) {
      const group = list.filter(s => s.sys === sys);
      if (!group.length) continue;
      const snrs = group.map(s => s.snr).filter(v => v != null && v > 0);
      const avg = snrs.length ? snrs.reduce((a, b) => a + b, 0) / snrs.length : 0;
      bySys.push({
        sys,
        label: SYS_LABEL[sys] || sys,
        color: SYS_COLOR[sys] || SYS_COLOR.MIX,
        inView: group.length,
        used: group.filter(s => s.used).length,
        avgSnr: avg ? avg.toFixed(1) : '—',
        maxSnr: snrs.length ? Math.max.apply(null, snrs) : 0,
        avgPct: Math.min(100, Math.round(avg / 50 * 100))
      });
    }

    // ★ 信噪比口径统一在 snrStats() 里，界面和门面用同一份，不会再各算各的
    const snrAll = this.snrStats();
    const activeCount = list.filter(s => s.used).length;   // GSA 口径：在用

    // 卫星明细（带信噪比条宽度）
    const satRows = list.map(s => ({
      key: s.sys + '-' + s.prn,
      sys: s.sys,
      sysLabel: SYS_LABEL[s.sys] || s.sys,
      color: SYS_COLOR[s.sys] || SYS_COLOR.MIX,
      prn: String(s.prn).padStart(2, '0'),
      el: s.el == null ? '—' : String(s.el).padStart(2, '0'),
      az: s.az == null ? '—' : String(s.az).padStart(3, '0'),
      snr: s.snr == null ? '—' : String(s.snr),
      snrPct: s.snr == null ? 0 : Math.min(100, Math.round(s.snr / 50 * 100)),
      used: s.used
    }));

    const gstFresh = !!(this.gst && (Date.now() - (this.gstAt || 0)) < 10000);
    const fq = this.pos.fixQuality;
    // ★ $GNGST 什么时候可信？分两级，宁可少藏也不要误藏：
    //   ① 数值本身是有效精度（accValid 拦掉 3750023 这类无解哨兵）；
    //   ② **确知无定位**时才整体隐藏 —— 判据是"收到过 GGA 或已经有位置"，
    //      此时若 fixQuality 还是 0，就说明接收机确实没解。
    //      注意不能简单要求 fixQuality>0：没收到过 GGA 时它默认就是 0，
    //      那样会把"只有 GST、还没收到 GGA"的合法情况一起藏掉，
    //      而 $GNGST 恰恰是我们手上唯一一个独立于自评分的精度数字。
    const fixKnown = this.io.gga > 0 || this.pos.lat != null;
    const gstUsable = gstFresh && !(fixKnown && !(fq > 0)) && accValid(this.gst.hAcc, true);
    const hdop = this.pos.hdop != null ? this.pos.hdop : this.dop.hdop;
    // 只有真正定位成功后才有"估算精度"可言
    const accEst = (this.pos.lat != null && hdop != null && UERE[fq] != null)
      ? (hdop * UERE[fq]) : null;

    // GSA 可信度：GSA 列出的编号里，有多大比例在 GSV 的可见列表里根本不存在。
    // 比例高 = 这台模块的 GSA 不能用，界面要如实说明，不能装作正常。
    const gsaUnknownPct = this.io.gsaPrns
      ? Math.round(this.io.gsaUnknown / this.io.gsaPrns * 100) : 0;
    const gsvClaimTotal = Object.keys(this.io.gsvInView)
      .reduce((a, k) => a + (this.io.gsvInView[k] || 0), 0);
    const gsaSuspect = this.io.gsaPrns > 30 && gsaUnknownPct >= 30;

    return {
      fix: {
        quality: fq,
        qualityText: fixQualityText(fq),
        gsaFix: this.gsaFix,
        gsaText: FIX_TYPE_TEXT[this.gsaFix] || '—',
        ok: fq > 0 && this.pos.lat != null,
        level: fq === 0 ? 'bad' : (fq === 1 ? 'warn' : 'good')
      },
      pos: {
        lat: this.pos.lat == null ? null : this.pos.lat.toFixed(7),
        lng: this.pos.lng == null ? null : this.pos.lng.toFixed(7),
        alt: this.pos.alt == null ? null : this.pos.alt.toFixed(1),
        utc: this.pos.utc ? this.pos.utc.slice(0, 6) : '--:--:--',
        date: this.date || '--------'
      },
      dop: {
        pdop: this.dop.pdop == null ? '—' : this.dop.pdop.toFixed(2),
        hdop: this.dop.hdop == null ? '—' : this.dop.hdop.toFixed(2),
        vdop: this.dop.vdop == null ? '—' : this.dop.vdop.toFixed(2),
        hdopNum: hdop == null ? null : hdop
      },
      motion: {
        speedKmh: this.motion.speedKmh ? this.motion.speedKmh.toFixed(2) : (this.motion.speedKnots * 1.852).toFixed(2),
        speedKnots: (this.motion.speedKnots || 0).toFixed(2),
        course: (this.motion.course || 0).toFixed(1)
      },
      accEst: accEst == null ? '—' : accEst.toFixed(2),
      // ★ 接收机自己的精度估计。与上面的 accEst 不同：
      //   accEst 是我们按 HDOP × UERE 推的，gst 是接收机解算残差算的。
      //   两个都在界面上，才能看出我们的推断有没有跑偏。
      //
      // ⚠️ 无定位时必须整体置 null（界面会整块隐藏）：
      //   $GNGST 在没有解的时候回的是一串**无效哨兵值** —— 实测 stdLat/stdLon/stdAlt
      //   全是 3750023，合成出来在界面上显示成「接收机自估 水平 ±5303333.39 m」。
      //   业务员看到"五百万米"只会以为设备坏了。判据与 UBX-NAV-PVT 共用 accValid。
      gst: gstUsable ? {
        hAcc: this.gst.hAcc.toFixed(2),
        stdLat: accValid(this.gst.stdLat, true) ? this.gst.stdLat.toFixed(2) : '—',
        stdLon: accValid(this.gst.stdLon, true) ? this.gst.stdLon.toFixed(2) : '—',
        stdAlt: accValid(this.gst.stdAlt, true) ? this.gst.stdAlt.toFixed(2) : '—',
        // ⚠️ 伪距 rms 也要过同一把尺子。实测（2026-09-18 20:15 院子那一轮）：
        //    其余字段都正常（±0.85 m），**只有 rangeRms 是 143084** —— 同一个会话里
        //    18:xx 那轮是 27。也就是说这个字段也会冒垃圾值，不能无条件显示。
        rangeRms: accValid(this.gst.rangeRms, true) ? this.gst.rangeRms : '—'
      } : null,
      gsaReliable: !gsaSuspect,
      gsaUnknownPct,
      gsvClaimTotal,
      gsaUnion: list.filter(s => s.used).length,
      totals: {
        inView: list.length,
        used: this.usedCount(),        // 参与定位（GSA 并集，**不受 12 上限约束**）
        active: activeCount,           // 同口径，保留字段兼容
        ggaNumSv: this.pos.sats,       // GGA 自报数（兼容模式下最多 12）
        ggaCapped: this.ggaNumSvCapped(),
        avgSnr: snrAll.avg == null ? '—' : snrAll.avg.toFixed(1),
        maxSnr: snrAll.max == null ? 0 : snrAll.max
      },
      sky, bySys, satRows,
      io: {
        sentences: this.io.sentences,
        rate: this.io.rate,
        bytes: this.io.bytes,
        // ★ 第一条语句的时刻。NMEA 侧的 KB/s 必须用它当分母（而不是"连接时刻"），
        //   否则"先连上、过一会儿才有数据"会把分母算大、流量系统性偏低。
        //   监测台要算"整条链路总流量"就靠这个（UBX 侧用连接时刻）——两者通常只差不到 1 秒。
        firstAt: this.io.firstAt,
        gsv: this.io.gsv,
        gsa: this.io.gsa,
        gga: this.io.gga,
        gsvSnrOk: this.io.gsvSnrOk,
        gsvSnrEmpty: this.io.gsvSnrEmpty,
        badCk: this.io.badCk,
        pubx: this.io.pubx,
        pubx00: this.io.pubx00,
        // ★ 导航频率：GGA 条数 / 已运行秒数。接收机到底跑几 Hz，一眼可判 ——
        //   "句/秒"会被 GSV 条数（随可见卫星数变化）带偏，这个不会。
        epochs: this.io.gga,
        epochRate: this._epochRate(),
        gst: this.io.gst,
        // ★ 下面这些以前只在"诊断日志"里打印，监测页看不到、也复制不出来。
        //   而它们恰恰是排查"卫星数对不上 / 信噪比一闪就没"的关键证据
        //   （signalId 分组就是靠它才定位到根因的），所以一并暴露出来。
        gsvTalker: this.io.gsvTalker,     // 各 GSV 报文头的条数
        gsaTalker: this.io.gsaTalker,     // 各 GSA 报文头的条数
        gsvSigIds: this.io.gsvSigIds,     // signalId 分组（u-blox 按 signalId 重复输出多套 GSV）
        gsvNoSigId: this.io.gsvNoSigId,   // 没带 signalId 字段的 GSV 条数
        gsvInView: this.io.gsvInView,     // 各报文头 GSV 自报的"可见卫星数"
        gsaPrns: this.io.gsaPrns,         // GSA 列出的编号总数
        gsaUnknown: this.io.gsaUnknown,   // 其中 GSV 里根本没有的（跨源对不上的证据）
        pubxSample: this.io.pubxSample,   // 第一条 $PUBX 原文
        pubx00Sample: this.io.pubx00Sample
      },
      raw: this.raw.slice(-14)
    };
  }
}

module.exports = { GnssState, SYS_LABEL, SYS_COLOR };
