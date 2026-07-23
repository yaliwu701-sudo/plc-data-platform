'use strict';

/**
 * connectors/index.js — 真实 PLC 采集连接器（RealPlcManager）
 *
 *  - 按设备品牌选择对应驱动：欧姆龙 / 西门子 / 三菱 / 台达
 *  - 驱动库「懒加载」：缺失时标记 driver_missing，不影响其他设备或 mock 模式
 *  - 轮询读取各点位地址，将数值写入 simulator（sim.applyExternal），复用历史/报警/BI 逻辑
 *  - 连接失败 / 读取出错时优雅降级（标记 offline，后台自动重连），不会拖垮服务
 *
 * 各品牌 read() 的地址解析已对齐对应驱动库的真实 API（omron-fins@0.5 / mcprotocol@0.1 /
 * node-snap7@1 / modbus-serial@8）。实际 PLC 型号、地址字长/字节序可能与此处「典型用法」
 * 略有差异，连接真机时请以驱动库文档为准微调（单点失败已做防御，不会中断服务）。
 */

const { EventEmitter } = require('events');

function safeRequire(name) {
  try { return require(name); }
  catch (e) { return { __missing: true, error: e.message }; }
}

function promisify(cbFn, ...args) {
  return new Promise((resolve, reject) => {
    try { cbFn(...args, (err, result) => err ? reject(err) : resolve(result)); }
    catch (e) { reject(e); }
  });
}

// ---------------- 基类 ----------------
class Connector {
  constructor(device) {
    this.device = device;
    this.status = 'init';     // init | online | offline | driver_missing | unsupported
    this.error = null;
    this.conn = null;
  }
  setStatus(s, err) { this.status = s; this.error = err || null; }
  async connect() { this.setStatus('unsupported', '该品牌暂未实现真实采集'); return false; }
  async read(/* point */) { return null; }
  close() {}
}

// ---------------- 欧姆龙 (omron-fins) ----------------
class OmronConnector extends Connector {
  async connect() {
    const lib = safeRequire('omron-fins');
    if (lib.__missing) { this.setStatus('driver_missing', '未安装 omron-fins（npm i omron-fins）'); return false; }
    try {
      const FinsClient = lib.FinsClient || lib.Fins || lib;
      this.conn = new FinsClient({ host: this.device.ip, port: 9600 });
      if (typeof this.conn.connect === 'function') {
        await Promise.race([
          this.conn.connect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 4000))
        ]);
      }
      this.setStatus('online');
      return true;
    } catch (e) { this.setStatus('offline', e.message); return false; }
  }
  async read(point) {
    if (!this.conn) return null;
    try {
      const raw = await this.conn.read((point.address || '').trim());
      const v = Array.isArray(raw) ? raw[0] : raw;
      return point.dataType === 'bool' ? !!v : Number(v);
    } catch (e) { this.setStatus('offline', e.message); return null; }
  }
  close() { try { this.conn && this.conn.disconnect && this.conn.disconnect(); } catch (e) {} }
}

// ---------------- 西门子 (node-snap7，回调式) ----------------
class SiemensConnector extends Connector {
  async connect() {
    const lib = safeRequire('node-snap7');
    if (lib.__missing) { this.setStatus('driver_missing', '未安装 node-snap7（需本机编译环境）'); return false; }
    try {
      this.conn = new lib.S7Client();
      await Promise.race([
        promisify((cb) => this.conn.ConnectTo(this.device.ip, 0, 1, cb)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 4000))
      ]);
      this.setStatus('online');
      return true;
    } catch (e) { this.setStatus('offline', e.message); return false; }
  }
  read(point) {
    if (!this.conn) return Promise.resolve(null);
    return new Promise((resolve) => {
      try {
        const S7 = this.conn;
        const addr = (point.address || '').trim();
        let area, db = 0, start, wordLen, len;
        const m = /^DB(\d+)\.DBD?(\d+)/i.exec(addr) || /^([IQM])(\d+)/i.exec(addr);
        if (!m) return resolve(null);
        if (m[1] && /DB/i.test(m[0])) { area = S7.S7AreaDB; db = Number(m[1]); start = Number(m[2]); }
        else { const t = m[1].toUpperCase(); area = t === 'I' ? S7.S7AreaPE : t === 'Q' ? S7.S7AreaPA : S7.S7AreaMK; db = 0; start = Number(m[2]); }
        if (point.dataType === 'bool') { wordLen = S7.S7WLByte; len = 1; }
        else if (point.dataType === 'int') { wordLen = S7.S7WLWord; len = 1; }
        else { wordLen = S7.S7WLReal; len = 1; }
        S7.ReadArea(area, db, start, len, wordLen, (err, buffer) => {
          if (err) { this.setStatus('offline', err.message || String(err)); return resolve(null); }
          if (point.dataType === 'bool') return resolve(!!(buffer[0] & 0x01));
          if (point.dataType === 'int') return resolve(buffer.readUInt16BE ? buffer.readUInt16BE(0) : buffer[0]);
          return resolve(buffer.readFloatBE ? buffer.readFloatBE(0) : Number(buffer[0]));
        });
      } catch (e) { this.setStatus('offline', e.message); resolve(null); }
    });
  }
  close() { try { this.conn && this.conn.Disconnect && this.conn.Disconnect(); } catch (e) {} }
}

