'use strict';

/**
 * index.js — PLC 数据平台服务端入口
 *
 *  - Express 提供 REST API + 静态资源
 *  - WebSocket (/ws) 实时推送数值与报警（需携带登录 token）
 *  - 登录鉴权：默认 admin/admin123，支持环境变量覆盖与改密（见 server/auth.js）
 *  - 两种运行模式：
 *      mock  -> 模拟引擎全功能（默认，开箱即跑）
 *      real  -> 真实 PLC 采集（server/connectors，按品牌加载驱动，缺驱动优雅降级）
 */

const path = require('path');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const express = require('express');
const { WebSocketServer } = require('ws');

const store = require('./store');
const Simulator = require('./simulator');
const auth = require('./auth');
const RealPlcManager = require('./connectors');

// ---------- 崩溃兜底（稳定性关键）----------
const LOG_DIR = path.join(__dirname, '..', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
function logFatal(where, err) {
  const ts = new Date().toISOString();
  const line = '[' + ts + '] [FATAL ' + where + '] ' + (err && err.stack ? err.stack : err) + '\n';
  try { fs.appendFileSync(path.join(LOG_DIR, 'error.log'), line); } catch (e2) {}
  console.error(line);
}
process.on('uncaughtException', (err) => { logFatal('uncaughtException', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { logFatal('unhandledRejection', reason); });

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MODE = process.env.PLC_MODE || 'mock';   // 环境变量可强制模式

// ---------- 初始化存储 + 模拟引擎 ----------
let devices = store.loadDevices();
if (devices === null) {
  devices = store.seedDevices();
  store.saveDevices(devices);
  console.log('[init] 已注入示例设备（欧姆龙/西门子/三菱/台达），开箱即跑通。');
}
let config = store.loadConfig();
if (MODE === 'real' || MODE === 'mock') config.mode = MODE;
if (!config.mode) config.mode = 'mock';
if (config.adminHash) auth.setUsers({ [config.adminUser || 'admin']: config.adminHash });

const sim = new Simulator();
sim.setTick(config.tickMs || 1000);
sim.syncFromDevices(devices);
if (config.mode === 'mock') sim.start();

const plc = new RealPlcManager(sim);
let lastConnectorStatus = [];
plc.on('status', (st) => { lastConnectorStatus = st; broadcast({ type: 'status', connectors: st }); });

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '2mb' }));
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// 鉴权中间件：保护 /api/*，放行登录/健康检查/me（me 返回 401 供前端判断是否已登录）
function tokenFromReq(req) {
  const authHdr = req.headers['authorization'] || '';
  if (authHdr.startsWith('Bearer ')) return authHdr.slice(7).trim();
  return null;
}
app.use('/api', (req, res, next) => {
  // 注意：app.use('/api', mw) 挂载后 req.path 已去掉 /api 前缀（如 /login、/health）
  const open = ['/login', '/health'];
  if (open.includes(req.path)) return next();
  const token = tokenFromReq(req);
  if (!auth.verify(token)) return res.status(401).json({ error: '未登录或登录已失效' });
  req.user = auth.verify(token);
  next();
});

// 小工具
function findDevice(id) { return devices.find((d) => d.id === id); }
function allPoints() {
  const out = [];
  for (const d of devices) for (const p of d.points) out.push({ ...p, deviceId: d.id, deviceName: d.name, brand: d.brand });
  return out;
}
function send(res, code, obj) { res.status(code).json(obj); }

// ---------- 鉴权相关路由 ----------
app.get('/api/health', (req, res) => send(res, 200, { ok: true, mode: config.mode, time: Date.now() }));

app.post('/api/login', (req, res) => {
  const b = req.body || {};
  const token = auth.login(b.user || '', b.pass || '');
  if (!token) return send(res, 401, { error: '用户名或密码错误' });
  send(res, 200, { ok: true, token, user: b.user, mode: config.mode });
});

