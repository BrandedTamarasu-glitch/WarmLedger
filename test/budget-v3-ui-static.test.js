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
  assert.match(source, /schemaVersion >= 3/);
  assert.match(source, /plannedAmount: updates\.plannedAmount, actualAmount: updates\.actualAmount, date/);
  assert.match(source, /plannedAmount: updates\.plannedAmount, actualAmount: updates\.actualAmount, paymentMethod/);
  assert.match(source, /input\.value === '' \? null : Number\(input\.value\)/);
  assert.match(source, /existing\.actualAmount \?\? ''/);
  assert.match(source, /field === 'actualAmount'.*value === '' \? null : Number\(value\)/s);
  assert.doesNotMatch(source, /actualAmount\s*\|\|/);
  assert.doesNotMatch(source, /plannedAmount\s*\|\|/);
});

test('v3 rendering exposes provenance, dates, allocation state, and explicit zero values', () => {
  assert.match(source, /From template/);
  assert.match(source, /Needs allocation/);
  assert.match(source, /Object\.hasOwn\(amounts, paycheck\.id\) \? amounts\[paycheck\.id\] : ''/);
  assert.match(source, /Math\.abs\(assigned - expense\.plannedAmount\)/);
  assert.match(source, /expense-date/);
  assert.match(source, /Actual not entered/);
  assert.match(source, /allocated to \$\{this\.getPaycheckShortLabel\(paycheck\)\}/);
  assert.match(source, /\$\{expense\.name\} actual amount/);
});

test('allocation inputs are bounded by the remaining planned amount', () => {
  assert.match(source, /assignedElsewhere = assigned - \(amounts\[paycheck\.id\] \?\? 0\)/);
  assert.match(source, /expense\.plannedAmount - assignedElsewhere/);
  assert.match(source, /plannedInput\.min = String\(assigned\)/);
});

test('v3 planning remains available when actual income is zero or unresolved', () => {
  const view = loadBudgetView();
  const summary = {
    totalIncome: 0,
    totalActualIncome: 0,
    unresolvedIncomeCount: 1,
    totalPlannedIncome: 3000,
    totalProjected: 2000,
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

test('v2 planning continues to use the existing income and projected fields', () => {
  const view = loadBudgetView();
  const summary = { totalIncome: 900, totalProjected: 600, totalAllocated: 100, totalBudgeted: 700, remaining: 200 };

  assert.deepEqual({ ...view.planningTotals(summary) }, {
    income: 900,
    expenses: 600,
    expenseRemaining: 300,
    budgeted: 700,
    remaining: 200
  });
  assert.equal(view.allocationAvailable(summary), true);
});

test('temporary v2 browser branch remains explicit and does not add aliases to records', () => {
  assert.match(source, /Store\.addPaycheck\(this\.currentMonth, \{ earnerId, amount, date \}\)/);
  assert.match(source, /actual: 0, paymentMethod/);
  assert.doesNotMatch(source, /\{[^}]*amount:\s*[^,]+,[^}]*plannedAmount:/s);
  assert.doesNotMatch(source, /\{[^}]*actual:\s*[^,]+,[^}]*actualAmount:/s);
});
