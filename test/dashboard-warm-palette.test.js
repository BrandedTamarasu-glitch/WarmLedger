'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');
const sequence = [
  '#e09a72', '#8fc89a', '#e7bd75', '#8eb7c7',
  '#b8a1d9', '#76b7aa', '#d98fa3', '#d9a65f',
  '#a8b878', '#78a9c2', '#d78374', '#b9a58f'
];
const plain = value => JSON.parse(JSON.stringify(value));

function loadDashboard() {
  const configs = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      id, value: '', classList: { toggle() {} }, getContext: () => ({ canvasId: id }), addEventListener() {}, replaceChildren() {}, append() {}
    });
    return elements.get(id);
  };
  class ChartStub {
    constructor(context, config) { this.context = context; this.config = config; this.destroyed = false; configs.push(config); }
    destroy() { this.destroyed = true; }
  }
  const summaries = {
    '2026-01': { totalPlannedIncome: 100, totalPlannedExpenses: 40, totalActualExpenses: 35, unresolvedExpenseCount: 0 },
    '2026-02': { totalPlannedIncome: 200, totalPlannedExpenses: 80, totalActualExpenses: 0, unresolvedExpenseCount: 1 }
  };
  const categoryTotals = {
    '2026-01': { Food: { planned: 40, actual: 35, unresolvedCount: 0 } },
    '2026-02': { Food: { planned: 80, actual: 0, unresolvedCount: 1 }, Home: { planned: 20, actual: 20, unresolvedCount: 0 } }
  };
  const context = vm.createContext({
    Chart: ChartStub,
    document: {
      getElementById: element,
      createElement: tag => ({ tag, className: '', textContent: '', append() {}, createTHead() {}, createTBody() {} })
    },
    Store: {
      getAllMonthKeys: () => ['2026-01', '2026-02'],
      calcMonthSummary: month => summaries[month.replace('2025', '2026')],
      calcCategoryTotals: month => categoryTotals[month.replace('2025', '2026')],
      getMonth: month => ({ paychecks: [], expenses: [],
        allocations: month.endsWith('-01') ? { savings: 10, investments: 5 } : {} }),
      calcPaymentMethodTotals: month => month.endsWith('-01')
        ? { bank: 25, credit_card: 15, savings: 10, investments: 5 }
        : { bank: 50, credit_card: 30, savings: 0, investments: 20 }
    },
    ALLOCATION_TYPES: [{ key: 'savings', label: 'Savings' }],
    console
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), theme: vm.runInContext('DASHBOARD_THEME', context), configs };
}

test('Dashboard exposes the exact frozen Warm Ledger theme and sequence', () => {
  const { dashboard, theme } = loadDashboard();
  assert.deepEqual({ ...theme }, {
    text: '#f7f0e6', muted: '#b7aa9a', grid: '#40382d', accent: '#e09a72',
    positive: '#8fc89a', warning: '#e7bd75', danger: '#f08a80', info: '#8eb7c7'
  });
  assert.equal(Object.isFrozen(theme), true);
  assert.deepEqual([...dashboard.COLORS], sequence);
  for (const old of ['#6366f1', '#22c55e', '#ef4444', '#eab308', '#3b82f6', '#ec4899',
    '#14b8a6', '#f97316', '#8b5cf6', '#06b6d4', '#84cc16', '#e11d48', '#e4e6ef', '#8b8fa3', '#2e3347']) {
    assert.doesNotMatch(source, new RegExp(old, 'i'));
  }
});

