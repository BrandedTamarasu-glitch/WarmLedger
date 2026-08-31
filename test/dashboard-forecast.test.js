'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../css/styles.css'), 'utf8');

function load() {
  const downloads = []; const announcements = [];
  const stored = {
    '2027-01': { allocations: { savings: 10, credit_card_debt: 5, investments: 0 } },
    '2027-03': { allocations: {} }
  };
  const Store = {
    getAllMonthKeys() { return Object.keys(stored); }, getMonth(key) { return stored[key] || { allocations: {} }; },
    calcMonthSummary(key) { return key === '2027-01'
      ? { totalPlannedIncome: 100, totalPlannedExpenses: 60, totalAllocated: 15 }
      : { totalPlannedIncome: 0, totalPlannedExpenses: 0, totalAllocated: 0 }; }
  };
  const context = vm.createContext({ console, Date, Store, Chart: function() {}, ALLOCATION_TYPES: [],
    document: { getElementById() { return { addEventListener() {} }; }, querySelectorAll() { return []; } },
    App: { download(...args) { downloads.push(args); }, announceStatus(value) { announcements.push(value); } } });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context),
    forecastMonths: vm.runInContext('dashboardForecastMonths', context), downloads, announcements };
}

test('forecast civil months start next month and cross year boundaries deterministically', () => {
  const { forecastMonths } = load();
  assert.deepEqual([...forecastMonths(3, { year: 2026, month: 12 })], ['2027-01', '2027-02', '2027-03']);
  assert.equal(forecastMonths(5, { year: 2026, month: 1 }), null);
  assert.equal(forecastMonths(3, { year: 9999, month: 12 }), null);
  assert.equal(Object.isFrozen(forecastMonths(6, { year: 2026, month: 1 })), true);
});

test('saved-month forecast never estimates gaps and computes non-cumulative planned remainder', () => {
  const { dashboard } = load();
  const model = dashboard.buildForecastModel(['2027-01', '2027-02', '2027-03']);
  assert.equal(model.savedCount, 2);
  assert.deepEqual({ ...model.rows[0] }, { month: '2027-01', saved: true, income: 100, expenses: 60, allocations: 15, remainder: 25 });
  assert.deepEqual({ ...model.rows[1] }, { month: '2027-02', saved: false, income: null, expenses: null, allocations: null, remainder: null });
  assert.deepEqual({ ...model.rows[2] }, { month: '2027-03', saved: true, income: 0, expenses: 0, allocations: 0, remainder: 0 });
});

test('forecast CSV preserves saved versus absent sources and uses planned values only', () => {
  const { dashboard, downloads, announcements } = load();
  dashboard.getForecastMonths = () => Object.freeze(['2027-01', '2027-02', '2027-03']);
  assert.equal(dashboard.exportForecastCsv(), true); assert.equal(downloads.length, 1);
  assert.equal(downloads[0][1], 'warm-ledger-forecast-2027-01-to-2027-03.csv');
  assert.match(downloads[0][0], /"2027-01","Saved month plan","100","60","15","25"/);
  assert.match(downloads[0][0], /"2027-02","No saved plan","","","",""/);
  assert.match(announcements[0], /Planned forecast CSV downloaded/);
});

test('forecast UI is explicitly saved-only, accessible, responsive, and print-safe', () => {
  assert.match(html, /id="dashboard-forecast-heading">Planned forecast/);
  assert.match(html, /Saved future months only/);
  assert.deepEqual([...html.matchAll(/data-dashboard-forecast-horizon="(3|6|12)"/g)].map(match => match[1]), ['3', '6', '12']);
  assert.match(html, /id="table-dashboard-forecast"[^>]*role="region"[^>]*aria-labelledby="dashboard-forecast-heading"/);
  assert.match(css, /\.dashboard-forecast-controls \.btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.dashboard-forecast-header\s*\{[^}]*flex-direction:\s*column/);
  assert.match(css.slice(css.indexOf('@media print')), /\.dashboard-forecast-controls[\s\S]*display:\s*none !important/);
  assert.doesNotMatch(source, /generateRecurring|applyRecurring|ensureMonth/);
});
