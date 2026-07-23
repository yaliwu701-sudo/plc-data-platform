'use strict';

/**
 * app.js — PLC 数据平台前端主逻辑
 *  - 视图切换（概览 / 设备与点位 / 趋势 / 报警 / 报表）
 *  - WebSocket 实时刷新（当前值、仪表盘、趋势、报警）
 *  - 明暗主题、批量加点位、KPI、CSV 导出
 */
const state = {
  devices: [], points: [], values: {}, kpiMap: {}, alarms: [], config: {},
  favorites: [], view: 'overview', ws: null, refresh: null, onValues: null, onAlarm: null,
  spark: {}, liveTimer: null
};

const VIEW_TITLES = {
  overview: '概览面板', devices: '设备与点位', trend: '趋势分析', alarms: '报警中心', report: '报表导出'
};
const WINDOWS = { '5分钟': 5 * 60e3, '15分钟': 15 * 60e3, '1小时': 60 * 60e3, '6小时': 6 * 3600e3, '24小时': 24 * 3600e3 };

// ---------- 工具 ----------
const $ = (id) => document.getElementById(id);
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function getPoint(id) { return state.points.find((p) => p.id === id); }
function brandClass(b) { return 'b-' + (b || 'other'); }
function fmt(t) { return new Date(t).toLocaleTimeString('zh-CN', { hour12: false }); }
function fmtDT(t) { const d = new Date(t); return d.toLocaleString('zh-CN', { hour12: false }); }
function colorFor(i) { return Charts.PALETTE[i % Charts.PALETTE.length]; }

function toast(msg, type) {
  const t = el('<div class="toast ' + (type || '') + '">' + msg + '</div>');
  $('toastWrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}

// ---------- 主题 ----------
function applyTheme() {
  let theme = localStorage.getItem('plc-theme') || 'system';
  if (theme === 'system') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', theme);
  state.dark = theme === 'dark';
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('plc-theme', next);
  state.dark = next === 'dark';
  // 重新渲染当前视图以应用图表配色
  Charts.disposeAll();
  renderView(state.view);
}

// ---------- 数据加载 ----------
async function fetchAll() {
  const [devices, points, values, kpi, alarms, config] = await Promise.all([
    API.getDevices(), API.getPoints(), API.getValues(),
    API.getKPI([], 5 * 60e3), API.getAlarms('all'), API.getConfig()
  ]);
  state.devices = devices;
  state.points = points;
  state.values = {};
  values.forEach((v) => { state.values[v.id] = v; });
  state.kpiMap = {};
  kpi.forEach((k) => { state.kpiMap[k.id] = k; });
  state.alarms = alarms;
  state.config = config;
  if (!state.favorites.length) {
    state.favorites = points.filter((p) => p.dataType !== 'bool').slice(0, 6).map((p) => p.id);
  }
  const badge = $('modeBadge');
  if (badge) badge.textContent = config.mode === 'real' ? '真实 PLC' : '模拟数据';
}

// ---------- WebSocket ----------
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = API.token ? '?token=' + encodeURIComponent(API.token) : '';
  const ws = new WebSocket(proto + '://' + location.host + '/ws' + token);
  state.ws = ws;
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connectWS, 2000); };
  ws.onerror = () => setConn(false);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'init') {
      state.devices = msg.devices; state.values = {};
      (msg.values || []).forEach((v) => { state.values[v.id] = v; });
      state.kpiMap = {}; (msg.kpi || []).forEach((k) => { state.kpiMap[k.id] = k; });
      state.alarms = msg.alarms || [];
      if (state.config.mode !== msg.config.mode) { state.config = msg.config; }
      if ($('modeBadge')) $('modeBadge').textContent = msg.config.mode === 'real' ? '真实 PLC' : '模拟数据';
      if (msg.connectors && msg.connectors.length) showConnectorStatus(msg.connectors);
      renderView(state.view);
    } else if (msg.type === 'values') {
      (msg.updates || []).forEach((u) => { state.values[u.id] = u; });
      if (state.onValues) state.onValues(msg.updates);
    } else if (msg.type === 'alarm') {
      if (!state.alarms.find((a) => a.id === msg.alarm.id)) state.alarms.unshift(msg.alarm);
      if (state.onAlarm) state.onAlarm(msg.alarm);
    } else if (msg.type === 'status') {
      if (msg.connectors) showConnectorStatus(msg.connectors);
    }
  };
}
function setConn(ok) {
  const c = $('connStatus');
  if (!c) return;
  c.className = 'conn ' + (ok ? 'online' : 'offline');
  c.innerHTML = '<span class="dot"></span>' + (ok ? '实时已连接' : '连接断开，重连中…');
}

