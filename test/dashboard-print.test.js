'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../css/styles.css'), 'utf8');
const readme = fs.readFileSync(require.resolve('../README.md'), 'utf8');

function load() {
  const elements = new Map(); let prints = 0;
  const month = { paychecks: [{ plannedAmount: 1, actualAmount: 1 }], expenses: [], allocations: {} };
  const Store = { getAllMonthKeys() { return ['2026-01']; }, getMonth() { return month; } };
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', hidden: id === 'dashboard-results', focused: false,
      textContent: '', addEventListener() {}, replaceChildren() {}, focus() { this.focused = true; },
      classList: { toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, Date, Chart: function() {}, ALLOCATION_TYPES: [], print() { prints++; },
    document: { getElementById: element, querySelectorAll() { return []; }, createElement() { return {}; } },
    Store, App: {}
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), element, getPrints: () => prints };
}

test('print validates the range, requires rendered results, and invokes print once', () => {
  const { dashboard, element, getPrints } = load();
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-02' });
  dashboard.render = () => { element('dashboard-results').hidden = false; };
  assert.equal(dashboard.printReport(), true); assert.equal(getPrints(), 1);

  dashboard.getDateRange = () => ({ from: '', to: '2026-02' });
  dashboard.clearRenderedOutput = () => {}; dashboard.renderState = () => {};
  assert.equal(dashboard.printReport(), false); assert.equal(getPrints(), 1);
  assert.equal(element('dashboard-state').focused, true);
});

test('print context is updated from the validated range and selected basis', () => {
  const { dashboard, element } = load();
  dashboard.clearRenderedOutput = () => {}; dashboard.renderState = () => {}; dashboard.renderOverview = () => {};
  dashboard.renderForecast = () => {};
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-02' }); dashboard.basis = 'actual';
  dashboard.renderCategoryTrend = dashboard.renderIncomePct = dashboard.renderProjVsActual = () => {};
  dashboard.renderSavingsRate = dashboard.renderPaymentMethod = dashboard.renderYoY = dashboard.renderSummaryTable = () => {};
  dashboard.render();
  assert.equal(element('dashboard-results').hidden, false);
  assert.equal(element('dashboard-print-context').textContent,
    'Reporting range: 2026-01 to 2026-02. Spending basis: Actual.');
});

test('print UI and paper stylesheet expose tables while hiding controls and charts', () => {
  assert.match(html, /id="btn-dashboard-print"[^>]*>Print report/);
  assert.match(html, /id="dashboard-print-context" class="dashboard-print-context"/);
  const printCss = css.slice(css.indexOf('@media print'));
  assert.match(printCss, /\.dashboard-controls[\s\S]*display:\s*none !important/);
  assert.match(printCss, /\.dash-card canvas\s*\{[^}]*display:\s*none !important/);
  assert.match(printCss, /\.dashboard-table-disclosure[\s\S]*display:\s*block !important/);
  assert.match(printCss, /background:\s*#fff/);
  assert.match(readme, /Printable dashboard reports use the same validated range and spending basis/);
});
