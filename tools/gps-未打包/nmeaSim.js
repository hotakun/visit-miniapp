// ⚠️ 【未启用 / 储备模块】本文件当前**没有任何调用方**（2026-10-05 全项目 grep 核实，零引用）。
//    它不是"写了没用的废码"，而是**为将来准备**的专业模块 —— **别当死代码删**。
//    要启用：接到 capture.js 或拜访页上；背景见 AGENTS.md「utils/gps 储备模块」条。
//    再次确认零引用的方法：grep -rl "siteQuality" --include=*.js miniprogram/ | grep -v utils/gps/
// utils/gps/nmeaSim.js —— NMEA 0183 语句模拟器（演示用）
//
// 重要：它不是"直接造界面数据"，而是生成**合法的 NMEA 语句**（带正确校验和），
// 再喂给与真实设备完全相同的解析管线。因此切换到真机时，代码路径完全一致。
//
// 模拟内容包含真实的冷启动过程：
//   0~3s   冷启动：捕获卫星，无定位
//   3~8s   2D 定位，可用卫星少、DOP 差
//   8s 后  3D 定位，星座齐全、DOP 良好
const { buildSentence, degToNmea } = require('./nmea');

// 演示基准点（可自行修改为你所在城市；仅影响演示数值）
const BASE = { lat: 34.341600, lng: 108.939800 };

// 各星座卫星数与 PRN 池（PRN 取值参照真实系统的编号范围）
// sysId = NMEA 4.1 GSA 末尾的系统 ID 字段（1=GPS 2=GLO 3=GAL 4=BD 5=QZS）
const CONSTELLATIONS = [
  { talker: 'GP', sysId: 1, sats: 9, prns: [1, 3, 6, 9, 12, 15, 18, 22, 26, 29, 31] },
  { talker: 'GB', sysId: 4, sats: 13, prns: [3, 4, 6, 7, 9, 10, 13, 16, 20, 21, 25, 28, 33, 37, 40] },
  { talker: 'GL', sysId: 2, sats: 8, prns: [1, 2, 5, 7, 9, 12, 15, 18, 21, 24] },
  { talker: 'GA', sysId: 3, sats: 7, prns: [1, 3, 5, 8, 11, 15, 19, 22, 26, 30] },
  { talker: 'GQ', sysId: 5, sats: 5, prns: [193, 194, 195, 196, 197] }
];

const PHASE = {
  ACQUIRE: 3.0,     // 冷启动时长（秒）
  CONVERGE: 8.0     // 到 3D 定位的时长（秒）
};

function rand(min, max) { return min + Math.random() * (max - min); }

class NmeaSim {
  /**
   * @param {object} opts
   *   opts.rate     更新率 Hz（默认 1）
   *   opts.base     基准点 {lat,lng}
   *   opts.onSentence 回调 (line) => void
   */
  constructor(opts = {}) {
    this.base = opts.base || BASE;
    this.rate = opts.rate || 1;
    this.onSentence = opts.onSentence || null;
    this._timer = null;
    this._t0 = 0;
    this.sats = [];
    this._buildSats();
  }

  _buildSats() {
    this.sats = [];
    for (const c of CONSTELLATIONS) {
      const prns = c.prns.slice(0, c.sats);
      for (const prn of prns) {
        const el = rand(6, 88);
        this.sats.push({
          talker: c.talker,
          prn,
          el,
          az: rand(0, 360),
          // 高仰角通常信噪比更好
          snrBase: 24 + el * 0.26 + rand(-4, 5),
          elRate: rand(-0.06, 0.06),
          azRate: rand(-0.35, 0.35)
        });
      }
    }
  }

  start() {
    this.stop();
    this._t0 = Date.now();
    this._tick();
    this._timer = setInterval(() => this._tick(), Math.round(1000 / this.rate));
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  setRate(hz) {
    this.rate = hz;
    if (this._timer) this.start();
  }

  reset() { this._buildSats(); this._t0 = Date.now(); }

  _emit(line) { if (this.onSentence) this.onSentence(line); }

  /** 冷启动阶段进度 0~1 */
  _acquireProgress(elapsed) {
    if (elapsed <= 0) return 0;
    if (elapsed >= PHASE.ACQUIRE) return 1;
    return elapsed / PHASE.ACQUIRE;
  }

  _fixStage(elapsed) {
    if (elapsed < PHASE.ACQUIRE) return 0;           // 无定位
    if (elapsed < PHASE.CONVERGE) return 2;          // 2D
    return 3;                                        // 3D
  }

  _utc() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return {
      time: p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + '.' + p(d.getUTCMilliseconds(), 3).slice(0, 2),
      date: p(d.getUTCDate()) + p(d.getUTCMonth() + 1) + String(d.getUTCFullYear()).slice(2)
    };
  }

