'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'dashboard.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

class NodeStub {
  constructor(tag = 'div', id = '') { this.tag = tag; this.id = id; this.children = []; this.textContent = ''; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  insertRow() { const row = new NodeStub('tr'); this.children.push(row); return row; }
  insertCell() { const cell = new NodeStub('td'); this.children.push(cell); return cell; }
  createTHead() { const head = new NodeStub('thead'); this.children.push(head); return head; }
  createTBody() { const body = new NodeStub('tbody'); this.children.push(body); return body; }
  getContext() { return {}; }
}

function load() {
  const elements = new Map(); const configs = [];
  const element = id => { if (!elements.has(id)) elements.set(id, new NodeStub('div', id)); return elements.get(id); };
  const summaries = {
    '2025-01': { totalPlannedIncome: 100, totalPlannedExpenses: 40, totalActualExpenses: 0, unresolvedExpenseCount: 1 },
    '2025-02': { totalPlannedIncome: 0, totalPlannedExpenses: 20, totalActualExpenses: 0, unresolvedExpenseCount: 0 },
    '2026-01': { totalPlannedIncome: 200, totalPlannedExpenses: 50, totalActualExpenses: 50, unresolvedExpenseCount: 0 },
    '2026-02': { totalPlannedIncome: 0, totalPlannedExpenses: 0, totalActualExpenses: 0, unresolvedExpenseCount: 0 }
  };
  const hostile = '<Food & "rent">';
  const category = {
    '2025-01': { [hostile]: { planned: 40, actual: 0, unresolvedCount: 1 } },
    '2025-02': { [hostile]: { planned: 20, actual: 0, unresolvedCount: 0 } },
    '2026-01': { [hostile]: { planned: 50, actual: 50, unresolvedCount: 0 } },
    '2026-02': { [hostile]: { planned: 0, actual: 0, unresolvedCount: 0 } }
  };
  class ChartStub { constructor(context, config) { this.config = config; this.destroyed = false; configs.push(config); } destroy() { this.destroyed = true; } }
  const context = vm.createContext({
    Chart: ChartStub, console, ALLOCATION_TYPES: [{ key: 'savings', label: 'Savings' }, { key: 'investments', label: 'Investments' }],
    document: { getElementById: element, createElement: tag => new NodeStub(tag) },
    Store: {
      calcMonthSummary: month => summaries[month], calcCategoryTotals: month => category[month],
      getMonth: month => ({ allocations: month.endsWith('-02') ? { savings: 5, investments: 0 } : { savings: 0, investments: 0 } }),
      calcPaymentMethodTotals: month => ({ bank: month.endsWith('-01') ? 1 : 0, credit_card: 2, savings: 0, investments: 4 })
    }
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), configs, element, hostile };
}

function tableParts(container) {
  const table = container.children[0];
  return { table, caption: table.children[0], head: table.children[1], body: table.children[2] };
}

test('safe table renderer creates caption, scoped headers, row headers, and inert hostile text', () => {
  const { dashboard, element, hostile } = load();
  dashboard.renderDataTable('table-category-trend', { caption: '<Caption &>', columns: ['Month', 'Category'],
    rows: [{ header: 'Jan 25', cells: [hostile] }] });
  const { caption, head, body } = tableParts(element('table-category-trend'));
  assert.equal(caption.textContent, '<Caption &>');
  assert.deepEqual(head.children[0].children.map(cell => cell.scope), ['col', 'col']);
  assert.equal(body.children[0].children[0].scope, 'row');
  assert.equal(body.children[0].children[1].textContent, hostile);
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('category and planned-vs-actual charts and tables consume the same model values including null and zero', () => {
  const { dashboard, configs, element, hostile } = load(); const months = ['2025-01', '2025-02'];
  const categoryModel = dashboard.buildCategoryTrendModel(months); dashboard.renderCategoryTrend(months);
  assert.deepEqual(plain(configs[0].data.labels), plain(categoryModel.labels));
  assert.deepEqual(plain(configs[0].data.datasets.map(item => item.data)), plain(categoryModel.datasets.map(item => item.data)));
  const categoryRows = tableParts(element('table-category-trend')).body.children;
  assert.equal(categoryRows[0].children[1].textContent, hostile);
  assert.equal(categoryRows[0].children[2].textContent, '— Incomplete');
  assert.equal(categoryRows[1].children[2].textContent, '$0');

  const projectedModel = dashboard.buildProjectedActualModel(months); dashboard.renderProjVsActual(months);
  assert.deepEqual(plain(configs[1].data.datasets[0].data), plain(projectedModel.planned));
  assert.deepEqual(plain(configs[1].data.datasets[1].data), plain(projectedModel.actual));
  const projectedRows = tableParts(element('table-proj-vs-actual')).body.children;
  assert.equal(projectedRows[0].children[1].textContent, '$40');
  assert.equal(projectedRows[0].children[2].textContent, '— Incomplete');
  assert.equal(projectedRows[1].children[2].textContent, '$0');
});

test('composition, savings, and four-method tables preserve chart data and mark zero-income rates unavailable', () => {
  const { dashboard, configs, element } = load();
  dashboard.renderIncomePct(['2025-02']);
  const composition = tableParts(element('table-income-pct'));
  assert.match(composition.caption.textContent, /Feb 25/);
  assert.ok(composition.body.children.every(row => row.children[2].textContent === 'Unavailable'));
  assert.deepEqual(plain(configs[0].data.datasets[0].data), [20, 5]);

  dashboard.renderSavingsRate(['2025-01', '2025-02']);
  assert.deepEqual(plain(configs[1].data.datasets[0].data), [0, 0]);
  const savingsRows = tableParts(element('table-savings-rate')).body.children;
  assert.equal(savingsRows[0].children[3].textContent, '0.0%');
  assert.equal(savingsRows[1].children[3].textContent, 'Unavailable');

  dashboard.renderPaymentMethod(['2025-01', '2025-02']);
  const paymentModel = dashboard.buildPaymentMethodModel(['2025-01', '2025-02']);
  assert.deepEqual(plain(configs[2].data.datasets.map(item => item.data)), plain(paymentModel.datasets.map(item => item.data)));
  assert.deepEqual(tableParts(element('table-payment-method')).head.children[0].children.map(cell => cell.textContent),
    ['Month', 'Bank', 'Credit Card', 'Savings', 'Investments']);
});

test('year comparison requires two years with identical non-empty month-number sequences', () => {
  const { dashboard, configs, element } = load();
  const eligibleMonths = ['2025-01', '2025-02', '2026-01', '2026-02'];
  const model = dashboard.buildYoYModel(eligibleMonths); assert.equal(model.eligible, true);
  dashboard.renderYoY(eligibleMonths);
  assert.equal(element('dashboard-yoy-card').hidden, false); assert.equal(element('dashboard-yoy-state').hidden, true);
  assert.deepEqual(plain(configs[0].data.labels), plain(model.labels));
  assert.deepEqual(plain(configs[0].data.datasets.map(item => item.data)), plain(model.datasets.map(item => item.data)));
  assert.ok(element('table-yoy').children.length > 0);

  const old = dashboard.charts.yoy; element('table-yoy').children = ['stale'];
  dashboard.renderYoY(['2025-02', '2026-01', '2026-02']);
  assert.equal(old.destroyed, true); assert.equal(dashboard.charts.yoy, null);
  assert.equal(element('dashboard-yoy-card').hidden, true); assert.equal(element('dashboard-yoy-state').hidden, false);
  assert.match(element('dashboard-yoy-state').textContent, /same calendar months/);
  assert.deepEqual(element('table-yoy').children, []);
  assert.equal(dashboard.buildYoYModel(['2025-01', '2025-02']).eligible, false);
});

test('global clear removes all six tables and year state before every subsequent outcome', () => {
  const { dashboard, element } = load();
  for (const id of ['table-category-trend', 'table-proj-vs-actual', 'table-payment-method',
    'table-income-pct', 'table-savings-rate', 'table-yoy']) element(id).children = ['stale'];
  element('dashboard-yoy-state').textContent = 'stale'; element('dashboard-yoy-state').hidden = false;
  element('dashboard-yoy-card').hidden = false; dashboard.clearRenderedOutput();
  for (const id of ['table-category-trend', 'table-proj-vs-actual', 'table-payment-method',
    'table-income-pct', 'table-savings-rate', 'table-yoy']) assert.deepEqual(element(id).children, []);
  assert.equal(element('dashboard-yoy-state').textContent, ''); assert.equal(element('dashboard-yoy-state').hidden, true);
  assert.equal(element('dashboard-yoy-card').hidden, true);
});
