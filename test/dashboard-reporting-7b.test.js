'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function load({ zeroIncome = false } = {}) {
  const elements = new Map(); const configs = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, textContent: '', replaceChildren() {}, append() {},
      addEventListener() {}, getContext() { return {}; } });
    return elements.get(id);
  };
  class ChartStub { constructor(ctx, config) { this.config = config; configs.push(config); } destroy() {} }
  const summaries = {
    '2026-01': { totalPlannedIncome: 100, totalPlannedExpenses: 10, totalActualExpenses: 0, unresolvedExpenseCount: 0 },
    '2026-02': { totalPlannedIncome: zeroIncome ? 0 : 200, totalPlannedExpenses: 20, totalActualExpenses: 0, unresolvedExpenseCount: 0 }
  };
  if (zeroIncome) summaries['2026-01'].totalPlannedIncome = 0;
  const context = vm.createContext({
    Chart: ChartStub, console, ALLOCATION_TYPES: [{ key: 'savings', label: 'Savings' }],
    document: { getElementById: element, createElement: tag => ({ tag, textContent: '', append() {}, createTHead() {}, createTBody() {} }) },
    Store: {
      calcMonthSummary: month => summaries[month], calcCategoryTotals: () => ({ Home: { planned: 10, actual: 0, unresolvedCount: 0 } }),
      getMonth: month => ({ paychecks: [], expenses: [], allocations: month === '2026-02' ? { savings: 5 } : {} }),
      calcPaymentMethodTotals: month => month === '2026-01'
        ? { bank: 1, credit_card: 2, savings: 3, investments: 4 }
        : { bank: 5, credit_card: 6, savings: 0, investments: 8 }
    }
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), configs, element };
}

test('composition names the latest selected month with planned income and retains percentage math', () => {
  const { dashboard, configs, element } = load();
  dashboard.renderIncomePct(['2026-01', '2026-02']);
  assert.match(element('dashboard-composition-context').textContent, /^Feb 26 composition:/);
  assert.match(element('dashboard-composition-context').textContent, /planned spending and allocations as a percentage of planned income/);
  const chart = configs[0];
  assert.equal(chart.options.plugins.tooltip.callbacks.label({ raw: 20, label: 'Home' }), 'Home: $20 (10.0%)');
});

test('zero planned income names the selected month without claiming a percentage', () => {
  const { dashboard, configs, element } = load({ zeroIncome: true });
  dashboard.renderIncomePct(['2026-01', '2026-02']);
  assert.match(element('dashboard-composition-context').textContent, /^Feb 26 composition:/);
  assert.match(element('dashboard-composition-context').textContent, /no planned income was entered, so percentages are not shown/);
  assert.equal(configs[0].options.plugins.tooltip.callbacks.label({ raw: 20, label: 'Home' }),
    'Home: $20 (percentage unavailable)');
});

test('payment method chart includes all four planned schema methods in frozen order and palette', () => {
  const { dashboard, configs } = load(); dashboard.renderPaymentMethod(['2026-01', '2026-02']);
  const datasets = configs[0].data.datasets;
  assert.deepEqual(plain(datasets.map(item => item.label)), ['Bank', 'Credit Card', 'Savings', 'Investments']);
  assert.deepEqual(plain(datasets.map(item => item.data)), [[1, 5], [2, 6], [3, 0], [4, 8]]);
  assert.deepEqual(plain(datasets.map(item => item.backgroundColor)), ['#8eb7c7', '#e7bd75', '#8fc89a', '#e09a72']);
  assert.equal(configs[0].options.scales.y.stacked, true);
});

test('truthful source labels do not introduce persisted behavior or chart redesign', () => {
  assert.match(source, /Planned savings & investment allocation rate/);
  assert.match(source, /Planned expenses/); assert.match(source, /Actual expenses/);
  assert.match(source, /basis === 'planned' \? 'Planned income' : 'Actual income'/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\s*\(|setTimeout|setInterval|MutationObserver/);
});
