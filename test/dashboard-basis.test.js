'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');

function load() {
  const buttons = ['planned', 'actual'].map(basis => ({
    dataset: { dashboardBasis: basis }, attributes: {}, classList: { selected: basis === 'planned', toggle(_name, value) { this.selected = value; } },
    setAttribute(name, value) { this.attributes[name] = value; }
  }));
  const months = {
    '2026-01': { expenses: [
      { paymentMethod: 'bank', actualAmount: null },
      { paymentMethod: 'credit_card', actualAmount: 0 }
    ], allocations: {} }
  };
  const context = vm.createContext({
    console, Date, Chart: function() {}, ALLOCATION_TYPES: [],
    document: {
      querySelectorAll(selector) { return selector === '[data-dashboard-basis]' ? buttons : []; },
      getElementById() { return { addEventListener() {}, value: '' }; }
    },
    Store: {
      calcCategoryTotals() { return { Home: { planned: 40, actual: 30, unresolvedCount: 1 } }; },
      calcPaymentMethodTotals(_month, basis) {
        return basis === 'planned'
          ? { bank: 40, credit_card: 10, savings: 0, investments: 0 }
          : { bank: 0, credit_card: 0, savings: 0, investments: 0 };
      },
      getMonth(month) { return months[month]; }
    }
  });
  vm.runInContext(source, context);
  return { dashboard: vm.runInContext('DashboardView', context), buttons };
}

test('basis selection is session-only, updates pressed state, and renders once', () => {
  const { dashboard, buttons } = load(); let renders = 0; dashboard.render = () => { renders++; };
  assert.equal(dashboard.applyBasis('invalid'), false); assert.equal(renders, 0);
  assert.equal(dashboard.applyBasis('actual'), true); assert.equal(dashboard.basis, 'actual'); assert.equal(renders, 1);
  assert.equal(buttons[0].attributes['aria-pressed'], 'false'); assert.equal(buttons[0].classList.selected, false);
  assert.equal(buttons[1].attributes['aria-pressed'], 'true'); assert.equal(buttons[1].classList.selected, true);
});

test('planned and actual category models preserve incomplete actuals', () => {
  const { dashboard } = load();
  assert.deepEqual([...dashboard.buildCategoryTrendModel(['2026-01'], 'planned').datasets[0].data], [40]);
  assert.deepEqual([...dashboard.buildCategoryTrendModel(['2026-01'], 'actual').datasets[0].data], [null]);
});

test('actual payment methods mark only methods with missing actuals incomplete', () => {
  const { dashboard } = load(); const model = dashboard.buildPaymentMethodModel(['2026-01'], 'actual');
  assert.deepEqual([...model.datasets[0].data], [null]);
  assert.deepEqual([...model.datasets[1].data], [0]);
  assert.match(model.table.caption, /^Actual bills/);
});
