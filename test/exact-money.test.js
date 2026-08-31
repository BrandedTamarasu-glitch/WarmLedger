'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Schema = require('../js/data-schema.js');
const ExactMoney = require('../js/exact-money.js');
const { makeV3Budget } = require('./helpers.js');

function incomeTemplate(id, plannedAmount) {
  return {
    id, name: `Income ${id}`, earnerId: 'earner-example-1', plannedAmount,
    enabled: false, archived: false, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 1 }
  };
}

function expenseTemplate(id, plannedAmount) {
  return {
    id, name: `Expense ${id}`, categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    plannedAmount, paymentMethod: 'bank', enabled: false, archived: false,
    startDate: '2026-01-01', endDate: null, recurrence: { cadence: 'monthly', day: 1 }
  };
}

function exhaustiveBudget() {
  const data = makeV3Budget();
  data.templates.income.push(incomeTemplate('income-precision', 10));
  data.templates.expenses.push(expenseTemplate('expense-precision', 20));
  const month = data.months['2026-01'];
  month.paychecks[0].plannedAmount = 30;
  month.paychecks[0].actualAmount = 40;
  month.expenses[0].plannedAmount = 50;
  month.expenses[0].actualAmount = 60;
  month.expenses[0].paycheckAmounts = { 'paycheck-example-1': 7 };
  month.allocations = { savings: 80, credit_card_debt: 90, investments: 100 };
  Schema.validateV3(data);
  return data;
}

test('classifier uses canonical decimal scale for zero, exponent, maximum, and binary-noise values', () => {
  const exact = [0, -0, 1, 1.2, 1.23, 1e-2, 123e-2, 1e10, 1e12, 9.99e11];
  const sub = [0.001, 1.001, 1e-3, 1e-7, 5e-324, 0.30000000000000004, 1.2300000000000002];
  for (const value of exact) assert.equal(ExactMoney.classify(value), 'exact-cent', String(value));
  for (const value of sub) assert.equal(ExactMoney.classify(value), 'sub-cent', String(value));
  for (const value of [null, '1.00', NaN, Infinity, -Infinity, 1n, -0.01, 1e21, 1_000_000_000_000.01]) {
    assert.throws(() => ExactMoney.classify(value), TypeError);
  }
});

test('audit scans every v3 monetary family exactly and excludes null actuals', () => {
  const data = exhaustiveBudget();
  data.months['2026-01'].paychecks[0].actualAmount = null;
  data.months['2026-01'].expenses[0].actualAmount = null;
  const result = ExactMoney.audit(data);
  assert.deepEqual(result, {
    scannedValueCount: 8, exactCentValueCount: 8, subCentValueCount: 0,
    affectedMonthCount: 0, affectedTemplateCount: 0,
    groups: {
      templatePlanned: { scannedValueCount: 2, exactCentValueCount: 2, subCentValueCount: 0 },
      paycheckPlanned: { scannedValueCount: 1, exactCentValueCount: 1, subCentValueCount: 0 },
      paycheckActual: { scannedValueCount: 0, exactCentValueCount: 0, subCentValueCount: 0 },
      expensePlanned: { scannedValueCount: 1, exactCentValueCount: 1, subCentValueCount: 0 },
      expenseActual: { scannedValueCount: 0, exactCentValueCount: 0, subCentValueCount: 0 },
      paycheckFunding: { scannedValueCount: 1, exactCentValueCount: 1, subCentValueCount: 0 },
      allocations: { scannedValueCount: 3, exactCentValueCount: 3, subCentValueCount: 0 }
    }
  });
});

test('audit aggregates sub-cent families and distinct affected months/templates without details', () => {
  const data = exhaustiveBudget();
  data.templates.income[0].plannedAmount = 10.001;
  data.templates.expenses[0].plannedAmount = 20.001;
  const first = data.months['2026-01'];
  first.paychecks[0].plannedAmount = 30.001;
  first.expenses[0].actualAmount = 60.001;
  first.expenses[0].paycheckAmounts['paycheck-example-1'] = 7.001;
  first.allocations.savings = 80.001;
  const second = structuredClone(first);
  second.paychecks[0].id = 'hostile-paycheck-safe-2';
  second.paychecks[0].date = '2026-02-01';
  second.expenses[0].id = 'hostile-expense-safe-2';
  second.expenses[0].paycheckAmounts = { 'hostile-paycheck-safe-2': 0 };
  second.expenses[0].plannedAmount = 0.001;
  second.expenses[0].sourceTemplateId = null;
  second.expenses[0].occurrenceKey = null;
  data.months['2026-02'] = second;
  Schema.validateV3(data);

  const result = ExactMoney.audit(data);
  assert.equal(result.scannedValueCount, result.exactCentValueCount + result.subCentValueCount);
  assert.equal(result.scannedValueCount,
    Object.values(result.groups).reduce((sum, bucket) => sum + bucket.scannedValueCount, 0));
  assert.equal(result.subCentValueCount,
    Object.values(result.groups).reduce((sum, bucket) => sum + bucket.subCentValueCount, 0));
  assert.equal(result.affectedMonthCount, 2);
  assert.equal(result.affectedTemplateCount, 2);
  assert.equal(result.groups.templatePlanned.subCentValueCount, 2);
  assert.equal(result.groups.paycheckPlanned.subCentValueCount, 2);
  assert.equal(result.groups.expenseActual.subCentValueCount, 2);
  assert.equal(result.groups.paycheckFunding.subCentValueCount, 1);
  assert.equal(result.groups.allocations.subCentValueCount, 2);
  assert.equal(result.groups.expensePlanned.subCentValueCount, 1);
  assert.deepEqual(Object.keys(result).sort(),
    ['affectedMonthCount', 'affectedTemplateCount', 'exactCentValueCount', 'groups', 'scannedValueCount', 'subCentValueCount']);
});

test('audit is detached, deeply frozen, deterministic, and does not mutate hostile-key input', () => {
  const data = exhaustiveBudget();
  const funding = Object.create(null);
  funding['paycheck-example-1'] = 0.001;
  data.months['2026-01'].expenses[0].paycheckAmounts = funding;
  Schema.validateV3(data);
  const before = JSON.stringify(data);
  const first = ExactMoney.audit(data);
  const second = ExactMoney.audit(data);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(data), before);
  assert.equal(Object.getPrototypeOf(data.months['2026-01'].expenses[0].paycheckAmounts), null);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.groups), true);
  assert.equal(Object.values(first.groups).every(Object.isFrozen), true);
  assert.equal(JSON.stringify(first).includes('paycheck-example-1'), false);
  assert.equal(JSON.stringify(first).includes('2026-01'), false);
});

test('audit fails closed unless input is valid schema v3', () => {
  for (const input of [null, {}, { schemaVersion: 2 }, { ...exhaustiveBudget(), schemaVersion: 4 }]) {
    assert.throws(() => ExactMoney.audit(input));
  }
  const invalid = exhaustiveBudget();
  invalid.months['2026-01'].allocations.savings = Infinity;
  assert.throws(() => ExactMoney.audit(invalid));
});

test('implementation contains no floating-cent rounding or tolerance path', () => {
  const source = fs.readFileSync(require.resolve('../js/exact-money.js'), 'utf8');
  assert.doesNotMatch(source, /toFixed|Math\.(?:round|floor|ceil|trunc)|EPSILON|tolerance/i);
  assert.doesNotMatch(source, /\*\s*100|100\s*\*/);
  assert.match(source, /String\(value\)/);
  assert.match(source, /BigInt/);
});