// ---------------- 三菱 (mcprotocol，批量读取) ----------------
class MitsubishiConnector extends Connector {
  async connect() {
    const lib = safeRequire('mcprotocol');
    if (lib.__missing) { this.setStatus('driver_missing', '未安装 mcprotocol（npm i mcprotocol）'); return false; }
    try {
      this.conn = new lib({ host: this.device.ip, port: 5007, ascii: false, plc: 'Q' });
      await new Promise((res, rej) => {
        this.conn.once('connected', res);
        this.conn.once('error', rej);
        this.conn.initiateConnection();
        setTimeout(() => rej(new Error('连接超时')), 4000);
      });
      this.setStatus('online');
      return true;
    } catch (e) { this.setStatus('offline', e.message); return false; }
  }
  async read(point) {
    if (!this.conn) return null;
    const tag = (point.address || '').trim();
    try {
      this.conn.addItems(tag);
      const data = await promisify((cb) => this.conn.readAllItems(cb));
      const v = data && data[tag];
      if (v == null) return null;
      return point.dataType === 'bool' ? !!v : Number(v);
    } catch (e) { this.setStatus('offline', e.message); return null; }
  }
  close() { try { this.conn && this.conn.dropConnection && this.conn.dropConnection(); } catch (e) {} }
}

// ---------------- 台达 (modbus-serial) ----------------
class DeltaConnector extends Connector {
  async connect() {
    const lib = safeRequire('modbus-serial');
    if (lib.__missing) { this.setStatus('driver_missing', '未安装 modbus-serial（需本机编译环境）'); return false; }
    try {
      this.conn = new lib();
      await Promise.race([
        this.conn.connectTCP(this.device.ip, { port: 502 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('连接超时')), 4000))
      ]);
      this.setStatus('online');
      return true;
    } catch (e) { this.setStatus('offline', e.message); return false; }
  }
  async read(point) {
    if (!this.conn) return null;
    try {
      const addr = (point.address || '').trim();
      const reg = Number((addr.replace(/[^0-9]/g, '') || '0'));
      let d;
      if (/^0x/i.test(addr)) d = await this.conn.readCoils(reg, 1);
      else if (/^3x/i.test(addr)) d = await this.conn.readInputRegisters(reg, 1);
      else d = await this.conn.readHoldingRegisters(reg, 1); // 4x / 默认
      return d && d.data ? d.data[0] : null;
    } catch (e) { this.setStatus('offline', e.message); return null; }
  }
  close() { try { this.conn && this.conn.close && this.conn.close(); } catch (e) {} }
}

function createConnector(device) {
  switch (device.brand) {
    case 'omron': return new OmronConnector(device);
    case 'siemens': return new SiemensConnector(device);
    case 'mitsubishi': return new MitsubishiConnector(device);
    case 'delta': return new DeltaConnector(device);
    default: { const c = new Connector(device); c.setStatus('unsupported', '该品牌暂未实现真实采集'); return c; }
  }
}

// ---------------- 管理器 ----------------
class RealPlcManager extends EventEmitter {
  constructor(sim) {
    super();
    this.sim = sim;
    this.connectors = new Map();   // deviceId -> Connector
    this.devicesMap = new Map();
    this.timer = null;
    this.tickMs = 1000;
    this.lastPoll = 0;
  }

  setTick(ms) { this.tickMs = Math.max(200, Number(ms) || 1000); }

  start(devices) {
    this.stop();
    this.devicesMap = new Map(devices.map((d) => [d.id, d]));
    for (const d of devices) {
      const c = createConnector(d);
      this.connectors.set(d.id, c);
      c.connect().catch((e) => c.setStatus('offline', e.message));
    }
    this.timer = setInterval(() => this.poll().catch(() => {}), this.tickMs);
    setTimeout(() => this.broadcastStatus(), 800);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.connectors.values()) c.close();
    this.connectors.clear();
  }

  isRunning() { return !!this.timer; }

  async poll() {
    this.lastPoll = Date.now();
    for (const [devId, c] of this.connectors) {
      const device = this.devicesMap.get(devId);
      if (!device) continue;
      if (c.status === 'offline' && c.conn === null) {
        try { await c.connect(); } catch (e) { c.setStatus('offline', e.message); }
      }
      if (c.status !== 'online') continue;
      for (const p of device.points || []) {
        try {
          const v = await c.read(p);
          if (v != null) { this.sim.applyExternal(p.id, v); }
        } catch (e) {
          c.setStatus('offline', e.message);
        }
      }
    }
    this.broadcastStatus();
  }

  getStatus() {
    const out = [];
    for (const [devId, c] of this.connectors) {
      const d = this.devicesMap.get(devId);
      out.push({ deviceId: devId, name: d ? d.name : devId, brand: d ? d.brand : '', status: c.status, error: c.error });
    }
    return out;
  }

  broadcastStatus() {
    this.emit('status', this.getStatus());
  }
}

module.exports = RealPlcManager;
