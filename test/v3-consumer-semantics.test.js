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

  assert.equal(view.plannedIncome({ totalPlannedIncome: 0, totalIncome: 99 }), 0);
  assert.equal(view.plannedExpenses({ totalPlannedExpenses: 12, totalProjected: 99 }), 12);
  assert.equal(view.actualExpenses({ totalActualExpenses: 0, unresolvedExpenseCount: 0 }), 0);
  assert.equal(view.actualExpenses({ totalActualExpenses: 10, unresolvedExpenseCount: 1 }), null);
  assert.equal(view.categoryPlanned({ planned: 0, projected: 99 }), 0);
  assert.equal(view.categoryActual({ actual: 0, unresolvedCount: 0 }), 0);
  assert.equal(view.categoryActual({ actual: 25, unresolvedCount: 1 }), null);
  assert.equal(view.isV3CategoryTotal({ actual: 0, unresolvedCount: 0 }), true);
  assert.equal(view.isV3Summary({ totalActualExpenses: 0, unresolvedExpenseCount: 0 }), true);
  assert.equal(view.formatWholeAmount(null), '— Incomplete');
});

test('Dashboard deliberately preserves v2 actual-or-projected display behavior', () => {
  const { view } = loadView('dashboard.js', 'DashboardView');

  assert.equal(view.plannedIncome({ totalIncome: 40 }), 40);
  assert.equal(view.plannedExpenses({ totalProjected: 30 }), 30);
  assert.equal(view.actualExpenses({ totalActual: 0, totalProjected: 30 }), 30);
  assert.equal(view.actualExpenses({ totalActual: 5, totalProjected: 30 }), 5);
  assert.equal(view.categoryActual({ actual: 0, projected: 9 }), 9);
});

test('Transfers selects planned income by record shape and contains no actual fallback', () => {
  const { source, view } = loadView('transfers.js', 'TransfersView');

  assert.equal(view.plannedIncome({ plannedAmount: 0, amount: 99 }), 0);
  assert.equal(view.plannedIncome({ amount: 99 }), 99);
  assert.doesNotMatch(source, /actualAmount/);
});

test('consumer sources avoid truthiness amount fallbacks', () => {
  const dashboard = fs.readFileSync(new URL('../js/dashboard.js', `file://${__dirname}/`), 'utf8');
  const transfers = fs.readFileSync(new URL('../js/transfers.js', `file://${__dirname}/`), 'utf8');

  assert.doesNotMatch(dashboard, /\.actual\s*\|\|/);
  assert.doesNotMatch(dashboard, /totalActual\s*\|\|/);
  assert.match(dashboard, /calcPaymentMethodTotals\(mk, 'planned'\)/);
  assert.doesNotMatch(transfers, /paycheck\.amount\s*-/);
  assert.doesNotMatch(transfers, /paycheck\.amount\s*\)/);
});