// ---------- 视图切换 ----------
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));
  document.querySelectorAll('.view').forEach((v) => v.classList.add('hidden'));
  $('view-' + view).classList.remove('hidden');
  $('viewTitle').textContent = VIEW_TITLES[view] || view;
  Charts.disposeAll();
  renderView(view);
}

function renderView(view) {
  if (view === 'overview') renderOverview();
  else if (view === 'devices') renderDevices();
  else if (view === 'trend') renderTrend();
  else if (view === 'alarms') renderAlarms();
  else if (view === 'report') renderReport();
}

// ---------- 概览面板 ----------
function renderOverview() {
  const numeric = state.points.filter((p) => p.dataType !== 'bool');
  const bools = state.points.filter((p) => p.dataType === 'bool');
  const container = $('view-overview');
  container.innerHTML = '';

  // 工具栏
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(el('<div class="hint">实时数值 · 仪表盘 · KPI · 报警</div>'));
  bar.appendChild(el('<div class="spacer"></div>'));
  bar.appendChild(buildFavChecklist(() => { renderOverview(); }));
  const exp = el('<button class="btn sm">⬇ 导出快照CSV</button>');
  exp.onclick = () => { window.location = API.exportSnapshot(); };
  bar.appendChild(exp);
  container.appendChild(bar);

  // KPI 卡片
  const kpiTitle = el('<div class="card-title">KPI 卡片 <span class="sub">当前 / 均值 / 最值</span></div>');
  const kpiCard = el('<div class="card"></div>');
  kpiCard.appendChild(kpiTitle);
  const kpiGrid = el('<div class="grid cols-4"></div>');
  kpiCard.appendChild(kpiGrid);
  container.appendChild(kpiCard);

  // 仪表盘
  const gCard = el('<div class="card section-gap"><div class="card-title">关键指标仪表盘</div></div>');
  const gWrap = el('<div class="gauge-wrap"></div>');
  gCard.appendChild(gWrap);
  container.appendChild(gCard);

  // 趋势
  const tCard = el('<div class="card section-gap"><div class="card-title">实时趋势 <span class="sub">多点位对比 · 近5分钟</span></div></div>');
  const tEl = el('<div id="ov_trend" class="chart"></div>');
  tCard.appendChild(tEl);
  container.appendChild(tCard);

  // 报警
  const aCard = el('<div class="card section-gap"><div class="card-title">最新报警 <span class="sub">超阈值</span></div></div>');
  const aEl = el('<div id="ov_alarms"></div>');
  aCard.appendChild(aEl);
  container.appendChild(aCard);

  // 渲染 KPI 卡片
  if (!state.points.length) {
    kpiGrid.appendChild(el('<div class="empty">暂无点位，请到「设备与点位」添加</div>'));
  }
  state.points.forEach((p, i) => {
    if (p.dataType === 'bool') {
      const v = state.values[p.id];
      const on = v && v.value;
      const c = el('<div class="card kpi"><div class="k-name">' + p.name + '</div>' +
        '<div class="k-val" style="color:' + (on ? 'var(--ok)' : 'var(--text-faint)') + '">' + (on ? 'ON' : 'OFF') + '</div>' +
        '<div class="k-row"><span class="tag">' + (p.deviceName || '') + '</span></div></div>');
      kpiGrid.appendChild(c);
      return;
    }
    const k = state.kpiMap[p.id] || {};
    const c = el('<div class="card kpi" id="kpi_' + p.id + '">' +
      '<div class="flex" style="justify-content:space-between"><span class="k-name">' + p.name + '</span>' +
      '<span class="tag" id="kpialarm_' + p.id + '"></span></div>' +
      '<div class="k-val"><span id="kcur_' + p.id + '">--</span><span class="u">' + (p.unit || '') + '</span></div>' +
      '<div class="k-row"><span>均值 <b id="kavg_' + p.id + '">--</b></span><span>最大 <b id="kmax_' + p.id + '">--</b></span><span>最小 <b id="kmin_' + p.id + '">--</b></span></div>' +
      '<div class="spark" id="spark_' + p.id + '"></div></div>');
    kpiGrid.appendChild(c);
    updateKpiCard(p, k);
    // sparkline
    const sp = Charts.make('spark_' + p.id, c.querySelector('#spark_' + p.id));
    sp.setOption(Charts.sparkOption([], colorFor(i)));
  });

  // 仪表盘
  state.favorites.filter((id) => getPoint(id) && getPoint(id).dataType !== 'bool').forEach((id, i) => {
    const p = getPoint(id);
    const cell = el('<div class="card gauge-cell"><div class="gauge" id="gauge_' + id + '"></div></div>');
    gWrap.appendChild(cell);
    const g = Charts.make('gauge_' + id, cell.querySelector('#gauge_' + id));
    const v = state.values[id] ? state.values[id].value : p.base;
    g.setOption(Charts.gaugeOption(v, Number(p.simMin), Number(p.simMax), p.unit, colorFor(i), p.name));
  });

  // 趋势图
  Charts.make('ov_trend', tEl).setOption(buildLineOption(state.favorites));

  // 报警
  renderAlarmList(aEl, state.alarms.slice(0, 8));

  // 实时钩子
  state.onValues = overviewOnValues;
  state.onAlarm = () => renderAlarmList($('ov_alarms'), state.alarms.slice(0, 8));
  state.refresh = overviewRefresh;
}

