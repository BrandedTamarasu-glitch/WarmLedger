'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadView(file, exportName) {
  const source = fs.readFileSync(new URL(`../js/${file}`, `file://${__dirname}/`), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(`${source}\n;globalThis.ExportedView = ${exportName};`, context, { filename: file });
  return { source, view: context.ExportedView };
}

test('Dashboard uses explicit v3 planned and nullable-actual projections', () => {
  const { view } = loadView('dashboard.js', 'DashboardView');

  assert.equal(view.plannedIncome({ totalPlannedIncome: 0 }), 0);
  assert.equal(view.plannedExpenses({ totalPlannedExpenses: 12 }), 12);
  assert.equal(view.actualExpenses({ totalActualExpenses: 0, unresolvedExpenseCount: 0 }), 0);
  assert.equal(view.actualExpenses({ totalActualExpenses: 10, unresolvedExpenseCount: 1 }), null);
  assert.equal(view.categoryPlanned({ planned: 0 }), 0);
  assert.equal(view.categoryActual({ actual: 0, unresolvedCount: 0 }), 0);
  assert.equal(view.categoryActual({ actual: 25, unresolvedCount: 1 }), null);
  assert.equal(view.formatWholeAmount(null), '— Incomplete');
});

test('Transfers uses canonical planned income and contains no actual fallback', () => {
  const { source, view } = loadView('transfers.js', 'TransfersView');

  assert.equal(view.plannedIncome({ plannedAmount: 0 }), 0);
  assert.doesNotMatch(source, /actualAmount/);
});

test('consumer sources avoid truthiness amount fallbacks', () => {
  const dashboard = fs.readFileSync(new URL('../js/dashboard.js', `file://${__dirname}/`), 'utf8');
  const transfers = fs.readFileSync(new URL('../js/transfers.js', `file://${__dirname}/`), 'utf8');

  assert.doesNotMatch(dashboard, /\.actual\s*\|\|/);
  assert.doesNotMatch(dashboard, /totalActual\s*\|\|/);
  assert.doesNotMatch(dashboard, /totalIncome\b/);
  assert.doesNotMatch(dashboard, /totalProjected\b/);
  assert.doesNotMatch(dashboard, /\.projected\b/);
  assert.match(dashboard, /calcPaymentMethodTotals\(mk, basis\)/);
  assert.match(dashboard, /incompleteMethods\[index\]\.has\(method\.key\) \? null/);
  assert.doesNotMatch(transfers, /paycheck\.amount\b/);
  assert.doesNotMatch(transfers, /paycheck\.amount\s*-/);
  assert.doesNotMatch(transfers, /paycheck\.amount\s*\)/);
});
