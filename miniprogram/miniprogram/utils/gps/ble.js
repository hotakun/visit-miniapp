// utils/gps/ble.js —— 蓝牙扫描/连接/自动枚举 UUID/订阅
class BleManager {
  constructor(opts = {}) {
    this.deviceId = null;
    this.serviceId = null;
    this.notifyChar = null;   // { serviceId, characteristicId, score }
    this.writeChar = null;
    this.connected = false;
    this.onStateChange = null;
    // 优先服务前缀（16位形式）。BT04 数据通道在 FFE0/FFE1，默认优先它。
    this.preferServicePrefix = opts.preferServicePrefix || 'FFE0';
    this._foundHandler = null;
    this._stateHandler = null;
    this._valueHandler = null;
  }

  _p(fn, opts) {
    return new Promise((resolve, reject) => {
      const o = Object.assign({}, opts, { success: resolve, fail: reject });
      try { fn(o); } catch (e) { reject(e); }
    });
  }

  async open() {
    await this._p(wx.openBluetoothAdapter, {});
  }

  async startScan(onFound) {
    if (this._foundHandler) wx.offBluetoothDeviceFound(this._foundHandler);
    this._foundHandler = (res) => {
      (res.devices || []).forEach(d => onFound(d));
    };
    wx.onBluetoothDeviceFound(this._foundHandler);
    await this._p(wx.startBluetoothDevicesDiscovery, { allowDuplicatesKey: false });
  }

  async stopScan() {
    try { await this._p(wx.stopBluetoothDevicesDiscovery, {}); } catch (e) {}
  }

  _watchConnection() {
    if (this._stateHandler) wx.offBLEConnectionStateChange(this._stateHandler);
    this._stateHandler = (res) => {
      this.connected = res.connected;
      if (!res.connected) {
        this.serviceId = null;
        this.notifyChar = null;
        this.writeChar = null;
      }
      if (this.onStateChange) this.onStateChange(res.connected);
    };
    wx.onBLEConnectionStateChange(this._stateHandler);
  }

  async connect(deviceId) {
    this.deviceId = deviceId;
    this._watchConnection();
    await this._p(wx.createBLEConnection, { deviceId, timeout: 10000 });
    this.connected = true;
    try { await this._p(wx.setBLEMTU, { deviceId, mtu: 247 }); } catch (e) {}
    await this.discover(this.preferServicePrefix);
  }

  /**
   * 自动枚举服务与特征，并按优先级挑选通知/写入特征。
   *
   * 关键：不能简单地"取第一个带 notify/indicate 的特征"——因为几乎所有 BLE 设备
   * 都会暴露蓝牙标准服务（00001800 通用访问、00001801 通用属性、0000180A 设备信息…），
   * 其中 00002A05（Service Changed）带 indicate 属性，会排在前面被误选，
   * 导致"连上了但收不到任何业务数据"。
   *
   * 优先级（分数越小越优先）：
   *   0 = 服务 UUID 命中 preferServicePrefix（如 FFE0）且不是 Service Changed
   *   1 = 厂商自定义服务 + notify 属性
   *   2 = 厂商自定义服务 + indicate 属性
   *   3 = 蓝牙标准服务（兜底，避免某些设备只在标准服务里给通知）
   *
   * @param {string} preferServicePrefix 优先服务前缀（16位形式，如 'FFE0'）
   */
  async discover(preferServicePrefix) {
    const { services } = await this._p(wx.getBLEDeviceServices, { deviceId: this.deviceId });
    this.discovered = { services: [], chars: [], candidates: [] };

    const pref = (preferServicePrefix || '').toUpperCase().replace(/^0X/, '');
    const candidates = [];

    for (const s of services) {
      const svc = (s.uuid || '').toUpperCase();
      this.discovered.services.push(s.uuid);
      try {
        const { characteristics } = await this._p(wx.getBLEDeviceCharacteristics, {
          deviceId: this.deviceId,
          serviceId: s.uuid
        });
        for (const c of characteristics) {
          const p = c.properties || {};
          const ch = (c.uuid || '').toUpperCase();
          const propsText = [
            p.read && 'read',
            p.write && 'write',
            p.writeNoResponse && 'writeNR',
            p.notify && 'notify',
            p.indicate && 'indicate'
          ].filter(Boolean).join('|');

          this.discovered.chars.push({
            serviceId: s.uuid,
            characteristicId: c.uuid,
            props: propsText
          });

          if (p.notify || p.indicate) {
            const isSigService = /^000018[0-9A-F]{2}-/.test(svc);   // 标准 SIG 服务段 0x1800-0x18FF
            const isServiceChanged = ch.indexOf('00002A05') === 0;  // 通用 Service Changed
            const hitPref = pref && svc.indexOf('0000' + pref) === 0;

            let score = 3;
            if (isServiceChanged) score = 4;                        // 明确排到最后
            else if (hitPref) score = 0;
            else if (!isSigService && p.notify) score = 1;
            else if (!isSigService) score = 2;

            candidates.push({
              serviceId: s.uuid,
              characteristicId: c.uuid,
              score,
              props: propsText,
              uuid: ch,
              svc
            });
          }

          // 写入特征同样避开标准服务
          if (!this.writeChar && (p.write || p.writeNoResponse)) {
            const isSigService = /^000018[0-9A-F]{2}-/.test(svc);
            if (!isSigService || /^0000FF/.test(svc)) {
              this.writeChar = { serviceId: s.uuid, characteristicId: c.uuid };
            }
          }
        }
      } catch (e) {}
    }

    candidates.sort((a, b) => a.score - b.score || a.uuid.localeCompare(b.uuid));
    this.discovered.candidates = candidates.map(c => c.uuid + ' (score=' + c.score + ')');

    if (candidates.length) {
      const best = candidates[0];
      this.notifyChar = {
        serviceId: best.serviceId,
        characteristicId: best.characteristicId,
        score: best.score
      };
      this.notifyScore = best.score;
    }

    if (!this.notifyChar) {
      throw new Error('未找到可订阅的通知特征（Notify）');
    }
  }

