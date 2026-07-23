'use strict';

/**
 * charts.js — ECharts 图表封装（实时刷新友好，支持明暗主题）
 */
const Charts = (() => {
  const PALETTE = ['#4f46e5', '#06b6d4', '#ef4444', '#f59e0b', '#8b5cf6', '#10b981', '#ec4899', '#3b82f6'];
  const registry = new Map(); // id -> echarts instance

  function themeColors() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      dark,
      text: dark ? '#e5e9f2' : '#1f2937',
      soft: dark ? '#93a0bd' : '#64748b',
      axis: dark ? '#2b3650' : '#e6e9f2',
      split: dark ? 'rgba(255,255,255,.06)' : 'rgba(0,0,0,.05)',
      tooltipBg: dark ? '#131a2e' : '#ffffff',
      palette: PALETTE
    };
  }

  function make(id, el) {
    const inst = echarts.init(el, null, { renderer: 'canvas' });
    registry.set(id, inst);
    return inst;
  }
  function get(id) { return registry.get(id); }
  function resizeAll() { for (const inst of registry.values()) inst.resize(); }
  function dispose(id) { const i = registry.get(id); if (i) { i.dispose(); registry.delete(id); } }
  function disposeAll() { for (const id of [...registry.keys()]) dispose(id); }

  function baseGrid() { return { left: 48, right: 18, top: 28, bottom: 36 }; }

  function lineOption(series, opts) {
    opts = opts || {};
    const c = themeColors();
    return {
      color: c.palette,
      grid: opts.grid || baseGrid(),
      tooltip: {
        trigger: 'axis',
        backgroundColor: c.tooltipBg,
        borderColor: c.axis, textStyle: { color: c.text, fontSize: 12 },
        axisPointer: { type: 'cross', label: { backgroundColor: c.soft } }
      },
      legend: opts.legend === false ? undefined : {
        top: 0, textStyle: { color: c.soft, fontSize: 11 }, type: 'scroll',
        data: series.map((s) => s.name)
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: c.axis } },
        axisLabel: { color: c.soft, fontSize: 11, hideOverlap: true },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        name: opts.yName || '',
        nameTextStyle: { color: c.soft, fontSize: 11 },
        axisLine: { show: false },
        axisLabel: { color: c.soft, fontSize: 11 },
        splitLine: { lineStyle: { color: c.split } }
      },
      series: series.map((s) => ({
        name: s.name,
        type: 'line',
        showSymbol: false,
        smooth: true,
        lineStyle: { width: 2 },
        data: s.data,
        markLine: s.markLine
      }))
    };
  }

  function gaugeOption(value, min, max, unit, color, name) {
    const c = themeColors();
    const val = Number(value) || 0;
    return {
      backgroundColor: 'transparent',
      series: [{
        type: 'gauge',
        min, max,
        radius: '82%',
        center: ['50%', '55%'],
        startAngle: 210, endAngle: -30,
        progress: { show: true, width: 10, itemStyle: { color: color || c.palette[0] } },
        axisLine: { lineStyle: { width: 10, color: [[1, c.split]] } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { color: c.axis, width: 1 } },
        axisLabel: { color: c.soft, fontSize: 9, distance: 16 },
        pointer: { width: 4, length: '56%', itemStyle: { color: color || c.palette[0] } },
        anchor: { show: true, size: 7, itemStyle: { color: c.soft } },
        title: {
          show: !!name,
          offsetCenter: [0, '92%'],
          color: c.soft,
          fontSize: 11,
          overflow: 'truncate',
          width: 90
        },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '36%'],
          fontSize: 18, fontWeight: 'bolder',
          color: c.text,
          lineHeight: 22,
          formatter: (v) => v.toFixed(1) + '\n' + (unit || '')
        },
        data: [{ value: val, name: name || '' }]
      }]
    };
  }

  function sparkOption(data, color) {
    const c = themeColors();
    return {
      grid: { left: 0, right: 0, top: 4, bottom: 0 },
      xAxis: { type: 'time', show: false },
      yAxis: { type: 'value', show: false, scale: true },
      tooltip: { show: false },
      series: [{
        type: 'line', data, showSymbol: false, smooth: true,
        lineStyle: { width: 2, color: color || c.palette[0] },
        areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: (color || c.palette[0]) + '55' },
          { offset: 1, color: (color || c.palette[0]) + '00' }
        ]) }
      }]
    };
  }

  return { make, get, resizeAll, dispose, disposeAll, lineOption, gaugeOption, sparkOption, themeColors, PALETTE };
})();
