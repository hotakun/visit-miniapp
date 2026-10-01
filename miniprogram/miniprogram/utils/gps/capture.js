// utils/gps/capture.js
// 聚火门店定位采集系统 · 无 UI 门面（Facade）
// 供已有小程序页面直接调用，不依赖本模块自带的示例页面。
//
// 用法：
//   const { GpsCapture } = require('../../utils/gps/capture');
//   this.cap = new GpsCapture({
//     deviceNameKey: 'xinghewei',
//     onStatus:   (s) => this.setData({ gpsStatus: s.text }),
//     onProgress: (p) => this.setData({ gpsInfo: p.summary }),
//     onError:    (e) => wx.showToast({ title: e.message, icon: 'none' })
//   });
//   await this.cap.start();          // 开始扫描并自动连接
//   const r = this.cap.getResult();  // 收敛后取结果
//   this.cap.stop();                 // 停止并断开

const { BleManager } = require('./ble');
const { parseGGA, fixQualityText } = require('./nmea');
const { StaticFix, distanceMeters } = require('./staticFix');
const { wgs84ToGcj02 } = require('./coord');
const { GnssState } = require('./gnssState');
const UBX = require('./ubx');

const DEFAULTS = {
  deviceNameKey: 'xinghewei',   // 目标蓝牙名（模糊匹配，不区分大小写）
  preferServicePrefix: 'FFE0',  // 优先选择的 GATT 服务前缀（BT04 数据通道在 FFE0）
  scanTimeoutMs: 20000,         // 扫描超时
  connectTimeoutMs: 10000,      // 连接超时
  minSats: 6,                   // 质量门：卫星数下限
  maxHdop: 1.5,                 // 质量门：HDOP 上限
  maxSpread: 8.0,               // 抗差阈值（米）
  minSamples: 60,               // 收敛所需有效样本
  minSeconds: 60,               // ★ 收敛所需最短驻留时长（秒）。见 staticFix.js：
                                //   只看样本数的话，频率一提（1→2 Hz）驻留就自动砍半
  maxRms: 1.0,                  // 收敛所需散布上限（米）
  // ★ 收敛所需「均值的标准误」上限（米）。锚定在**实测跨时段重复性（约 0.5 m）**上：
  //   含义 = "本点均值的不确定度不超过我们最终能达到的精度"。
  //   ⚠️ 别调回 0.15：N_eff≈1 时 SE≈rms，那等于把 rms 门槛偷偷收紧 6 倍（现场实测过，太严）。
  maxSe: 0.5,
  maxHalfDrift: 1.0,            // = 2×maxSe，由 staticFix 导出（SE = 半差/2，同一个门槛）
  movingRms: 2.0,               // 判定"发生移动"的散布阈值（米）
  autoReconnect: true,          // 断线自动重连
  maxReconnect: 3               // 最大重连次数
};

class GpsCapture {
  /**
   * @param {object} opts 见 DEFAULTS，可覆盖
   * @param {function} opts.onStatus   状态变化 {phase, text}
   * @param {function} opts.onProgress 进度/结果 {lat,lng,gcjLat,gcjLng,hdop,sats,fixQuality,fixText,samples,used,rejected,rms,stable,moving,summary}
   * @param {function} opts.onError    错误 {code, message}
   * @param {function} opts.onLog      调试日志 string
   */
  constructor(opts = {}) {
    this.opts = Object.assign({}, DEFAULTS, opts);
    this.ble = new BleManager({ preferServicePrefix: this.opts.preferServicePrefix });
    this.fixer = new StaticFix(this.opts);
    // ★ 必须同时维护一份 GnssState：
    //   ① GGA 的 numSV 在本机被截到 12（兼容模式），**真实参与定位数只能从 GSA 并集拿**；
    //   ② 信噪比、星空、遮挡剖面也都在这份状态里。
    //    只用 parseGGA 的话，界面上会永远显示"12 颗卫星"。
    this.gstate = new GnssState();
    // ★ UBX/NMEA 字节流分离器（见 _onValue 的说明）
    this.splitter = new UBX.FrameSplitter();
    this.ubxFrames = 0;
    this.ubxInvalid = 0;

    this.phase = 'idle';        // idle | scanning | connecting | connected | error
    this.last = null;           // 最近一次 onProgress 的完整数据
    this.lastError = null;
    this._buf = '';
    this._active = false;
    this._scanTimer = null;
    this._reconnectCount = 0;
    this._lastDeviceId = wx.getStorageSync('gps_last_device_id') || '';

    this.ble.onStateChange = (connected) => this._onConnState(connected);
  }

  // ---------------------------------------------------------------- 对外方法