test('chart configurations use frozen mappings without changing analytics intent', () => {
  const { dashboard, configs } = loadDashboard();
  const months = ['2026-01', '2026-02'];
  dashboard.renderCategoryTrend(months);
  dashboard.renderIncomePct(months);
  dashboard.renderProjVsActual(months);
  dashboard.renderSavingsRate(months);
  dashboard.renderPaymentMethod(months);
  dashboard.renderYoY(['2025-01', '2025-02', '2026-01', '2026-02']);

  const [trend, doughnut, projected, savings, payment, yoy] = configs;
  assert.equal(trend.type, 'line');
  assert.deepEqual(plain(trend.data.datasets.map(item => item.label)), ['Food', 'Home']);
  assert.deepEqual(plain(trend.data.datasets[0].data), [35, null]);
  assert.deepEqual(plain(trend.data.datasets.map(item => item.borderColor)), sequence.slice(0, 2));
  assert.equal(trend.data.datasets[0].backgroundColor, '#e09a7233');
  assert.equal(trend.data.datasets[0].tension, 0.3); assert.equal(trend.data.datasets[0].fill, false);

  assert.equal(doughnut.type, 'doughnut'); assert.deepEqual(plain(doughnut.data.datasets[0].backgroundColor), sequence.slice(0, 2));
  assert.equal(doughnut.data.datasets[0].borderWidth, 0);
  assert.equal(doughnut.options.plugins.tooltip.callbacks.label({ raw: 20, label: 'Home' }), 'Home: $20 (10.0%)');

  assert.equal(projected.type, 'bar');
  assert.deepEqual(plain(projected.data.datasets.map(item => item.label)), ['Planned expenses', 'Actual expenses']);
  assert.deepEqual(plain(projected.data.datasets.map(item => item.backgroundColor)), ['#e09a72', '#8fc89a']);
  assert.deepEqual(plain(projected.data.datasets[1].data), [35, null]);

  assert.equal(savings.type, 'line'); assert.equal(savings.data.datasets[0].borderColor, '#8fc89a');
  assert.equal(savings.data.datasets[0].backgroundColor, '#8fc89a33');
  assert.equal(savings.data.datasets[0].tension, 0.3); assert.equal(savings.data.datasets[0].fill, true);

  assert.equal(payment.type, 'bar');
  assert.deepEqual(plain(payment.data.datasets.map(item => item.label)), ['Bank', 'Credit Card', 'Savings', 'Investments']);
  assert.deepEqual(plain(payment.data.datasets.map(item => item.data)), [[25, 50], [15, 30], [10, 0], [5, 20]]);
  assert.deepEqual(plain(payment.data.datasets.map(item => item.backgroundColor)), ['#8eb7c7', '#e7bd75', '#8fc89a', '#e09a72']);
  assert.equal(payment.options.scales.y.stacked, true);
  assert.equal(yoy.type, 'bar'); assert.equal(yoy.data.datasets[0].backgroundColor, sequence[0]);

  for (const config of [trend, projected, savings, payment, yoy]) {
    assert.equal(config.options.scales.x.ticks.color, '#b7aa9a');
    assert.equal(config.options.scales.x.grid.color, '#40382d');
    assert.equal(config.options.scales.y.ticks.color, '#b7aa9a');
    assert.equal(config.options.scales.y.grid.color, '#40382d');
  }
  for (const config of [trend, doughnut, projected, payment, yoy]) {
    assert.equal(config.options.plugins.legend.labels.color, '#f7f0e6');
  }
});

test('palette wave preserves render and destruction lifecycle boundaries', () => {
  const { dashboard } = loadDashboard();
  dashboard.renderForecast = () => {};
  const calls = [];
  for (const method of ['renderCategoryTrend', 'renderIncomePct', 'renderProjVsActual', 'renderSavingsRate',
    'renderPaymentMethod', 'renderYoY', 'renderSummaryTable']) dashboard[method] = months => calls.push([method, months]);
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-01' }); dashboard.render();
  assert.deepEqual(calls.map(call => call[0]), ['renderCategoryTrend', 'renderIncomePct', 'renderProjVsActual',
    'renderSavingsRate', 'renderPaymentMethod', 'renderYoY', 'renderSummaryTable']);
  assert.ok(calls.every(call => call[1][0] === '2026-01'));

  let destroyed = 0;
  dashboard.charts = { first: { destroy() { destroyed += 1; } }, second: { destroy() { destroyed += 1; } } };
  dashboard.destroyAllCharts(); assert.equal(destroyed, 2);
  assert.equal(dashboard.charts.first, null); assert.equal(dashboard.charts.second, null);

  assert.equal((source.match(/addEventListener\s*\(/g) || []).length, 12,
    'existing Dashboard listeners plus saved-record finder and review-navigation actions');
  assert.doesNotMatch(source, /MutationObserver|ResizeObserver|localStorage|sessionStorage|fetch\s*\(|XMLHttpRequest|WebSocket|setTimeout|setInterval/);
});
