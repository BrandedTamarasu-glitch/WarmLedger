'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage, makeClock } = require('./helpers.js');

function ids(prefix = 'period') { let index = 0; return () => `${prefix}-${++index}`; }
function ready(budget = makeV3Budget(), storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) })) {
  const store = createStore({ storage, now: makeClock(), uuid: ids() });
  assert.equal(store.load().state, 'ready'); storage.operations.length = 0;
  return { store, storage };
}
function expectCode(expected, fn) {
  assert.throws(fn, error => error instanceof StoreError && error.code === expected);
}
function emptyMonth() {
  return { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] };
}
function recordExpense(id, paymentMethod, plannedAmount, paycheckAmounts, overrides = {}) {
  return {
    id, categoryId: 'category-example-1', category: '<Home & long hostile category>', categoryItemId: null,
    name: `Bill <${id}> & ${'long'.repeat(20)}`, date: '', paycheckAmounts, plannedAmount,
    actualAmount: null, paymentMethod, sourceTemplateId: null, occurrenceKey: null, ...overrides
  };
}
function complexBudget() {
  const budget = makeV3Budget();
  budget.settings.earners.push({ id: 'earner-example-2', name: '<Second & earner>', archived: false });
  budget.months = { '2026-06': emptyMonth() };
  const month = budget.months['2026-06'];
  month.paychecks = [
    { id: 'p1', earnerId: 'earner-example-1', earner: '<First>', plannedAmount: 100, actualAmount: null, date: '2026-06-28', sourceTemplateId: null, occurrenceKey: null },
    { id: 'p2', earnerId: 'earner-example-2', earner: '<Second & earner>', plannedAmount: 50, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'p3', earnerId: 'earner-example-1', earner: '<First>', plannedAmount: 25, actualAmount: 24, date: '2026-06-05', sourceTemplateId: null, occurrenceKey: null },
    { id: 'p4', earnerId: 'earner-example-2', earner: '<Second & earner>', plannedAmount: 10, actualAmount: null, date: '2026-06-05', sourceTemplateId: null, occurrenceKey: null }
  ];
  month.expenses = [
    recordExpense('split', 'bank', 100, { p1: 40, p2: 60 }, { date: '2026-06-30', actualAmount: 100 }),
    recordExpense('partial', 'credit_card', 50, { p2: 20 }),
    recordExpense('unfunded', 'savings', 30, {}),
    recordExpense('full-zero-key', 'investments', 25, { p3: 25, p4: 0 }, { actualAmount: 0 }),
    recordExpense('boundary', 'bank', 0.009, {}, { actualAmount: 0 })
  ];
  month.allocations = { savings: 5, credit_card_debt: 6, investments: 7 };
  Schema.validateV3(budget);
  return budget;
}