  /** 开始采点：打开适配器 → 扫描 → 自动连接 → 订阅 → 持续产出结果 */
  async start() {
    if (this._active) return;
    this._active = true;
    this._reconnectCount = 0;
    this.fixer.reset();
    this.gstate.reset();
    this.splitter.reset();
    this._buf = '';
    this.last = null;
    this.lastError = null;

    try {
      await this._ensurePrivacy();
      await this.ble.open();
      this._setPhase('scanning', '正在搜索 ' + this.opts.deviceNameKey + ' …');
      await this.ble.startScan((dev) => this._onFound(dev));
      this._scanTimer = setTimeout(() => {
        if (this.phase === 'scanning' && this._active) {
          this.ble.stopScan();
          this._fail('SCAN_TIMEOUT',
            '未找到设备：请确认 GPS 已上电，且未在系统蓝牙里配对 ' + this.opts.deviceNameKey);
        }
      }, this.opts.scanTimeoutMs);
    } catch (e) {
      this._failFromBle(e, 'OPEN_FAIL');
    }
  }

  /** 停止采点并断开连接 */
  async stop() {
    this._active = false;
    this._clearTimer();
    try { await this.ble.stopScan(); } catch (e) {}
    try { await this.ble.disconnect(); } catch (e) {}
    this._setPhase('idle', '已停止');
  }

  /** 释放资源（页面 onUnload 调用） */
  destroy() {
    this._active = false;
    this._clearTimer();
    this.ble.cleanup();
  }

  /** 取当前结果；未收敛时 stable=false，但仍返回当前最优估计 */
  getResult() {
    if (!this.last) return null;
    const e = this.last;
    return {
      wgs84: { lat: e.lat, lng: e.lng },          // 存储用（唯一标准）
      gcj02: { lat: e.gcjLat, lng: e.gcjLng },    // 地图显示/导出用
      hdop: e.hdop,
      sats: e.sats,                 // ★ 真实参与定位数（GSA 并集，**不是** GGA 的 numSV）
      satsGga: e.satsGga,           // GGA 自报数，本机恒为 12 —— 只作留档/自证，别拿去显示
      visible: e.visible,           // GSV 聚合到的可见颗数
      avgSnr: e.avgSnr,             // 平均信噪比 dB-Hz（null = 这一刻没有信噪比）
      fixQuality: e.fixQuality,
      fixText: e.fixText,
      // ⚠️ 这三个数不要混用：
      //   samples/used —— 剔除跳点之后的**有效样本**，收敛判定用的就是它（= onProgress.used）
      //   received     —— 通过质量门的样本总数，含后来被判为跳点的
      //   rejected     —— 被判为跳点的数量
      samples: e.used,
      used: e.used,
      received: e.samples,
      rejected: e.rejected,
      rms: e.rms,
      // ★ 新增的三个量（见 staticFix.js 的四条改进）：
      se: e.se,                 // 均值的标准误（米）—— "再采下去平均值还能变多少"
      nEff: e.nEff,             // 有效独立样本数（由分半一致性反推）
      halfDiff: e.halfDiff,     // 前后两半均值之差（米）
      drifting: e.drifting,     // 是否还在漂（建议再站一会儿）
      stable: e.stable,
      time: Date.now()
    };
  }

  /**
   * 采集过程中的健康度诊断（排错用，不要拿去给用户看）。
   * 现场排查时先把这一份复制出来，能省掉好几轮来回。
   */
  getDiagnostics() {
    const io = this.gstate.io;
    const snr = this.gstate.snrStats();
    return {
      phase: this.phase,
      ubxFrames: this.ubxFrames,      // 收到的 UBX 帧数（为 0 说明分离器或链路有问题）
      ubxInvalid: this.ubxInvalid,    // 被丢弃的坏帧
      sentences: io.sentences,        // NMEA 语句总数
      gga: io.gga, gsa: io.gsa, gsv: io.gsv,
      badChecksum: io.badCk,          // ★ 校验和失败数（>0 说明数据在传输中损坏）
      gsvWithSnr: io.gsvSnrOk,        // 带 cno 的 GSV 条数
      gsvEmptySnr: io.gsvSnrEmpty,    // cno 全空的 GSV 条数
      snrSats: snr.count,             // 有有效信噪比的颗数（=0 且 gsvWithSnr>0 才叫异常）
      avgSnr: snr.avg,
      maxSnr: snr.max,
      usedSats: this.gstate.usedCount(),
      visibleSats: this.gstate.rawSats().length,
      ggaNumSv: this.gstate.pos.sats,
      ggaCapped: this.gstate.ggaNumSvCapped(),
      fixQuality: this.gstate.pos.fixQuality
    };
  }

