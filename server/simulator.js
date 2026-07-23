'use strict';

/**
 * simulator.js — 模拟采集引擎（默认 mock 模式的核心）
 *
 *  - 依据点位的 simMin/simMax/base/amplitude/frequency/noise 生成拟真数值
 *    模型 = 随机游走趋向 (base + 正弦趋势) + 噪声，并夹紧到 [simMin, simMax]
 *  - 维护每个点位的滚动历史（环形缓冲，上限 maxHistory）
 *  - 超阈值（alarmHigh / alarmLow）产生报警，去重为"活动报警"
 *  - 通过 EventEmitter 广播 values / alarm 事件，供 WebSocket 实时推送
 */

const { EventEmitter } = require('events');

function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function round(v, p = 2) {
  const f = Math.pow(10, p);
  return Math.round(v * f) / f;
}

class Simulator extends EventEmitter {
  constructor() {
    super();
    this.points = new Map();      // pointId -> { meta, value, updatedAt }
    this.histories = new Map();   // pointId -> [{ t, v }]
    this.alarms = [];             // 全部报警（最新在前）
    this.activeAlarms = new Map();// pointId -> alarm（活动未解除）
    this.maxHistory = 1800;       // ~30 分钟 @1s
    this.timer = null;
    this.tickMs = 1000;
  }

  setTick(ms) {
    this.tickMs = Math.max(200, Number(ms) || 1000);
  }