test('projects canonical paycheck order with split, partial, unfunded, zero-key, methods, actuals, and allocations', () => {
  const { store } = ready(complexBudget());
  const plan = store.getPayPeriodPlan('2026-06');
  assert.equal(plan.exists, true); assert.equal(plan.paycheckCount, 4);
  assert.deepEqual(plan.periods.map(period => [period.number, period.paycheckId, period.date]), [
    [1, 'p1', '2026-06-28'], [2, 'p2', ''], [3, 'p3', '2026-06-05'], [4, 'p4', '2026-06-05']
  ]);
  assert.deepEqual(plan.periods.map(period => period.actualIncome), [null, 0, 24, null]);
  assert.deepEqual(plan.periods.map(period => [period.assignedTotal, period.plannedRemainder, period.fundingState]), [
    [40, 60, 'remaining'], [80, -30, 'over-assigned'], [25, 0, 'balanced'], [0, 10, 'remaining']
  ]);
  assert.deepEqual(plan.periods[0].methodTotals, { bank: 40, credit_card: 0, savings: 0, investments: 0 });
  assert.deepEqual(plan.periods[1].methodTotals, { bank: 60, credit_card: 20, savings: 0, investments: 0 });
  assert.equal(plan.periods[0].bills[0].splitAcrossPaychecks, true);
  assert.equal(plan.periods[0].bills[0].fundedPaycheckCount, 2);
  assert.equal(plan.periods[0].bills[0].fundingState, 'fully-funded');
  assert.equal(plan.periods[1].bills[1].fundingState, 'partially-funded');
  assert.equal(plan.periods[3].bills.length, 0, 'an explicit zero key is not a positive assignment');
  assert.deepEqual(plan.billsNeedingFunding.map(bill => [bill.expenseId, bill.remainingToFund, bill.fundingState]), [
    ['partial', 30, 'partially-funded'], ['unfunded', 30, 'unfunded']
  ]);
  assert.deepEqual(plan.monthlyAllocations, { savings: 5, credit_card_debt: 6, investments: 7, total: 18 });
  assert.deepEqual(plan.summary.methodFundingTotals, { bank: 100, credit_card: 20, savings: 0, investments: 25 });
  assert.equal(plan.summary.plannedIncome, 185);
  assert.equal(plan.summary.actualIncomeEntered, 24);
  assert.equal(plan.summary.actualIncomeMissingCount, 2);
  assert.equal(plan.summary.actualIncomeComplete, false);
  assert.equal(plan.summary.plannedBills, 205.009);
  assert.equal(plan.summary.fundedAcrossPaychecks, 145);
  assert.equal(plan.summary.billsNeedingFundingAmount, 60);
  assert.equal(plan.summary.paycheckFundingRemainder, 40);
  assert.equal(plan.summary.overAssignedAmount, 30);
  assert.equal(plan.summary.monthlyAllocationsTotal, 18);
  assert.equal(plan.summary.plannedBalance, store.getMonthReview('2026-06').balance.plannedRemainder);
  assert.equal(plan.summary.reconciliationDifference, 0);
  for (const period of plan.periods) {
    assert.equal(period.plannedRemainder, store.calcPaycheckRemaining('2026-06', period.paycheckId));
  }
});

test('supports zero, one, two, and three paycheck months without date or earner inference', () => {
  const budget = complexBudget();
  for (const [index, count] of [0, 1, 2, 3].entries()) {
    const key = `2026-0${index + 1}`;
    budget.months[key] = emptyMonth();
    budget.months[key].paychecks = budget.months['2026-06'].paychecks.slice(0, count).map(item => ({ ...item,
      date: item.date === '' ? '' : `${key}${item.date.slice(7)}` }));
  }
  delete budget.months['2026-06']; Schema.validateV3(budget);
  const { store } = ready(budget);
  for (const [index, count] of [0, 1, 2, 3].entries()) {
    const plan = store.getPayPeriodPlan(`2026-0${index + 1}`);
    assert.equal(plan.paycheckCount, count);
    assert.deepEqual(plan.periods.map(period => period.number), Array.from({ length: count }, (_, i) => i + 1));
  }
});

test('positive, zero, and negative paycheck remainder states use signed 0.009 boundaries', () => {
  const budget = makeV3Budget(); budget.months = { '2026-07': emptyMonth() };
  budget.months['2026-07'].paychecks = [
    { id: 'positive', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 1, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'zero', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 0.009, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'negative', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 1, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null }
  ];
  budget.months['2026-07'].expenses = [recordExpense('assigned', 'bank', 1.02, { negative: 1.02 }, { category: 'Home', name: 'Assigned' })];
  Schema.validateV3(budget);
  const states = ready(budget).store.getPayPeriodPlan('2026-07').periods.map(period => period.fundingState);
  assert.deepEqual(states, ['remaining', 'balanced', 'over-assigned']);
});