  /**
   * 向模块写入字节（用于下发 UBX 配置报文）。
   * UBX 报文通常 40+ 字节，超过默认 MTU(23→20字节可用)，必须分片发送。
   * 接收机串口看到的是字节流，分片不影响解析（只要顺序正确、完整）。
   * @param {number[]|Uint8Array} bytes
   * @param {number} chunkSize 每片字节数，默认 20
   */
  async writeBytes(bytes, chunkSize) {
    if (!this.writeChar) throw new Error('尚未发现可写入的特征（Write）');
    const size = chunkSize || 20;
    const arr = Uint8Array.from(bytes);
    for (let i = 0; i < arr.length; i += size) {
      const chunk = arr.slice(i, i + size);
      try {
        await this._p(wx.writeBLECharacteristicValue, {
          deviceId: this.deviceId,
          serviceId: this.writeChar.serviceId,
          characteristicId: this.writeChar.characteristicId,
          value: chunk.buffer
        });
      } catch (e) {
        const msg = (e && (e.errMsg || e.message)) || String(e);
        throw new Error('写入失败（特征 ' + this.writeChar.characteristicId
          + '，第 ' + (Math.floor(i / size) + 1) + ' 片）：' + msg);
      }
      // 给模块串口留一点处理时间，避免粘包/丢字节
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  async subscribe(handler) {
    if (!this.notifyChar) throw new Error('尚未发现通知特征');
    if (this._valueHandler) wx.offBLECharacteristicValueChange(this._valueHandler);
    this._valueHandler = (res) => { if (handler) handler(res.value); };
    wx.onBLECharacteristicValueChange(this._valueHandler);
    await this._p(wx.notifyBLECharacteristicValueChange, {
      deviceId: this.deviceId,
      serviceId: this.notifyChar.serviceId,
      characteristicId: this.notifyChar.characteristicId,
      state: true
    });
  }

  async disconnect() {
    if (this.deviceId) {
      try { await this._p(wx.closeBLEConnection, { deviceId: this.deviceId }); } catch (e) {}
    }
    this.connected = false;
    this.deviceId = null;
    this.serviceId = null;
    this.notifyChar = null;
    this.writeChar = null;
  }

  cleanup() {
    if (this._foundHandler) wx.offBluetoothDeviceFound(this._foundHandler);
    if (this._stateHandler) wx.offBLEConnectionStateChange(this._stateHandler);
    if (this._valueHandler) wx.offBLECharacteristicValueChange(this._valueHandler);
    this._foundHandler = null;
    this._stateHandler = null;
    this._valueHandler = null;
    try { wx.closeBluetoothAdapter({}); } catch (e) {}
  }
}

module.exports = { BleManager };
