'use strict';

/**
 * store.js — PLC 设备与采集点位的持久化存储（JSON 文件）
 *
 * 设计要点：
 *  - 设备(Device)与采集点位(Point)的配置持久化到 data/devices.json
 *  - 实时数值与历史曲线保存在内存（由 simulator 管理），重启不保留（符合模拟平台定位）
 *  - 首次运行自动注入示例设备，保证"开箱即跑通"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function uid(prefix) {
  return prefix + '_' + crypto.randomUUID().slice(0, 8);
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadDevices() {
  ensureDir();
  if (!fs.existsSync(DEVICES_FILE)) return null; // null => 需要种子
  try {
    const arr = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[store] 解析 devices.json 失败，使用空数据:', e.message);
    return [];
  }
}

function saveDevices(devices) {
  ensureDir();
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(devices, null, 2));
}

function loadConfig() {
  ensureDir();
  if (!fs.existsSync(CONFIG_FILE)) return { mode: 'mock', tickMs: 1000 };
  try {
    return Object.assign({ mode: 'mock', tickMs: 1000 }, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (e) {
    return { mode: 'mock', tickMs: 1000 };
  }
}

function saveConfig(cfg) {
  ensureDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// 协议/品牌可选值
const BRANDS = ['omron', 'siemens', 'mitsubishi', 'delta', 'other'];
const PROTOCOLS = {
  omron: ['FINS/TCP', 'FINS/UDP', 'EtherNet/IP'],
  siemens: ['S7 (ISO-TCP)', 'Profinet', 'Modbus TCP'],
  mitsubishi: ['MC Protocol', 'SLMP', 'Modbus TCP'],
  delta: ['Modbus TCP', 'Modbus RTU', 'Ethernet'],
  other: ['Modbus TCP', 'OPC UA', 'Custom']
};

function seedDevices() {
  const now = Date.now();
  const devices = [
    {
      id: uid('dev'),
      name: '欧姆龙 注塑机 #1',
      brand: 'omron',
      model: 'NX1P2-9024DT',
      ip: '192.168.1.101',
      protocol: 'FINS/TCP',
      status: 'online',
      createdAt: now,
      points: [
        mkPoint('料筒温度', 'D100', 'float', '℃', 20, 120, 60, 30, 0.03, 1.5, true, 82, 38),
        mkPoint('注射压力', 'D102', 'float', 'bar', 0, 200, 90, 45, 0.02, 3, true, 130, 20),
        mkPoint('冷却流量', 'D104', 'float', 'L/min', 0, 60, 30, 12, 0.05, 1, false, null, null),
        mkPoint('电机运行', 'CIO0.0', 'bool', '', 0, 1, 1, 0, 0, 0, false, null, null)
      ]
    },
    {
      id: uid('dev'),
      name: '西门子 空压机站',
      brand: 'siemens',
      model: 'S7-1200 1214C',
      ip: '192.168.1.102',
      protocol: 'S7 (ISO-TCP)',
      status: 'online',
      createdAt: now,
      points: [
        mkPoint('主机转速', 'DB1.DBD0', 'float', 'rpm', 0, 3000, 1500, 450, 0.02, 20, true, 1850, 1100),
        mkPoint('储气罐液位', 'MD10', 'float', '%', 0, 100, 70, 18, 0.01, 1, true, 82, 45),
        mkPoint('排气阀', 'Q0.1', 'bool', '', 0, 1, 0, 0, 0, 0, false, null, null)
      ]
    },
    {
      id: uid('dev'),
      name: '三菱 中央空调',
      brand: 'mitsubishi',
      model: 'FX5U-64MT',
      ip: '192.168.1.103',
      protocol: 'MC Protocol',
      status: 'online',
      createdAt: now,
      points: [
        mkPoint('总电流', 'D0', 'float', 'A', 0, 200, 80, 40, 0.03, 2, true, 110, 30),
        mkPoint('瞬时功率', 'D2', 'float', 'kW', 0, 120, 45, 22, 0.02, 1.5, true, 100, 20),
        mkPoint('供水温度', 'D4', 'float', '℃', 5, 40, 18, 8, 0.02, 0.5, false, null, null)
      ]
    },
    {
      id: uid('dev'),
      name: '台达 供水泵房',
      brand: 'delta',
      model: 'DVP-14SS2',
      ip: '192.168.1.104',
      protocol: 'Modbus TCP',
      status: 'online',
      createdAt: now,
      points: [
        mkPoint('管道湿度', '4x0001', 'float', '%RH', 0, 100, 55, 20, 0.01, 1, false, null, null),
        mkPoint('泵频率', '4x0002', 'float', 'Hz', 0, 50, 35, 12, 0.02, 0.8, true, 44, 18),
        mkPoint('变频故障', '0x0010', 'bool', '', 0, 1, 0, 0, 0, 0, false, null, null)
      ]
    }
  ];
  return devices;
}

function mkPoint(name, address, dataType, unit, simMin, simMax, base, amplitude, frequency, noise, alarmEnabled, alarmHigh, alarmLow) {
  return {
    id: uid('pt'),
    name, address, dataType, unit,
    simMin, simMax, base, amplitude, frequency, noise,
    alarmEnabled, alarmHigh, alarmLow
  };
}

module.exports = {
  uid,
  BRANDS,
  PROTOCOLS,
  loadDevices,
  saveDevices,
  loadConfig,
  saveConfig,
  seedDevices
};