function updateKpiCard(p, k) {
  const cur = $('kcur_' + p.id), avg = $('kavg_' + p.id), mx = $('kmax_' + p.id), mn = $('kmin_' + p.id), al = $('kpialarm_' + p.id);
  if (!cur) return;
  const v = state.values[p.id];
  cur.textContent = v ? (typeof v.value === 'number' ? v.value : v.value) : '--';
  if (k) {
    avg.textContent = k.avg != null ? k.avg : '--';
    mx.textContent = k.max != null ? k.max : '--';
    mn.textContent = k.min != null ? k.min : '--';
  }
  // 报警标记
  let breach = '';
  if (p.alarmEnabled) {
    const val = v ? Number(v.value) : NaN;
    if (p.alarmHigh != null && !isNaN(val) && val > p.alarmHigh) breach = '高报';
    else if (p.alarmLow != null && !isNaN(val) && val < p.alarmLow) breach = '低报';
  }
  if (al) { al.textContent = breach; al.className = 'tag ' + (breach ? 'bad' : 'ok'); al.textContent = breach || '正常'; }
  const card = $('kpi_' + p.id);
  if (card) card.classList.toggle('alarm', !!breach);
}

function overviewOnValues(updates) {
  updates.forEach((u) => {
    const p = getPoint(u.id);
    if (!p) return;
    if (p.dataType === 'bool') {
      const card = $('kpi_' + u.id);
      if (card) { card.querySelector('.k-val').textContent = u.value ? 'ON' : 'OFF'; card.querySelector('.k-val').style.color = u.value ? 'var(--ok)' : 'var(--text-faint)'; }
      return;
    }
    // 当前值
    const cur = $('kcur_' + u.id);
    if (cur) cur.textContent = u.value;
    // sparkline
    const sp = Charts.get('spark_' + u.id);
    if (sp) {
      if (!state.spark[u.id]) state.spark[u.id] = [];
      state.spark[u.id].push([Date.now(), u.value]);
      if (state.spark[u.id].length > 60) state.spark[u.id].shift();
      sp.setOption(Charts.sparkOption(state.spark[u.id], colorFor(state.points.indexOf(p))));
    }
    // gauge
    const g = Charts.get('gauge_' + u.id);
    if (g) g.setOption(Charts.gaugeOption(u.value, Number(p.simMin), Number(p.simMax), p.unit, colorFor(state.points.indexOf(p)), p.name));
    // 报警标记
    updateKpiCard(p, state.kpiMap[u.id] || {});
  });
}

async function overviewRefresh() {
  try {
    const kpi = await API.getKPI([], 5 * 60e3);
    kpi.forEach((k) => { state.kpiMap[k.id] = k; updateKpiCard(getPoint(k.id), k); });
    const hist = await API.getHistoryBulk(state.favorites, 5 * 60e3);
    const series = hist.map((h) => ({ name: h.name, data: h.data }));
    const inst = Charts.get('ov_trend');
    if (inst) inst.setOption(buildLineOption(state.favorites), true);
    renderAlarmList($('ov_alarms'), state.alarms.slice(0, 8));
  } catch (e) { /* ignore */ }
}

// 批量历史（前端并发请求）
API.getHistoryBulk = async function (ids, windowMs) {
  const res = await Promise.all(ids.map((id) => API.get('/api/points/' + id + '/history?window=' + windowMs)));
  return res;
};

function buildLineOption(ids) {
  const series = ids.filter((id) => getPoint(id)).map((id, i) => {
    const p = getPoint(id);
    const h = state.histCache && state.histCache[id];
    return { name: p.name, data: (h && h.data) || [] };
  });
  return Charts.lineOption(series);
}