  _tick() {
    const elapsed = (Date.now() - this._t0) / 1000;
    const acq = this._acquireProgress(elapsed);
    const stage = this._fixStage(elapsed);

    // 卫星缓慢漂移
    for (const s of this.sats) {
      s.el = Math.max(4, Math.min(90, s.el + s.elRate));
      s.az = (s.az + s.azRate + 360) % 360;
    }

    // 冷启动过程中，先只"看见"一部分卫星
    const visible = this.sats.filter((s, i) => acq >= 1 || (i % 3) === 0 || Math.random() < acq);

    // GSA 口径："在用/活动"卫星 = 高于仰角遮蔽角的可见卫星（每个星座最多只列 12 个）
    const active = visible.filter(s => s.el > 10 && (acq >= 1 ? s.snrBase > 28 : false));
    // GGA 口径：真正进入定位解算的卫星。实测中它明显少于"在用"并集
    //（同一时刻 23 颗在用 / 12 颗参与定位），所以模拟器也必须让两者不同，
    // 否则"用错口径"这类 bug 在模拟数据上根本暴露不出来。
    let numSV = 0;
    if (stage === 2) numSV = Math.min(active.length, 6);
    else if (stage === 3) numSV = Math.min(active.length, 12);

    const activeSet = {};
    active.forEach(s => { activeSet[s.talker + '-' + s.prn] = true; });

    // DOP：冷启动差 → 收敛后好
    let hdop, pdop, vdop;
    if (stage === 0) { hdop = 9.99; pdop = 19.99; vdop = 19.99; }
    else if (stage === 2) { hdop = rand(1.9, 3.2); pdop = hdop * rand(1.4, 1.8); vdop = hdop * rand(1.6, 2.2); }
    else { hdop = rand(0.7, 1.2); pdop = hdop * rand(1.3, 1.7); vdop = hdop * rand(1.4, 1.9); }

    const usedSet = activeSet;

    // ---- GSV：按星座分条，每条最多 4 颗 ----
    const byTalker = {};
    visible.forEach(s => {
      (byTalker[s.talker] = byTalker[s.talker] || []).push(s);
    });
    for (const c of CONSTELLATIONS) {
      const list = byTalker[c.talker] || [];
      if (!list.length) continue;
      const total = Math.ceil(list.length / 4);
      for (let i = 0; i < total; i++) {
        const chunk = list.slice(i * 4, i * 4 + 4);
        let body = c.talker + 'GSV,' + total + ',' + (i + 1) + ',' + list.length;
        for (const s of chunk) {
          // 冷启动阶段尚未跟踪到信号的卫星，信噪比字段为空（真实模块的行为）
          const tracked = acq >= 1 || !!usedSet[s.talker + '-' + s.prn];
          const snr = tracked
            ? String(Math.max(18, Math.min(50, Math.round(s.snrBase + rand(-2, 2)))))
            : '';
          body += ',' + s.prn + ',' + String(Math.round(s.el)).padStart(2, '0') +
            ',' + String(Math.round(s.az)).padStart(3, '0') + ',' + snr;
        }
        this._emit(buildSentence(body));
      }
    }

    // ---- GSA：与真实模块一致 —— 报文头用 GN，靠末尾的系统 ID 字段区分星座 ----
    // （真实设备发的是 $GNGSA × N，不是 $GPGSA/$GAGSA；模拟器必须照抄，
    //   否则"按报文头判星座"这类 bug 在演示模式下永远看不到）
    for (const c of CONSTELLATIONS) {
      const list = (byTalker[c.talker] || []).filter(s => usedSet[s.talker + '-' + s.prn]);
      let body = 'GNGSA,A,' + stage;
      for (let i = 0; i < 12; i++) {
        body += ',' + (list[i] ? list[i].prn : '');
      }
      body += ',' + pdop.toFixed(1) + ',' + hdop.toFixed(1) + ',' + vdop.toFixed(1)
        + ',' + c.sysId;
      this._emit(buildSentence(body));
    }

    // ---- 位置：静止 + 噪声 + 缓慢漂移（模拟多径）----
    const t = elapsed;
    const drift = hdop * 0.6;
    const lat = this.base.lat + (Math.sin(t / 27) * drift + rand(-1, 1) * hdop * 0.35) / 111320;
    const lng = this.base.lng + (Math.cos(t / 31) * drift + rand(-1, 1) * hdop * 0.35) / (111320 * Math.cos(this.base.lat * Math.PI / 180));
    const { time, date } = this._utc();

    const q = stage === 3 ? 1 : 0;                    // 单点定位
    const ggaSats = stage === 0 ? 0 : numSV;          // 接收机自报的参与定位卫星数

    // ⚠️ 未定位时经纬度字段必须留空但**占位**，否则字段数错位、语句不合法
    const hasFix = stage !== 0;
    const latF = hasFix ? degToNmea(lat, true) : '';
    const lonF = hasFix ? degToNmea(lng, false) : '';
    const latH = hasFix ? 'N' : '';
    const lonH = hasFix ? 'E' : '';

    // ---- GGA ----
    this._emit(buildSentence(
      'GNGGA,' + time + ',' +
      latF + ',' + latH + ',' +
      lonF + ',' + lonH + ',' +
      q + ',' + String(ggaSats).padStart(2, '0') + ',' +
      hdop.toFixed(1) + ',' +
      (hasFix ? rand(380, 420).toFixed(1) : '') + ',M,' +
      rand(30, 40).toFixed(1) + ',M,,'
    ));

    // ---- RMC ----
    this._emit(buildSentence(
      'GNRMC,' + time + ',' + (stage >= 2 ? 'A' : 'V') + ',' +
      latF + ',' + latH + ',' +
      lonF + ',' + lonH + ',' +
      '0.00,' + rand(0, 359).toFixed(2) + ',' + date + ',,,A'
    ));

    // ---- VTG ----
    this._emit(buildSentence(
      'GNVTG,' + rand(0, 359).toFixed(2) + ',T,,M,0.00,N,0.00,K,A'
    ));
  }
}

module.exports = { NmeaSim, BASE };
