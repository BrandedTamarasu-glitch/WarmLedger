'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'budget.js'), 'utf8');

function loadBudgetView() {
  const context = vm.createContext({});
  vm.runInContext(`${source}\n;globalThis.ExportedView = BudgetView;`, context, { filename: 'budget.js' });
  return context.ExportedView;
}

test('budget uses canonical v3 planned and nullable actual fields without serialized aliases', () => {
  assert.match(source, /plannedAmount: updates\.plannedAmount, actualAmount: updates\.actualAmount, date/);
  assert.match(source, /plannedAmount: updates\.plannedAmount, actualAmount: updates\.actualAmount, paymentMethod/);
  assert.match(source, /input\.value === '' \? null : Number\(input\.value\)/);
  assert.match(source, /existing\.actualAmount \?\? ''/);
  assert.match(source, /field === 'actualAmount'.*value === '' \? null : Number\(value\)/s);
  assert.doesNotMatch(source, /actualAmount\s*\|\|/);
  assert.doesNotMatch(source, /plannedAmount\s*\|\|/);
  assert.doesNotMatch(source, /usesV3|schemaVersion|field-amount|\.amount\b|\.actual\b/);
});

test('v3 rendering exposes provenance, dates, allocation state, and explicit zero values', () => {
  assert.match(source, /From template/);
  assert.match(source, /Needs allocation/);
  assert.match(source, /Object\.hasOwn\(amounts, paycheck\.id\) \? amounts\[paycheck\.id\] : ''/);
  assert.match(source, /Store\.fundingDirection\(assigned - expense\.plannedAmount\) !== 0/);
  assert.doesNotMatch(source, /Math\.abs\(assigned - expense\.plannedAmount\)/);
  assert.match(source, /expense-date/);
  assert.match(source, /Actual not entered/);
  assert.match(source, /allocated to \$\{this\.getPaycheckShortLabel\(paycheck\)\}/);
  assert.match(source, /\$\{expense\.name\} actual amount/);
});

test('paycheck funding limits refresh after reallocating a bill between pay periods', () => {
  assert.match(source, /assignedElsewhere = assigned - \(amounts\[paycheck\.id\] \?\? 0\)/);
  assert.match(source, /refreshFundingLimits\(expenseId\)/);
  assert.match(source, /expense\.plannedAmount - \(assigned - current\)/);
  assert.match(source, /Reduce another paycheck’s allocation first/);
  assert.match(source, /plannedInput\.min = String\(assigned\)/);
});

test('v3 planning remains available when actual income is zero or unresolved', () => {
  const view = loadBudgetView();
  const summary = {
    totalActualIncome: 0,
    unresolvedIncomeCount: 1,
    totalPlannedIncome: 3000,
    totalPlannedExpenses: 2000,
    totalAllocated: 250,
    totalBudgeted: 2250,
    remaining: -2250
  };

  assert.deepEqual({ ...view.planningTotals(summary) }, {
    income: 3000,
    expenses: 2000,
    expenseRemaining: 1000,
    budgeted: 2250,
    remaining: 750
  });
  assert.equal(view.allocationAvailable(summary), true);
});