// ---------- 设备与点位 ----------
function renderDevices() {
  const container = $('view-devices');
  container.innerHTML = '';
  const title = el('<div class="card-title">设备与采集点位 <span class="sub">支持欧姆龙 / 西门子 / 三菱 / 台达</span></div>');

  // 新增设备表单
  const addCard = el('<div class="card"></div>');
  addCard.appendChild(el('<div class="card-title">新增 PLC 设备</div>'));
  addCard.innerHTML += `
    <div class="row">
      <div class="field"><label>设备名称 *</label><input class="input" id="d_name" placeholder="如：欧姆龙 注塑机 #1"></div>
      <div class="field"><label>品牌</label><select class="select" id="d_brand">
        <option value="omron">欧姆龙 Omron</option><option value="siemens">西门子 Siemens</option>
        <option value="mitsubishi">三菱 Mitsubishi</option><option value="delta">台达 Delta</option>
        <option value="other">其他</option></select></div>
    </div>
    <div class="row">
      <div class="field"><label>型号</label><input class="input" id="d_model" placeholder="如 NX1P2-9024DT"></div>
      <div class="field"><label>IP 地址</label><input class="input" id="d_ip" placeholder="192.168.1.101"></div>
    </div>
    <div class="field"><label>通信协议</label><select class="select" id="d_proto"></select></div>
    <div class="flex"><button class="btn primary" id="d_add">+ 创建设备</button><span class="hint">创建后可在下方批量添加采集点位</span></div>`;
  container.appendChild(title);
  container.appendChild(addCard);

  // 设备列表
  const list = el('<div class="section-gap"></div>');
  container.appendChild(list);
  if (!state.devices.length) list.appendChild(el('<div class="empty">暂无设备</div>'));
  state.devices.forEach((d) => list.appendChild(renderDeviceCard(d)));

  // 协议联动
  const brandSel = addCard.querySelector('#d_brand');
  const protoSel = addCard.querySelector('#d_proto');
  const fillProto = () => {
    const map = { omron: ['FINS/TCP', 'FINS/UDP', 'EtherNet/IP'], siemens: ['S7 (ISO-TCP)', 'Profinet', 'Modbus TCP'], mitsubishi: ['MC Protocol', 'SLMP', 'Modbus TCP'], delta: ['Modbus TCP', 'Modbus RTU', 'Ethernet'], other: ['Modbus TCP', 'OPC UA'] };
    protoSel.innerHTML = (map[brandSel.value] || []).map((p) => '<option>' + p + '</option>').join('');
  };
  fillProto();
  brandSel.onchange = fillProto;
  addCard.querySelector('#d_add').onclick = async () => {
    const name = addCard.querySelector('#d_name').value.trim();
    if (!name) { toast('请填写设备名称', 'bad'); return; }
    try {
      await API.addDevice({ name, brand: brandSel.value, model: addCard.querySelector('#d_model').value, ip: addCard.querySelector('#d_ip').value, protocol: protoSel.value });
      toast('设备已创建', 'ok'); addCard.querySelector('#d_name').value = '';
      await fetchAll(); renderDevices();
    } catch (e) { toast('创建失败：' + e.message, 'bad'); }
  };

  state.onValues = null; state.onAlarm = null; state.refresh = null;
}