app.post('/api/logout', (req, res) => {
  auth.logout(tokenFromReq(req));
  send(res, 200, { ok: true });
});

app.get('/api/me', (req, res) => {
  const user = auth.verify(tokenFromReq(req));
  if (!user) return send(res, 401, { error: '未登录' });
  send(res, 200, { user, mode: config.mode });
});

app.post('/api/password', (req, res) => {
  const user = auth.verify(tokenFromReq(req));
  if (!user) return send(res, 401, { error: '未登录' });
  const b = req.body || {};
  if (!auth.verifyPass(user, b.oldPass || '')) return send(res, 400, { error: '原密码错误' });
  if (!b.newPass || String(b.newPass).length < 6) return send(res, 400, { error: '新密码至少 6 位' });
  const h = auth.hash(b.newPass);
  config.adminHash = h; config.adminUser = user;
  store.saveConfig(config);
  auth.setUsers({ [user]: h });
  send(res, 200, { ok: true });
});

// ---------- 配置 / 模式 ----------
app.get('/api/config', (req, res) => send(res, 200, config));
app.post('/api/config', (req, res) => {
  const body = req.body || {};
  if (body.mode) config.mode = body.mode === 'real' ? 'real' : 'mock';
  if (body.tickMs) { config.tickMs = Math.max(200, Number(body.tickMs) || 1000); sim.setTick(config.tickMs); plc.setTick(config.tickMs); }
  store.saveConfig(config);
  applyMode();
  send(res, 200, { ok: true, config, connectors: config.mode === 'real' ? lastConnectorStatus : [] });
});

function applyMode() {
  if (config.mode === 'mock') {
    plc.stop();
    sim.start();
  } else {
    sim.stop();
    plc.start(devices);
  }
}

// ---------- 设备 ----------
app.get('/api/devices', (req, res) => {
  const list = devices.map((d) => ({ ...d, _status: (lastConnectorStatus.find((s) => s.deviceId === d.id) || {}).status || (config.mode === 'mock' ? 'online' : 'init') }));
  send(res, 200, list);
});

app.get('/api/brands', (req, res) => send(res, 200, { brands: store.BRANDS, protocols: store.PROTOCOLS }));

app.post('/api/devices', (req, res) => {
  const b = req.body || {};
  if (!b.name) return send(res, 400, { error: '缺少设备名称 name' });
  const dev = {
    id: store.uid('dev'), name: b.name, brand: b.brand || 'other', model: b.model || '',
    ip: b.ip || '', protocol: b.protocol || '',
    status: config.mode === 'mock' ? 'online' : 'init',
    createdAt: Date.now(), points: []
  };
  devices.push(dev);
  store.saveDevices(devices);
  sim.syncFromDevices(devices);
  if (config.mode === 'real') plc.start(devices);
  send(res, 201, dev);
});

app.get('/api/devices/:id', (req, res) => {
  const d = findDevice(req.params.id);
  if (!d) return send(res, 404, { error: '设备不存在' });
  send(res, 200, d);
});

app.delete('/api/devices/:id', (req, res) => {
  const i = devices.findIndex((d) => d.id === req.params.id);
  if (i < 0) return send(res, 404, { error: '设备不存在' });
  devices.splice(i, 1);
  store.saveDevices(devices);
  sim.syncFromDevices(devices);
  if (config.mode === 'real') plc.start(devices);
  send(res, 200, { ok: true });
});

// ---------- 点位（批量增加） ----------
app.get('/api/points', (req, res) => send(res, 200, allPoints()));