test('absent and stored-empty months are distinct, frozen, detached, and invalid months fail', () => {
  const budget = makeV3Budget(); budget.months = { '2026-02': emptyMonth() };
  const { store } = ready(budget);
  const absent = store.getPayPeriodPlan('2026-03');
  const stored = store.getPayPeriodPlan('2026-02');
  assert.equal(absent.exists, false); assert.equal(stored.exists, true);
  assert.equal(absent.paycheckCount, 0); assert.deepEqual(absent.periods, []);
  assert.deepEqual(absent.monthlyAllocations, { savings: 0, credit_card_debt: 0, investments: 0, total: 0 });
  assert.equal(absent.summary.actualIncomeComplete, true);
  assert.equal(Object.isFrozen(absent), true); assert.equal(Object.isFrozen(absent.summary.methodFundingTotals), true);
  assert.notStrictEqual(absent, store.getPayPeriodPlan('2026-03'));
  expectCode('INVALID_MONTH', () => store.getPayPeriodPlan('2026-00'));
  expectCode('INVALID_MONTH', () => store.getPayPeriodPlan('2026-13'));
  expectCode('INVALID_MONTH', () => store.getPayPeriodPlan('bad'));
  for (const invalid of [undefined, null, 202606, {}, Symbol('month')]) {
    expectCode('INVALID_MONTH', () => store.getPayPeriodPlan(invalid));
  }
});

test('adversarial invalid month types are stable INVALID_MONTH failures with no writes', () => {
  const { store, storage } = ready(); const raw = storage.getItem(STORAGE_KEY);
  for (const invalid of [undefined, null, 202606, {}, Symbol('month')]) {
    storage.operations.length = 0;
    expectCode('INVALID_MONTH', () => store.getPayPeriodPlan(invalid));
    assert.equal(storage.getItem(STORAGE_KEY), raw);
    assert.equal(storage.operations.some(op => op.op === 'setItem' || op.op === 'removeItem'), false);
  }
});

test('repeated reads are byte-exact and write-free with no generation, identifier, or storage work', () => {
  let uuidCalls = 0;
  const budget = complexBudget(); const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) });
  const store = createStore({ storage, now: makeClock(), uuid: () => `unused-${++uuidCalls}` }); store.load();
  const raw = storage.getItem(STORAGE_KEY); const status = store.getStatus(); storage.operations.length = 0;
  const first = store.getPayPeriodPlan('2026-06'); const second = store.getPayPeriodPlan('2026-06');
  assert.deepEqual(first, second); assert.notStrictEqual(first, second);
  assert.equal(storage.getItem(STORAGE_KEY), raw); assert.deepEqual(store.getStatus(), status);
  assert.equal(uuidCalls, 0);
  assert.equal(storage.operations.some(op => op.op === 'setItem' || op.op === 'removeItem'), false);
  const detached = JSON.parse(JSON.stringify(first)); detached.periods[0].earner = 'changed';
  assert.notEqual(store.getPayPeriodPlan('2026-06').periods[0].earner, 'changed');
});

test('projection is cache-free after mutation, replacement import, and snapshot restore', () => {
  const { store } = ready(complexBudget());
  assert.equal(store.getPayPeriodPlan('2026-06').periods[0].plannedIncome, 100);
  store.updatePaycheck('2026-06', 'p1', { plannedAmount: 110 });
  assert.equal(store.getPayPeriodPlan('2026-06').periods[0].plannedIncome, 110);
  const replacement = store.getData(); replacement.months['2026-06'].paychecks[0].plannedAmount = 120;
  store.commitImport(store.previewImport(JSON.stringify(Schema.buildBackup(replacement, '2026-08-30T00:00:00.000Z'))));
  assert.equal(store.getPayPeriodPlan('2026-06').periods[0].plannedIncome, 120);
  const snapshot = store.listSnapshots().find(item => item.reason === 'pre-import');
  store.restoreSnapshot(snapshot.id);
  assert.equal(store.getPayPeriodPlan('2026-06').periods[0].plannedIncome, 110);
});

test('recovery-required gates the projection without writes', () => {
  const raw = '{private damaged bytes'; const storage = new MemoryStorage({ [STORAGE_KEY]: raw });
  const store = createStore({ storage, now: makeClock(), uuid: ids() }); store.load(); storage.operations.length = 0;
  expectCode('RECOVERY_REQUIRED', () => store.getPayPeriodPlan('2026-01'));
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.operations.some(op => op.op === 'setItem' || op.op === 'removeItem'), false);
});