function renderDeviceCard(d) {
  const card = el('<div class="card dev-card"></div>');
  const head = el('<div class="dev-head"></div>');
  head.innerHTML = `
    <div>
      <span class="dev-brand ${brandClass(d.brand)}">${(d.brand || '').toUpperCase()}</span>
      <strong style="margin-left:8px">${d.name}</strong>
      <span class="dev-status" id="dst_${d.id}"></span>
      <div class="dev-meta">${d.model || '—'} · ${d.protocol || '—'} · ${d.ip || '未配置IP'} · ${d.points.length} 个点位</div>
    </div>`;
  const del = el('<button class="btn sm danger">删除设备</button>');
  del.onclick = async () => { if (!confirm('确认删除设备「' + d.name + '」及其所有点位？')) return; try { await API.deleteDevice(d.id); toast('已删除', 'ok'); await fetchAll(); renderDevices(); } catch (e) { toast('删除失败：' + e.message, 'bad'); } };
  head.appendChild(del);
  card.appendChild(head);

  // PLC 连接状态徽标（真实模式）
  const stEl = head.querySelector('#dst_' + d.id);
  const st = state.connectorStatus && state.connectorStatus[d.id];
  if (stEl && st && state.config && state.config.mode === 'real') {
    const map = {
      online: ['ok', '● 已连接'], offline: ['bad', '● 离线'],
      driver_missing: ['bad', '● 缺驱动'], unsupported: ['', '● 未支持'],
      init: ['', '● 连接中']
    };
    const info = map[st.status] || ['', '● ' + st.status];
    stEl.className = 'dev-status tag ' + (info[0] || '');
    stEl.textContent = info[1];
    if (st.error) stEl.title = st.error;
  }

  // 点位 chips
  const chips = el('<div class="chips"></div>');
  if (!d.points.length) chips.appendChild(el('<span class="hint">尚未添加点位</span>'));
  d.points.forEach((p) => {
    const v = state.values[p.id];
    const breach = (p.alarmEnabled && v) ? ((p.alarmHigh != null && v.value > p.alarmHigh) || (p.alarmLow != null && v.value < p.alarmLow)) : false;
    const chip = el('<div class="chip ' + (breach ? 'alarm' : '') + '">' + p.name +
      '：<span class="cv">' + (v ? v.value : '--') + '</span> ' + (p.unit || '') + '</div>');
    chips.appendChild(chip);
  });
  card.appendChild(chips);

  // 批量添加点位
  const acc = el('<details class="section-gap"><summary style="cursor:pointer;font-size:13px;font-weight:600">批量添加采集点位</summary></details>');
  acc.innerHTML += `
    <div class="hint" style="margin:10px 0">每行一个点位，CSV 格式：<br>
    <code>名称,地址,类型(float/int/bool),单位,最小,最大,基准,振幅,频率,噪声,报警开(0/1),高报,低报</code><br>
    示例：<code>主轴温度,D100,float,℃,20,120,60,25,0.03,1.5,1,95,25</code></div>
    <textarea class="input" id="pts_${d.id}" rows="5" placeholder="名称,地址,类型,单位,最小,最大,基准,振幅,频率,噪声,报警,高报,低报"></textarea>
    <div class="flex" style="margin-top:10px">
      <button class="btn sm" id="tmpl_${d.id}">填入示例</button>
      <button class="btn sm primary" id="addp_${d.id}">解析并添加</button>
      <span class="hint" id="pv_${d.id}"></span>
    </div>`;
  card.appendChild(acc);

  const tmpl = acc.querySelector('#tmpl_' + d.id);
  tmpl.onclick = () => {
    acc.querySelector('#pts_' + d.id).value =
      '温度,D100,float,℃,20,120,60,25,0.03,1.5,1,95,25\n' +
      '压力,D102,float,bar,0,200,90,40,0.02,3,1,170,10\n' +
      '流量,D104,float,L/min,0,60,30,12,0.05,1,0,,\n' +
      '运行,CIO0,bool,,0,1,1,0,0,0,0,,\n' +
      '频率,D106,float,Hz,0,50,35,10,0.02,0.8,1,48,2';
  };
  const addp = acc.querySelector('#addp_' + d.id);
  addp.onclick = async () => {
    const text = acc.querySelector('#pts_' + d.id).value.trim();
    if (!text) { toast('请先填写点位', 'bad'); return; }
    const points = parsePoints(text);
    if (!points.length) { toast('未解析到有效点位', 'bad'); return; }
    try {
      const r = await API.addPoints(d.id, points);
      toast('已添加 ' + r.count + ' 个点位', 'ok');
      await fetchAll(); renderDevices();
    } catch (e) { toast('添加失败：' + e.message, 'bad'); }
  };

  return card;
}

function parsePoints(text) {
  const out = [];
  text.split('\n').forEach((line) => {
    const c = line.split(',').map((s) => s.trim());
    if (c.length < 2 || !c[0]) return;
    const num = (x, d) => (x === '' || x == null) ? d : Number(x);
    out.push({
      name: c[0], address: c[1], dataType: c[2] || 'float', unit: c[3] || '',
      simMin: num(c[4], 0), simMax: num(c[5], 100), base: num(c[6], (num(c[4], 0) + num(c[5], 100)) / 2),
      amplitude: num(c[7], 0), frequency: num(c[8], 0.03), noise: num(c[9], 1),
      alarmEnabled: Number(c[10] || 0) === 1, alarmHigh: c[11] === '' ? null : num(c[11], null),
      alarmLow: c[12] === '' ? null : num(c[12], null)
    });
  });
  return out;
}