app.post('/api/devices/:id/points', (req, res) => {
  const d = findDevice(req.params.id);
  if (!d) return send(res, 404, { error: '设备不存在' });
  const arr = Array.isArray(req.body.points) ? req.body.points : (Array.isArray(req.body) ? req.body : []);
  if (!arr.length) return send(res, 400, { error: 'points 为空' });
  const created = [];
  for (const p of arr) {
    if (!p.name) continue;
    const pt = {
      id: store.uid('pt'), name: p.name, address: p.address || '',
      dataType: ['float', 'int', 'bool'].includes(p.dataType) ? p.dataType : 'float',
      unit: p.unit || '',
      simMin: Number(p.simMin != null ? p.simMin : 0),
      simMax: Number(p.simMax != null ? p.simMax : 100),
      base: Number(p.base != null ? p.base : (Number(p.simMin != null ? p.simMin : 0) + Number(p.simMax != null ? p.simMax : 100)) / 2),
      amplitude: Number(p.amplitude != null ? p.amplitude : 0),
      frequency: Number(p.frequency != null ? p.frequency : 0.03),
      noise: Number(p.noise != null ? p.noise : 1),
      alarmEnabled: !!p.alarmEnabled,
      alarmHigh: p.alarmHigh != null ? Number(p.alarmHigh) : null,
      alarmLow: p.alarmLow != null ? Number(p.alarmLow) : null
    };
    d.points.push(pt);
    created.push(pt);
  }
  store.saveDevices(devices);
  sim.syncFromDevices(devices);
  if (config.mode === 'real') plc.start(devices);
  send(res, 201, { created, count: created.length });
});

app.delete('/api/points/:id', (req, res) => {
  for (const d of devices) {
    const i = d.points.findIndex((p) => p.id === req.params.id);
    if (i >= 0) {
      d.points.splice(i, 1);
      store.saveDevices(devices);
      sim.syncFromDevices(devices);
      if (config.mode === 'real') plc.start(devices);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: '点位不存在' });
});

// ---------- 实时值 / 历史 / KPI ----------
app.get('/api/values', (req, res) => send(res, 200, sim.snapshot()));

app.get('/api/points/:id/history', (req, res) => {
  const windowMs = Number(req.query.window) || 5 * 60 * 1000;
  const h = sim.getHistory([req.params.id], windowMs);
  send(res, 200, h[0] || { id: req.params.id, name: '', unit: '', data: [] });
});

app.get('/api/kpi', (req, res) => {
  const windowMs = Number(req.query.window) || 5 * 60 * 1000;
  const ids = req.query.ids ? String(req.query.ids).split(',') : allPoints().map((p) => p.id);
  send(res, 200, sim.getKPI(ids, windowMs));
});

// ---------- 报警 ----------
app.get('/api/alarms', (req, res) => {
  const filter = req.query.filter || 'all';
  send(res, 200, sim.getAlarms(filter));
});

app.post('/api/alarms/:id/ack', (req, res) => {
  const a = sim.ackAlarm(req.params.id);
  if (!a) return send(res, 404, { error: '报警不存在' });
  send(res, 200, { ok: true, alarm: a });
});

app.post('/api/alarms/clear', (req, res) => { sim.clearAlarms(); send(res, 200, { ok: true }); });

// ---------- PLC 连接状态 ----------
app.get('/api/status', (req, res) => send(res, 200, { mode: config.mode, connectors: config.mode === 'real' ? lastConnectorStatus : [] }));

