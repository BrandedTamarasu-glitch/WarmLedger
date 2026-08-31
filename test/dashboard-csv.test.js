'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');
const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../css/styles.css'), 'utf8');
const roadmap = fs.readFileSync(require.resolve('../ROADMAP.md'), 'utf8');

function load() {
  const downloads = []; const announcements = [];
  const month = { expenses: [
    { paymentMethod: 'bank', actualAmount: null },
    { paymentMethod: 'credit_card', actualAmount: 0 }
  ], allocations: {} };
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { id, value: '', hidden: false, focused: false,
      addEventListener() {}, replaceChildren() {}, focus() { this.focused = true; },
      classList: { toggle() {} } });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, Date, Chart: function() {}, ALLOCATION_TYPES: [],
    document: { getElementById: element, querySelectorAll() { return []; }, createElement() { return {}; } },
    App: {
      download(...args) { downloads.push(args); },
      announceStatus(message) { announcements.push(message); }
    },
    Store: {
      calcMonthSummary() { return { totalPlannedIncome: 100, totalActualIncome: 0, unresolvedIncomeCount: 1,
        totalPlannedExpenses: 50, totalActualExpenses: 0, unresolvedExpenseCount: 1 }; },
      calcCategoryTotals() { return {
        '=Formula': { planned: 40, actual: 0, unresolvedCount: 1 },
        Safe: { planned: -10, actual: 0, unresolvedCount: 0 }
      }; },
      calcPaymentMethodTotals(_key, basis) { return basis === 'planned'
        ? { bank: 40, credit_card: 10, savings: 0, investments: 0 }
        : { bank: 0, credit_card: 0, savings: 0, investments: 0 }; },
      getMonth() { return month; }
    }
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), csv: vm.runInContext('dashboardCsv', context),
    downloads, announcements, element };
}

test('CSV quoting protects text formulas and preserves numeric negatives', () => {
  const { csv } = load(); const value = csv([['Label', 'Value'], ['=SUM(1,2)', -10], ['a"b', 0]]);
  assert.equal(value.startsWith('\uFEFF'), true);
  assert.match(value, /"'=SUM\(1,2\)","-10"/);
  assert.match(value, /"a""b","0"/);
  assert.equal(value.endsWith('\r\n'), true);
});

test('actual export keeps missing totals, categories, and affected payment methods incomplete', () => {
  const { dashboard } = load(); const csv = dashboard.buildCsv(['2026-01'], 'actual');
  assert.match(csv, /"Income","","","","Incomplete"/);
  assert.match(csv, /"Category spending","'=Formula","","","Incomplete"/);
  assert.match(csv, /"Bills by payment method","","Bank","","Incomplete"/);
  assert.match(csv, /"Bills by payment method","","Credit Card","0","Complete"/);
});

test('valid export downloads selected range and basis while invalid range focuses status', () => {
  const { dashboard, downloads, announcements, element } = load();
  dashboard.getDateRange = () => ({ from: '2026-01', to: '2026-01' }); dashboard.basis = 'actual';
  assert.equal(dashboard.exportCsv(), true); assert.equal(downloads.length, 1);
  assert.equal(downloads[0][1], 'warm-ledger-dashboard-2026-01-to-2026-01-actual.csv');
  assert.equal(downloads[0][2], 'text/csv;charset=utf-8'); assert.match(announcements[0], /using actual spending/);

  dashboard.getDateRange = () => ({ from: '', to: '2026-01' }); dashboard.clearRenderedOutput = () => {};
  dashboard.renderState = () => {}; assert.equal(dashboard.exportCsv(), false);
  assert.equal(downloads.length, 1); assert.equal(element('dashboard-state').focused, true);
});

test('CSV action is local-only, touch-sized, responsive, and documented', () => {
  assert.match(html, /id="btn-dashboard-csv"[^>]*type="button">Download CSV/);
  assert.match(html, /Exports the selected range and spending basis\. Nothing is uploaded\./);
  assert.match(css, /\.dashboard-export-actions \.btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.dashboard-export-actions \.btn\s*\{[^}]*width:\s*100%/);
  assert.match(roadmap, /range- and basis-aware CSV export/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|sendBeacon/);
});