  isStable() { return !!(this.last && this.last.stable); }
  getPhase() { return this.phase; }

  /** 把当前结果与某个基准点比较，返回偏差（米） */
  deviationFrom(ref) {
    if (!this.last || !ref) return null;
    return distanceMeters(this.last, ref);
  }

  // ---------------------------------------------------------------- 内部实现

  _clearTimer() {
    if (this._scanTimer) { clearTimeout(this._scanTimer); this._scanTimer = null; }
  }

  _log(msg) { if (this.opts.onLog) this.opts.onLog(msg); }

  _setPhase(phase, text) {
    this.phase = phase;
    if (this.opts.onStatus) this.opts.onStatus({ phase, text });
  }

  _fail(code, message) {
    this.lastError = { code, message };
    this._setPhase('error', message);
    if (this.opts.onError) this.opts.onError({ code, message });
  }

  _failFromBle(e, code) {
    const raw = (e && (e.errMsg || e.message)) || String(e);
    let msg = '启动失败：' + raw;
    if (raw.indexOf('10001') >= 0) msg = '请打开手机蓝牙开关后重试';
    if (raw.indexOf('10004') >= 0) msg = '设备无服务，请检查设备是否上电';
    this._fail(code, msg);
  }

  // 真实 AppID 下微信会校验"用户隐私保护指引"，未授权时蓝牙接口会被拦
  _ensurePrivacy() {
    return new Promise((resolve) => {
      if (!wx.getPrivacySetting) { resolve(); return; }
      wx.getPrivacySetting({
        success: (res) => {
          if (res.needAuthorization) {
            wx.requirePrivacyAuthorize({
              success: () => resolve(),
              fail: () => { this._log('隐私授权被拒绝，蓝牙接口可能失败'); resolve(); }
            });
          } else { resolve(); }
        },
        fail: () => resolve()
      });
    });
  }

  async _onFound(dev) {
    if (!dev || !dev.name) return;
    const nm = dev.name;
    if (nm.toLowerCase().indexOf(this.opts.deviceNameKey.toLowerCase()) < 0) {
      this._log('发现其它BLE设备：' + nm + ' RSSI=' + dev.RSSI);
      return;
    }
    if (this.phase !== 'scanning' || !this._active) return;

    this._clearTimer();
    this._log('命中目标设备：' + nm + ' RSSI=' + dev.RSSI);
    this._setPhase('connecting', '发现 ' + nm + '，正在连接…');
    try { await this.ble.stopScan(); } catch (e) {}

    try {
      await this.ble.connect(dev.deviceId);
      const d = this.ble.discovered || { services: [], chars: [] };
      this._log('连接成功：服务' + d.services.length + '个 / 特征' + d.chars.length + '个');
      this._log('候选通知特征: ' + JSON.stringify(d.candidates || []));
      if (!this.ble.notifyChar) {
        throw new Error('该设备没有 Notify 特征，无法接收数据');
      }
      this._log('选定通知特征: ' + this.ble.notifyChar.characteristicId +
        ' (score=' + this.ble.notifyChar.score + ')');
      await this.ble.subscribe((ab) => this._onValue(ab));
      wx.setStorageSync('gps_last_device_id', dev.deviceId);
      this._lastDeviceId = dev.deviceId;
      this._reconnectCount = 0;
      this._setPhase('connected', '已连接 ' + nm);
    } catch (e) {
      this._failFromBle(e, 'CONNECT_FAIL');
    }
  }

  _onConnState(connected) {
    if (connected) return;
    if (!this._active) return;
    if (!this.opts.autoReconnect || this._reconnectCount >= this.opts.maxReconnect) {
      this._fail('DISCONNECTED', '连接已断开，请重新开始');
      return;
    }
    this._reconnectCount++;
    const id = this._lastDeviceId;
    this._log('连接断开，第 ' + this._reconnectCount + ' 次尝试重连…');
    if (!id) { this._fail('DISCONNECTED', '连接已断开，请重新开始'); return; }
    setTimeout(async () => {
      if (!this._active) return;
      try {
        await this.ble.connect(id);
        await this.ble.subscribe((ab) => this._onValue(ab));
        this._setPhase('connected', '已重连');
      } catch (e) {
        this._log('重连失败：' + ((e && (e.errMsg || e.message)) || e));
        this._onConnState(false);
      }
    }, 800);
  }