  /** 根据设备列表重建点位注册表，尽量保留已有状态/历史 */
  syncFromDevices(devices) {
    const newMap = new Map();
    for (const d of devices) {
      for (const p of d.points || []) {
        const existing = this.points.get(p.id);
        const meta = {
          id: p.id,
          name: p.name,
          deviceId: d.id,
          deviceName: d.name,
          brand: d.brand,
          dataType: p.dataType || 'float',
          unit: p.unit || '',
          simMin: num(p.simMin, 0),
          simMax: num(p.simMax, 100),
          base: num(p.base, (num(p.simMin, 0) + num(p.simMax, 100)) / 2),
          amplitude: num(p.amplitude, (num(p.simMax, 100) - num(p.simMin, 0)) * 0.2),
          frequency: num(p.frequency, 0.05),
          noise: num(p.noise, (num(p.simMax, 100) - num(p.simMin, 0)) * 0.05),
          alarmEnabled: !!p.alarmEnabled,
          alarmHigh: p.alarmHigh != null ? num(p.alarmHigh) : null,
          alarmLow: p.alarmLow != null ? num(p.alarmLow) : null
        };
        if (existing) {
          existing.meta = meta;
          newMap.set(p.id, existing);
        } else {
          const init = meta.dataType === 'bool'
            ? (Math.random() > 0.5)
            : meta.base;
          newMap.set(p.id, { meta, value: init, updatedAt: Date.now() });
        }
        if (!this.histories.has(p.id)) this.histories.set(p.id, []);
      }
    }
    this.points = newMap;
    for (const id of [...this.histories.keys()]) {
      if (!newMap.has(id)) this.histories.delete(id);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  isRunning() {
    return !!this.timer;
  }

  /**
   * 统一入口：处理任意来源的数值（模拟 or 真实 PLC）
   * 负责夹紧/类型化、写入历史、报警判定、返回更新对象
   */
  ingest(id, rawValue) {
    const state = this.points.get(id);
    if (!state) return null;
    const m = state.meta;
    let v;
    if (m.dataType === 'bool') {
      v = !!rawValue;
    } else {
      let n = Number(rawValue);
      if (!Number.isFinite(n)) return null;
      n = Math.max(m.simMin, Math.min(m.simMax, n));
      v = m.dataType === 'int' ? Math.round(n) : round(n);
    }
    const now = Date.now();
    state.value = v;
    state.updatedAt = now;
    const h = this.histories.get(id);
    h.push({ t: now, v });
    if (h.length > this.maxHistory) h.shift();
    this.checkAlarm(id, state, v);
    return { id, value: v, updatedAt: now, unit: m.unit, dataType: m.dataType };
  }

  /** 报警判定（仅数值型点位），去重为活动报警 */
  checkAlarm(id, state, v) {
    const m = state.meta;
    if (!m.alarmEnabled || m.dataType === 'bool') return;
    let breach = null, thr = null;
    if (m.alarmHigh != null && v > m.alarmHigh) { breach = 'high'; thr = m.alarmHigh; }
    else if (m.alarmLow != null && v < m.alarmLow) { breach = 'low'; thr = m.alarmLow; }

    if (breach) {
      let a = this.activeAlarms.get(id);
      const now = Date.now();
      if (!a) {
        a = {
          id: 'al_' + id + '_' + now,
          pointId: id, deviceId: m.deviceId, deviceName: m.deviceName,
          pointName: m.name, unit: m.unit, type: breach,
          level: breach === 'high' ? '高报' : '低报',
          threshold: thr, value: v, firstAt: now, lastAt: now, count: 1,
          active: true, acked: false
        };
        this.activeAlarms.set(id, a);
        this.alarms.unshift(a);
        this.emit('alarm', a);
      } else {
        a.value = v; a.lastAt = now; a.count++; a.threshold = thr;
        a.type = breach; a.level = breach === 'high' ? '高报' : '低报';
      }
    } else {
      const a = this.activeAlarms.get(id);
      if (a) { a.active = false; this.activeAlarms.delete(id); }
    }
  }

  /** 外部（真实 PLC）数值注入入口 */
  applyExternal(id, value) {
    const upd = this.ingest(id, value);
    if (upd) this.emit('values', [upd]);
  }

  tick() {
    const now = Date.now();
    const updates = [];
    for (const [id, state] of this.points) {
      const m = state.meta;
      let v;
      if (m.dataType === 'bool') {
        v = Math.random() < 0.12 ? !state.value : state.value;
      } else {
        const t = now / 1000;
        const trend = m.amplitude * Math.sin(2 * Math.PI * m.frequency * t);
        const noise = (Math.random() - 0.5) * 2 * m.noise;
        // 以基线+正弦趋势为主，叠加噪声；随机游走平滑过渡，确保能触达峰/谷（触发阈值）
        const target = m.base + trend;
        let next = state.value + (target - state.value) * 0.5 + noise;
        next = Math.max(m.simMin, Math.min(m.simMax, next));
        v = m.dataType === 'int' ? Math.round(next) : round(next);
      }
      const upd = this.ingest(id, v);
      if (upd) updates.push(upd);
    }
    this.emit('values', updates);
  }

  /** 当前所有点位的实时值 */
  snapshot() {
    const out = [];
    for (const [id, state] of this.points) {
      out.push({
        id,
        value: state.value,
        updatedAt: state.updatedAt,
        unit: state.meta.unit,
        dataType: state.meta.dataType,
        name: state.meta.name,
        deviceId: state.meta.deviceId,
        deviceName: state.meta.deviceName
      });
    }
    return out;
  }

  getHistory(pointIds, windowMs) {
    const now = Date.now();
    return pointIds.map((id) => {
      const state = this.points.get(id);
      if (!state) return null;
      const h = (this.histories.get(id) || []).filter((x) => now - x.t <= windowMs);
      return {
        id,
        name: state.meta.name,
        unit: state.meta.unit,
        dataType: state.meta.dataType,
        data: h.map((x) => [x.t, x.v])
      };
    }).filter(Boolean);
  }

  getKPI(pointIds, windowMs) {
    const now = Date.now();
    return pointIds.map((id) => {
      const state = this.points.get(id);
      if (!state) return null;
      const m = state.meta;
      const cur = state.value;
      if (m.dataType === 'bool') {
        return { id, name: m.name, unit: m.unit, dataType: 'bool', current: cur, avg: null, min: null, max: null };
      }
      const h = (this.histories.get(id) || []).filter((x) => now - x.t <= windowMs);
      const vals = h.length ? h.map((x) => x.v) : [cur];
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const mn = Math.min(...vals);
      const mx = Math.max(...vals);
      return {
        id, name: m.name, unit: m.unit, dataType: m.dataType,
        current: cur, avg: round(avg), min: round(mn), max: round(mx)
      };
    }).filter(Boolean);
  }

  getAlarms(filter) {
    let list = this.alarms;
    if (filter === 'active') list = list.filter((a) => a.active);
    if (filter === 'acked') list = list.filter((a) => a.acked);
    return list;
  }

  ackAlarm(id) {
    const a = this.alarms.find((x) => x.id === id);
    if (a) a.acked = true;
    return a;
  }

  clearAlarms() {
    this.alarms = [];
    this.activeAlarms.clear();
  }
}

module.exports = Simulator;