// ---------- 导出 CSV ----------
app.get('/api/export/snapshot', (req, res) => {
  const rows = sim.snapshot().map((s) => ({
    设备: s.deviceName, 点位: s.name, 地址: (allPoints().find((p) => p.id === s.id) || {}).address || '',
    当前值: s.value, 单位: s.unit, 类型: s.dataType, 更新时间: new Date(s.updatedAt).toISOString()
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plc_snapshot_' + Date.now() + '.csv"');
  res.send(toCSV(rows));
});

app.get('/api/export/history', (req, res) => {
  const windowMs = Number(req.query.window) || 60 * 60 * 1000;
  const ids = req.query.ids ? String(req.query.ids).split(',') : allPoints().map((p) => p.id);
  const series = sim.getHistory(ids, windowMs);
  const map = new Map();
  for (const s of series) {
    for (const [t, v] of s.data) {
      if (!map.has(t)) map.set(t, { t });
      map.get(t)[s.name] = v;
    }
  }
  const times = [...map.keys()].sort((a, b) => a - b);
  const names = series.map((s) => s.name);
  const rows = times.map((t) => {
    const row = { 时间: new Date(t).toISOString() };
    for (const n of names) row[n] = map.get(t)[n];
    return row;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="plc_history_' + Date.now() + '.csv"');
  res.send(toCSV(rows));
});

function toCSV(rows) {
  if (!rows.length) return '无数据';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return '﻿' + lines.join('\n');
}

// ---------- HTTP + WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (e) { /* ignore */ }
    }
  }
}

wss.on('connection', (ws, req) => {
  // WebSocket 鉴权：需携带 ?token=
  let token = null;
  try { token = new URL(req.url, 'http://localhost').searchParams.get('token'); } catch (e) {}
  if (!auth.verify(token)) { try { ws.close(4001, 'unauthorized'); } catch (e) {} return; }

  ws.send(JSON.stringify({
    type: 'init',
    config,
    devices,
    values: sim.snapshot(),
    kpi: sim.getKPI(allPoints().map((p) => p.id), 5 * 60 * 1000),
    alarms: sim.getAlarms('all'),
    connectors: config.mode === 'real' ? lastConnectorStatus : []
  }));
});

function startServer(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('[warn] 端口 ' + port + ' 被占用，自动尝试 ' + (port + 1));
      startServer(port + 1);
    } else {
      console.error('[fatal] 服务启动失败:', err.message);
      process.exit(1);
    }
  });
  server.listen(port, HOST, () => {
    const ifaces = os.networkInterfaces();
    const lan = [];
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name]) {
        if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
      }
    }
    console.log('========================================================');
    console.log('  PLC 数据采集与管理平台 已启动');
    console.log('  本机访问 :  http://localhost:' + port);
    if (lan.length) console.log('  局域网访问:  http://' + lan[0] + ':' + port + '  （同网段其他电脑可打开）');
    console.log('  运行模式 :  ' + (config.mode === 'mock' ? '模拟数据(mock)' : '真实PLC(real)'));
    console.log('  账号密码 :  ' + (config.adminUser || auth.defaultUser()) + ' / ' + (process.env.ADMIN_PASS ? '****(env)' : 'admin123(默认)'));
    console.log('========================================================');
    // 记录实际监听端口，便于排查与前端/脚本读取
    try { fs.writeFileSync(path.join(__dirname, '..', 'data', 'port.txt'), String(port)); } catch (e) {}
  });
}

// 端口预检：若已被其他进程占用（含 SO_REUSEADDR 场景），自动顺延到空闲端口
function portFree(port, cb) {
  const sock = net.connect(port, '127.0.0.1');
  let done = false;
  const finish = (free) => { if (!done) { done = true; cb(free); } };
  sock.setTimeout(500);
  sock.once('connect', () => { sock.destroy(); finish(false); });
  sock.once('timeout', () => { sock.destroy(); finish(true); });
  sock.once('error', () => { sock.destroy(); finish(true); });
}

function launch(port) {
  portFree(port, (free) => {
    if (free) startServer(port);
    else { console.warn('[warn] 端口 ' + port + ' 已被占用，自动尝试 ' + (port + 1)); launch(port + 1); }
  });
}

launch(Number(PORT));

// ---------- 优雅关闭（便于看门狗平滑重启）----------
function shutdown(signal) {
  console.log('[shutdown] 收到 ' + signal + '，正在优雅退出…');
  try { sim.stop(); } catch (e) {}
  try { if (typeof plc.stop === 'function') plc.stop(); } catch (e) {}
  try { wss.close(); } catch (e) {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = { app, server, sim, plc };