  // NMEA 是流式的，BLE 通知会切包，必须跨包拼接后按行切分。
  //
  // ⚠️⚠️ 但**不能直接把这些字节当文本**：这台模块每秒往同一条链路上灌约 9 KB 的
  //    UBX 二进制（其中约 74% 是 u-blox 公开协议里没有的厂商私有调试帧，
  //    单帧最大 2.6 KB）。把二进制当文本切有两个后果：
  //      ① 白烧 CPU（每秒扫 9 KB 的垃圾）；
  //      ② **UBX 载荷里的 0x0A 会被当成换行**，大帧跨包时若正好卡在一条 NMEA
  //         中间，那条 NMEA 会被当成"超长行"被 2048 的缓冲上限清掉 —— 丢掉一帧坐标。
  //    所以必须先用 FrameSplitter 按前导码 B5 62 把 UBX 摘出去，其余才按文本处理。
  _onValue(ab) {
    const r = this.splitter.push(new Uint8Array(ab));
    this.ubxInvalid += (r.invalid || 0);
    this.ubxFrames += (r.frames ? r.frames.length : 0);
    if (r.text) this._onText(r.text);
  }

  /** 纯文本部分：按行切分（跨包拼接） */
  _onText(s) {
    this._buf += s;
    const parts = this._buf.split(/\r?\n/);
    this._buf = parts.pop();
    if (this._buf.length > 2048) this._buf = '';
    for (const line of parts) this._onLine(line.trim());
  }

  _onLine(line) {
    if (!line) return;
    // ★ 先喂聚合器：GSA 决定"参与定位"的真实颗数，GSV 决定可见数/信噪比/遮挡剖面。
    //   顺序无所谓（feed 内部按语句类型分发），但**必须在取数之前**。
    this.gstate.feed(line);

    const g = parseGGA(line);
    if (!g || !g.usable) return;

    // ★ 给这一历元附上接收机自报的精度 σ（米），供 staticFix 做 1/σ² 加权。
    //   来源是 $GNGST 的 √(stdLat²+stdLon²)（也可用 NAV-PVT 的 hAcc，等价）。
    //   ⚠️ 必须判新鲜度：GST 是**另一条**语句，如果它停更了，拿陈旧的 σ 加权反而有害。
    const gst = this.gstate.gst;
    if (gst && (Date.now() - (this.gstate.gstAt || 0)) < 3000) {
      g.acc = gst.hAcc;                       // 无效哨兵值时 staticFix 会自己忽略
    }

    const gcj = wgs84ToGcj02(g.lat, g.lng);
    const est = this.fixer.push(g);
    // ★ 卫星数用 GSA 并集（真实值），**不是 GGA 的 numSV** ——
    //   本机 numSV 恒为 12（被 CFG-NMEA-COMPAT 截断），拿它当指标会永远不动。
    //   拿不到 GSA 时 usedCount() 会自动退回 numSV，不会更差。
    const realSats = this.gstate.usedCount() || g.sats;
    const base = {
      lat: g.lat, lng: g.lng,
      gcjLat: gcj.lat, gcjLng: gcj.lng,
      hdop: g.hdop,
      sats: realSats,          // ★ 真实参与定位颗数
      satsGga: g.sats,         // 留档：GGA 自报数（本机恒为 12）
      visible: this.gstate.rawSats().length,   // GSV 聚合到的可见颗数
      avgSnr: this.gstate.snrStats().avg,      // 平均信噪比（dB-Hz），无数据时为 null
      fixQuality: g.fixQuality, fixText: fixQualityText(g.fixQuality)
    };

    const est2 = est || this.last;   // 样本不足时沿用上次估计，避免回调为空
    const out = Object.assign({}, base, est ? {
      samples: est.samples,
      used: est.used,
      rejected: est.rejected,
      rms: est.rms,
      stable: est.stable,
      moving: est.samples >= 20 && est.rms > this.opts.movingRms
    } : {
      samples: est2 ? est2.samples : 0,
      used: est2 ? est2.used : 0,
      rejected: est2 ? est2.rejected : 0,
      rms: est2 ? est2.rms : null,
      stable: false,
      moving: false
    });

    // 收敛后以加权平均值为准；未收敛时展示实时值
    if (est) {
      const gcjEst = wgs84ToGcj02(est.lat, est.lng);
      out.lat = est.lat;
      out.lng = est.lng;
      out.gcjLat = gcjEst.lat;
      out.gcjLng = gcjEst.lng;
    }

    out.summary = 'HDOP ' + out.hdop.toFixed(1) + ' | 星 ' + out.sats +
      (out.satsGga ? '(GGA ' + out.satsGga + ')' : '') +
      ' | 样本 ' + out.used + ' | 散布 ' + (out.rms == null ? '—' : out.rms.toFixed(2) + 'm') +
      (out.stable ? ' | 已收敛' : '');

    this.last = out;
    if (this.opts.onProgress) this.opts.onProgress(out);
  }
}

module.exports = { GpsCapture, DEFAULTS };
