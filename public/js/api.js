'use strict';

/**
 * api.js — 前端与后端 REST 通信封装（带登录 token）
 */
const API = {
  token: localStorage.getItem('plc-token') || '',

  _headers(extra) {
    const h = Object.assign({ Accept: 'application/json' }, extra || {});
    if (this.token) h['Authorization'] = 'Bearer ' + this.token;
    return h;
  },
  async get(url) {
    const r = await fetch(url, { headers: this._headers() });
    if (r.status === 401) throw Object.assign(new Error('未登录'), { code: 401 });
    if (!r.ok) throw new Error('GET ' + url + ' -> ' + r.status);
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body || {})
    });
    if (r.status === 401) throw Object.assign(new Error('未登录'), { code: 401 });
    if (!r.ok) throw new Error('POST ' + url + ' -> ' + r.status);
    return r.json();
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE', headers: this._headers() });
    if (r.status === 401) throw Object.assign(new Error('未登录'), { code: 401 });
    if (!r.ok) throw new Error('DELETE ' + url + ' -> ' + r.status);
    return r.json();
  },

  login: async (user, pass) => {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass })
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '登录失败'); }
    const d = await r.json();
    API.token = d.token;
    localStorage.setItem('plc-token', d.token);
    return d;
  },
  logout: async () => {
    try { await fetch('/api/logout', { method: 'POST', headers: API._headers() }); } catch (e) {}
    API.token = '';
    localStorage.removeItem('plc-token');
  },
  me: () => API.get('/api/me'),

  getConfig: () => API.get('/api/config'),
  setConfig: (c) => API.post('/api/config', c),
  getDevices: () => API.get('/api/devices'),
  getBrands: () => API.get('/api/brands'),
  getStatus: () => API.get('/api/status'),
  addDevice: (d) => API.post('/api/devices', d),
  deleteDevice: (id) => API.del('/api/devices/' + id),
  addPoints: (devId, points) => API.post('/api/devices/' + devId + '/points', { points }),
  deletePoint: (id) => API.del('/api/points/' + id),
  getPoints: () => API.get('/api/points'),
  getValues: () => API.get('/api/values'),
  getHistory: (id, window) => API.get('/api/points/' + id + '/history?window=' + window),
  getKPI: (ids, window) => API.get('/api/kpi?ids=' + (ids || '').join(',') + '&window=' + (window || 300000)),
  getAlarms: (filter) => API.get('/api/alarms?filter=' + (filter || 'all')),
  ackAlarm: (id) => API.post('/api/alarms/' + id + '/ack'),
  clearAlarms: () => API.post('/api/alarms/clear'),
  exportSnapshot: () => '/api/export/snapshot',
  exportHistory: (ids, window) => '/api/export/history?ids=' + (ids || []).join(',') + '&window=' + (window || 3600000)
};