// ---------- 趋势分析 ----------
function renderTrend() {
  const container = $('view-trend');
  container.innerHTML = '';
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(el('<div class="hint">选择点位进行对比分析</div>'));
  bar.appendChild(el('<div class="spacer"></div>'));
  const wsel = el('<select class="select" style="width:auto" id="tr_win"></select>');
  Object.keys(WINDOWS).forEach((k) => { wsel.appendChild(el('<option value="' + WINDOWS[k] + '">' + k + '</option>')); });
  bar.appendChild(wsel);
  container.appendChild(bar);

  const cl = el('<div class="checklist section-gap" id="tr_cl"></div>');
  state.points.forEach((p) => {
    const on = state.favorites.includes(p.id);
    const item = el('<label class="check ' + (on ? 'on' : '') + '"><input type="checkbox" ' + (on ? 'checked' : '') + '> ' + p.name + '</label>');
    item.querySelector('input').onchange = (e) => {
      if (e.target.checked) { if (!state.favorites.includes(p.id)) state.favorites.push(p.id); }
      else state.favorites = state.favorites.filter((x) => x !== p.id);
      item.classList.toggle('on', e.target.checked);
      trendRefresh(Number(wsel.value));
    };
    cl.appendChild(item);
  });
  container.appendChild(cl);

  const card = el('<div class="card"><div class="card-title">趋势曲线 · 多点位对比</div></div>');
  const chartEl = el('<div id="tr_chart" class="chart-lg"></div>');
  card.appendChild(chartEl);
  container.appendChild(card);

  const w = Number(wsel.value) || 5 * 60e3;
  Charts.make('tr_chart', chartEl).setOption(buildLineOption(state.favorites));
  wsel.onchange = () => trendRefresh(Number(wsel.value));

  state.onValues = (updates) => { /* 趋势图由 refresh 周期更新，避免抖动 */ };
  state.onAlarm = null;
  state.refresh = () => trendRefresh(Number(wsel.value));
  trendRefresh(w);
}

async function trendRefresh(windowMs) {
  try {
    const hist = await API.getHistoryBulk(state.favorites, windowMs);
    state.histCache = state.histCache || {};
    hist.forEach((h) => { state.histCache[h.id] = h; });
    const inst = Charts.get('tr_chart');
    if (inst) inst.setOption(buildLineOption(state.favorites), true);
  } catch (e) { /* ignore */ }
}

// ---------- 报警中心 ----------
function renderAlarms() {
  const container = $('view-alarms');
  container.innerHTML = '';
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(el('<div class="hint">超阈值报警记录</div>'));
  bar.appendChild(el('<div class="spacer"></div>'));
  const fsel = el('<select class="select" style="width:auto" id="al_f"><option value="all">全部</option><option value="active">活动</option><option value="acked">已确认</option></select>');
  bar.appendChild(fsel);
  const clear = el('<button class="btn sm danger">清空记录</button>');
  clear.onclick = async () => { if (!confirm('确认清空全部报警记录？')) return; try { await API.clearAlarms(); state.alarms = []; renderAlarmTable(); toast('已清空', 'ok'); } catch (e) { toast('失败：' + e.message, 'bad'); } };
  bar.appendChild(clear);
  container.appendChild(bar);

  const card = el('<div class="card"></div>');
  const tbl = el('<div id="al_tbl"></div>');
  card.appendChild(tbl);
  container.appendChild(card);
  renderAlarmTable();

  fsel.onchange = () => renderAlarmTable();
  state.onValues = (updates) => { /* 报警由 onAlarm 或 refresh 处理 */ };
  state.onAlarm = () => renderAlarmTable();
  state.refresh = () => renderAlarmTable();
}