test('shared FP-safe funding boundary treats exact decimal edges as balanced and just-over as issues', () => {
  const budget = makeV3Budget(); budget.months = { '2026-08': emptyMonth() };
  const month = budget.months['2026-08'];
  month.paychecks = [
    { id: 'positive-exact', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 100, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'positive-over', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 100, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'negative-exact', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 99.991, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'negative-over', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 99.9909, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null }
  ];
  month.expenses = [
    recordExpense('exact-bill', 'bank', 100, { 'positive-exact': 99.991 }, { category: 'Home', name: 'Exact' }),
    recordExpense('over-bill', 'bank', 100, { 'positive-over': 99.9909 }, { category: 'Home', name: 'Over' }),
    recordExpense('negative-funding', 'bank', 200, { 'negative-exact': 100, 'negative-over': 100 }, { category: 'Home', name: 'Negative' })
  ];
  Schema.validateV3(budget);
  const { store } = ready(budget);
  const plan = store.getPayPeriodPlan('2026-08');
  assert.deepEqual(plan.billsNeedingFunding.map(item => item.expenseId), ['over-bill']);
  assert.deepEqual(plan.periods.map(item => item.fundingState), ['balanced', 'remaining', 'balanced', 'over-assigned']);
  assert.deepEqual(store.getMonthReview('2026-08').funding.issues.map(item => item.expenseId), ['over-bill']);
  assert.equal(store.fundingDirection(100 - 99.991), 0);
  assert.equal(store.fundingDirection(100 - 99.9909), 1);
  assert.equal(store.fundingDirection(99.991 - 100), 0);
  assert.equal(store.fundingDirection(99.9909 - 100), -1);
});

test('every exact positive assignment is present while zero keys remain absent regardless of tolerance', () => {
  const budget = makeV3Budget(); budget.months = { '2026-09': emptyMonth() };
  const month = budget.months['2026-09'];
  month.paychecks = [
    { id: 'tiny-one', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 0.007, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'tiny-two', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 0.004, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null },
    { id: 'zero-key', earnerId: 'earner-example-1', earner: 'One', plannedAmount: 0, actualAmount: 0, date: '', sourceTemplateId: null, occurrenceKey: null }
  ];
  month.expenses = [
    recordExpense('tiny-full', 'bank', 0.005, { 'tiny-one': 0.005, 'zero-key': 0 }, { category: 'Home', name: 'Tiny full' }),
    recordExpense('tiny-split', 'credit_card', 0.006, { 'tiny-one': 0.002, 'tiny-two': 0.004 }, { category: 'Home', name: 'Tiny split' })
  ];
  Schema.validateV3(budget);
  const plan = ready(budget).store.getPayPeriodPlan('2026-09');
  assert.deepEqual(plan.periods[0].bills.map(item => item.expenseId), ['tiny-full', 'tiny-split']);
  assert.deepEqual(plan.periods[1].bills.map(item => item.expenseId), ['tiny-split']);
  assert.deepEqual(plan.periods[2].bills, []);
  const full = plan.periods[0].bills[0];
  assert.equal(full.fundedByThisPaycheck, 0.005);
  assert.equal(full.fundedPaycheckCount, 1);
  assert.equal(full.splitAcrossPaychecks, false);
  assert.equal(full.fundingState, 'fully-funded');
  const split = plan.periods[0].bills[1];
  assert.equal(split.fundedPaycheckCount, 2);
  assert.equal(split.splitAcrossPaychecks, true);
  assert.equal(split.fundingState, 'fully-funded');
  assert.deepEqual(plan.billsNeedingFunding, []);
  assert.deepEqual(plan.summary.methodFundingTotals, { bank: 0.005, credit_card: 0.006, savings: 0, investments: 0 });
  assert.equal(plan.summary.fundedAcrossPaychecks, 0.011);
  assert.equal(plan.periods.reduce((sum, period) => sum + period.assignedTotal, 0), plan.summary.fundedAcrossPaychecks);
  assert.equal(plan.summary.reconciliationDifference, 0);
});