function renderAlarmTable() {
  const tbl = $('al_tbl'); if (!tbl) return;
  const filter = $('al_f') ? $('al_f').value : 'all';
  let list = state.alarms;
  if (filter === 'active') list = list.filter((a) => a.active);
  if (filter === 'acked') list = list.filter((a) => a.acked);
  if (!list.length) { tbl.innerHTML = '<div class="empty">暂无报警</div>'; return; }
  const rows = list.map((a) => {
    const lv = a.type === 'high' ? '<span class="badge high">高报</span>' : '<span class="badge low">低报</span>';
    const st = !a.active ? '<span class="badge cleared">已解除</span>' : (a.acked ? '<span class="badge ack">已确认</span>' : '<span class="badge active">活动</span>');
    const ackBtn = a.active && !a.acked ? '<button class="btn sm" data-ack="' + a.id + '">确认</button>' : '';
    return `<tr>
      <td class="nowrap">${fmtDT(a.firstAt)}</td>
      <td>${a.deviceName || '—'}</td>
      <td>${a.pointName}</td>
      <td>${lv}</td>
      <td class="num">${a.value} ${a.unit || ''}</td>
      <td class="num">阈值 ${a.threshold} ${a.unit || ''}</td>
      <td>${st}</td>
      <td>${ackBtn}</td>
    </tr>`;
  }).join('');
  tbl.innerHTML = `<table class="table"><thead><tr>
    <th>首次时间</th><th>设备</th><th>点位</th><th>类型</th><th>当前值</th><th>阈值</th><th>状态</th><th>操作</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
  tbl.querySelectorAll('[data-ack]').forEach((b) => {
    b.onclick = async () => { try { await API.ackAlarm(b.dataset.ack); const a = state.alarms.find((x) => x.id === b.dataset.ack); if (a) a.acked = true; renderAlarmTable(); } catch (e) { toast('失败：' + e.message, 'bad'); } };
  });
}

function renderAlarmList(container, list) {
  if (!container) return;
  if (!list || !list.length) { container.innerHTML = '<div class="empty">暂无报警</div>'; return; }
  container.innerHTML = '<table class="table"><thead><tr><th>时间</th><th>设备</th><th>点位</th><th>类型</th><th>值</th><th>状态</th></tr></thead><tbody>' +
    list.map((a) => `<tr>
      <td class="nowrap">${fmtDT(a.firstAt)}</td><td>${a.deviceName || '—'}</td><td>${a.pointName}</td>
      <td>${a.type === 'high' ? '<span class="badge high">高报</span>' : '<span class="badge low">低报</span>'}</td>
      <td class="num">${a.value} ${a.unit || ''}</td>
      <td>${a.active ? '<span class="badge active">活动</span>' : '<span class="badge cleared">已解除</span>'}</td>
    </tr>`).join('') + '</tbody></table>';
}

// ---------- 报表导出 ----------
function renderReport() {
  const container = $('view-report');
  container.innerHTML = '';
  const bar = el('<div class="toolbar"></div>');
  bar.appendChild(el('<div class="hint">选择点位与时间窗口，生成统计报表并导出 CSV</div>'));
  bar.appendChild(el('<div class="spacer"></div>'));
  const wsel = el('<select class="select" style="width:auto" id="rp_win"></select>');
  Object.keys(WINDOWS).forEach((k) => { wsel.appendChild(el('<option value="' + WINDOWS[k] + '">' + k + '</option>')); });
  bar.appendChild(wsel);
  const gen = el('<button class="btn primary" id="rp_gen">生成报表</button>');
  bar.appendChild(gen);
  container.appendChild(bar);

  const cl = el('<div class="checklist section-gap" id="rp_cl"></div>');
  state.points.forEach((p) => {
    if (p.dataType === 'bool') return;
    const on = state.favorites.includes(p.id);
    const item = el('<label class="check ' + (on ? 'on' : '') + '"><input type="checkbox" ' + (on ? 'checked' : '') + '> ' + p.name + '</label>');
    item.querySelector('input').onchange = (e) => {
      if (e.target.checked) { if (!state.favorites.includes(p.id)) state.favorites.push(p.id); }
      else state.favorites = state.favorites.filter((x) => x !== p.id);
      item.classList.toggle('on', e.target.checked);
    };
    cl.appendChild(item);
  });
  container.appendChild(cl);

  const card = el('<div class="card"><div class="card-title">统计报表 <span class="sub">计数 / 均值 / 最值 / 标准差</span></div></div>');
  const tbl = el('<div id="rp_tbl"><div class="empty">点击「生成报表」</div></div>');
  card.appendChild(tbl);
  const exp = el('<div class="flex section-gap"><button class="btn sm" id="rp_exp_h">⬇ 导出历史CSV(选中)</button><button class="btn sm" id="rp_exp_s">⬇ 导出实时快照CSV</button></div>');
  card.appendChild(exp);
  container.appendChild(card);

  gen.onclick = () => generateReport(Number(wsel.value), tbl);
  exp.querySelector('#rp_exp_h').onclick = () => { if (!state.favorites.length) { toast('请先选择点位', 'bad'); return; } window.location = API.exportHistory(state.favorites, Number(wsel.value)); };
  exp.querySelector('#rp_exp_s').onclick = () => { window.location = API.exportSnapshot(); };

  state.onValues = null; state.onAlarm = null; state.refresh = null;
}

async function generateReport(windowMs, tbl) {
  if (!state.favorites.length) { toast('请先选择点位', 'bad'); return; }
  try {
    const hist = await API.getHistoryBulk(state.favorites, windowMs);
    const rows = hist.map((h) => {
      const vals = h.data.map((d) => d[1]);
      if (!vals.length) return { name: h.name, unit: h.unit, count: 0, avg: '—', min: '—', max: '—', std: '—' };
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const mn = Math.min(...vals), mx = Math.max(...vals);
      const variance = vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length;
      return { name: h.name, unit: h.unit, count: vals.length, avg: avg.toFixed(2), min: mn.toFixed(2), max: mx.toFixed(2), std: Math.sqrt(variance).toFixed(2) };
    });
    tbl.innerHTML = '<table class="table"><thead><tr><th>点位</th><th>单位</th><th>采样数</th><th>均值</th><th>最小</th><th>最大</th><th>标准差</th></tr></thead><tbody>' +
      rows.map((r) => `<tr><td>${r.name}</td><td>${r.unit || ''}</td><td class="num">${r.count}</td><td class="num">${r.avg}</td><td class="num">${r.min}</td><td class="num">${r.max}</td><td class="num">${r.std}</td></tr>`).join('') + '</tbody></table>';
    toast('报表已生成', 'ok');
  } catch (e) { toast('生成失败：' + e.message, 'bad'); }
}

// ---------- 收藏点位勾选 ----------
function buildFavChecklist(onChange) {
  const wrap = el('<div class="checklist"></div>');
  state.points.filter((p) => p.dataType !== 'bool').forEach((p) => {
    const on = state.favorites.includes(p.id);
    const item = el('<label class="check ' + (on ? 'on' : '') + '"><input type="checkbox" ' + (on ? 'checked' : '') + '> ' + p.name + '</label>');
    item.querySelector('input').onchange = (e) => {
      if (e.target.checked) { if (!state.favorites.includes(p.id)) state.favorites.push(p.id); }
      else state.favorites = state.favorites.filter((x) => x !== p.id);
      item.classList.toggle('on', e.target.checked);
      if (onChange) onChange();
    };
    wrap.appendChild(item);
  });
  return wrap;
}

// ---------- 鉴权 / 启动 ----------
async function init() {
  applyTheme();
  $('themeToggle').onclick = toggleTheme;
  document.querySelectorAll('.nav-item').forEach((n) => n.onclick = () => switchView(n.dataset.view));
  setInterval(() => { $('clock').textContent = fmtDT(Date.now()).split(' ')[1]; }, 1000);
  window.addEventListener('resize', () => Charts.resizeAll());
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!localStorage.getItem('plc-theme') || localStorage.getItem('plc-theme') === 'system') applyTheme(); });

  // 登录相关
  $('loginForm').addEventListener('submit', onLoginSubmit);
  $('logoutBtn').onclick = onLogout;
  $('modeSel').onchange = onModeChange;

  const ok = await ensureAuth();
  if (!ok) { showLogin(); return; }
  await boot();
}

async function ensureAuth() {
  if (!API.token) return false;
  try { const me = await API.me(); state.user = me.user; state.config = { mode: me.mode }; return true; }
  catch (e) { API.token = ''; localStorage.removeItem('plc-token'); return false; }
}

function showLogin() { $('loginOverlay').classList.remove('hidden'); }

async function onLoginSubmit(e) {
  e.preventDefault();
  const user = $('loginUser').value.trim();
  const pass = $('loginPass').value;
  const btn = $('loginBtn'); btn.disabled = true; btn.textContent = '登录中…';
  try {
    const me = await API.login(user, pass);
    state.user = me.user; state.config = { mode: me.mode };
    $('loginOverlay').classList.add('hidden');
    $('loginErr').textContent = '';
    await boot();
  } catch (err) {
    $('loginErr').textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = '登 录';
  }
}

async function onLogout() {
  await API.logout();
  state.user = null;
  if (state.ws) { try { state.ws.close(); } catch (e) {} }
  if (state.liveTimer) clearInterval(state.liveTimer);
  if ($('userPill')) $('userPill').textContent = '';
  showLogin();
}

async function boot() {
  if (state.user && $('userPill')) $('userPill').textContent = state.user;
  try { await fetchAll(); } catch (e) { toast('加载数据失败：' + e.message, 'bad'); }
  if (state.config && state.config.mode) $('modeSel').value = state.config.mode;
  switchView('overview');
  connectWS();
  state.liveTimer = setInterval(() => { if (state.refresh) state.refresh(); }, 4000);
}

async function onModeChange() {
  const mode = $('modeSel').value;
  try {
    const r = await API.setConfig({ mode });
    state.config = r.config;
    toast(mode === 'real' ? '已切换到真实 PLC 模式' : '已切换到模拟数据模式', 'ok');
    if (r.connectors && r.connectors.length) showConnectorStatus(r.connectors);
    await fetchAll();
    if (state.view === 'devices') renderDevices();
    else renderOverview();
  } catch (e) {
    toast('切换失败：' + e.message, 'bad');
    $('modeSel').value = (state.config && state.config.mode) || 'mock';
  }
}

function showConnectorStatus(list) {
  if (!list || !list.length) { if ($('plcStatus')) $('plcStatus').textContent = ''; return; }
  const online = list.filter((c) => c.status === 'online').length;
  const off = list.filter((c) => c.status === 'offline').length;
  const miss = list.filter((c) => c.status === 'driver_missing').length;
  const parts = [];
  if (online) parts.push(online + ' 在线');
  if (off) parts.push(off + ' 离线');
  if (miss) parts.push(miss + ' 缺驱动');
  if ($('plcStatus')) $('plcStatus').textContent = 'PLC：' + (parts.join(' / ') || '初始化…');
  state.connectorStatus = {};
  list.forEach((c) => { state.connectorStatus[c.deviceId] = c; });
  if (state.view === 'devices') renderDevices();
}

document.addEventListener('DOMContentLoaded', init);
