'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const Health = require('../js/data-health.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage, makeClock } = require('./helpers.js');

function incomeTemplate(id, overrides = {}) {
  return { id, name: `Income ${id}`, earnerId: 'earner-example-1', plannedAmount: 100,
    enabled: false, archived: false, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 31 }, ...overrides };
}
function expenseTemplate(id, overrides = {}) {
  return { id, name: `Expense ${id}`, categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    plannedAmount: 50, paymentMethod: 'bank', enabled: false, archived: false,
    startDate: '2026-01-01', endDate: null, recurrence: { cadence: 'monthly', day: 15 }, ...overrides };
}
function emptyMonth() {
  return { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] };
}
function readinessBudget() {
  const data = makeV3Budget(); data.months = {};
  data.templates.income = [
    incomeTemplate('month-end'),
    incomeTemplate('twice-clamped', { recurrence: { cadence: 'twice-monthly', days: [30, 31] } }),
    incomeTemplate('weekly', { startDate: '2026-02-01', recurrence: { cadence: 'weekly', anchorDate: '2026-02-01' } }),
    incomeTemplate('enabled', { enabled: true }), incomeTemplate('archived', { archived: true }),
    incomeTemplate('future', { startDate: '2027-01-01' }), incomeTemplate('ended', { endDate: '2026-01-31' })
  ];
  data.templates.expenses = [];
  Schema.validateV3(data); return data;
}
function addManualEvidence(data, { kind, name, plannedAmount, date, actuals = [null, 0, 9], paymentMethod = 'bank' }) {
  for (const [index, monthKey] of ['2026-01', '2026-02', '2026-03'].entries()) {
    data.months[monthKey] ||= emptyMonth();
    if (kind === 'income') data.months[monthKey].paychecks.push({
      id: `p-${name}-${index}`, earnerId: 'earner-example-1', earner: name,
      plannedAmount, actualAmount: actuals[index], date: date ? `${monthKey}-${date}` : '',
      sourceTemplateId: null, occurrenceKey: null
    });
    else data.months[monthKey].expenses.push({
      id: `e-${name}-${index}`, categoryId: 'category-example-1', category: 'Home', categoryItemId: 'item-example-1',
      name, date: date ? `${monthKey}-${date}` : '', paycheckAmounts: {}, plannedAmount,
      actualAmount: actuals[index], paymentMethod, sourceTemplateId: null, occurrenceKey: null
    });
  }
}
function readyStore(data) {
  const storage = new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(data) });
  const store = createStore({ storage, now: makeClock(), uuid: () => { throw new Error('unused'); } });
  assert.equal(store.load().state, 'ready'); storage.operations.length = 0; return { store, storage };
}
function expectCode(code, fn) { assert.throws(fn, error => error instanceof StoreError && error.code === code); }

test('disabled nonarchived templates use exact civil horizon, recurrence clamps, and max-three ordering', () => {
  const data = readinessBudget(); const before = JSON.stringify(data);
  const report = Health.buildTemplateReadiness(data, '2026-02-15');
  assert.deepEqual(report.horizon, { startMonth: '2026-02', endMonth: '2026-04', monthKeys: ['2026-02', '2026-03', '2026-04'] });
  assert.deepEqual(report.disabledTemplates.map(item => item.id), ['month-end', 'twice-clamped', 'weekly', 'future', 'ended']);
  const byId = Object.fromEntries(report.disabledTemplates.map(item => [item.id, item]));
  assert.deepEqual(byId['month-end'].upcoming.dates, ['2026-02-28', '2026-03-31', '2026-04-30']);
  assert.deepEqual(byId['twice-clamped'].upcoming.dates, ['2026-02-28', '2026-02-28', '2026-03-30']);
  assert.deepEqual(byId.weekly.upcoming.dates, ['2026-02-15', '2026-02-22', '2026-03-01']);
  assert.deepEqual(byId.future.upcoming.dates, []); assert.match(byId.future.upcoming.reason, /No occurrences/);
  assert.deepEqual(byId.ended.upcoming.dates, []);
  assert.equal(Object.isFrozen(report), true); assert.equal(Object.isFrozen(report.disabledTemplates[0].schedule.recurrence), true);
  assert.equal(JSON.stringify(data), before);
  assert.deepEqual(Health.buildTemplateReadiness(data, '2026-02-15'), report);
});

test('known and blank-date exact repeated patterns produce conservative disabled drafts without actual-value influence', () => {
  const data = makeV3Budget(); data.months = {}; data.templates = { income: [], expenses: [] };
  addManualEvidence(data, { kind: 'income', name: '<Hostile & income>', plannedAmount: 123, date: '15' });
  addManualEvidence(data, { kind: 'expense', name: '<Blank & expense>', plannedAmount: 45, date: '' });
  Schema.validateV3(data);
  const report = Health.buildTemplateReadiness(data, '2026-03-20');
  assert.equal(report.suggestions.length, 2);
  const income = report.suggestions.find(item => item.kind === 'income');
  assert.equal(income.name, '<Hostile & income>'); assert.equal(income.evidence.count, 3);
  assert.deepEqual(income.evidence.monthKeys, ['2026-01', '2026-02', '2026-03']);
  assert.deepEqual(income.schedule, { known: true, recurrence: { cadence: 'monthly', day: 15 }, reason: null });
  assert.equal(income.draft.enabled, false); assert.equal(income.draft.startDate, '2026-04-01');
  assert.deepEqual(income.upcoming.dates, ['2026-04-15', '2026-05-15']);
  const expense = report.suggestions.find(item => item.kind === 'expense');
  assert.equal(expense.schedule.known, false); assert.equal(expense.schedule.recurrence, null);
  assert.match(expense.schedule.reason, /Schedule unknown/); assert.equal(expense.draft.startDate, null);
  assert.equal(expense.draft.recurrence, null); assert.deepEqual(expense.upcoming.dates, []);
});

test('exact duplicates in every template state suppress suggestions while near matches remain', () => {
  for (const state of [{ enabled: true, archived: false }, { enabled: false, archived: false }, { enabled: false, archived: true }]) {
    const data = makeV3Budget(); data.months = {}; data.templates = { income: [], expenses: [] };
    addManualEvidence(data, { kind: 'expense', name: 'Repeated', plannedAmount: 50, date: '15' });
    data.templates.expenses.push(expenseTemplate(`existing-${state.enabled}-${state.archived}`, {
      name: 'Repeated', plannedAmount: 50, ...state
    }));
    Schema.validateV3(data);
    assert.equal(Health.buildTemplateReadiness(data, '2026-03-01').suggestions.length, 0);
    data.templates.expenses[0].plannedAmount = 50.001;
    Schema.validateV3(data);
    assert.equal(Health.buildTemplateReadiness(data, '2026-03-01').suggestions.length, 1);
  }
});

test('Store wrapper validates civil date, is recovery-gated, frozen, detached, and byte-exact no-write', () => {
  const data = readinessBudget(); const { store, storage } = readyStore(data);
  const raw = storage.getItem(STORAGE_KEY); const generation = store.getStatus().generation; storage.operations.length = 0;
  const first = store.getTemplateReadiness({ referenceDate: '2026-02-15' });
  const second = store.getTemplateReadiness({ referenceDate: '2026-02-15' });
  assert.deepEqual(first, second); assert.notStrictEqual(first, second); assert.equal(Object.isFrozen(first), true);
  assert.equal(storage.getItem(STORAGE_KEY), raw); assert.equal(store.getStatus().generation, generation);
  assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  for (const invalid of [undefined, null, {}, { referenceDate: null }, { referenceDate: '2026-02-30' },
    { referenceDate: '2026-2-01' }, { referenceDate: Symbol('date') }]) {
    storage.operations.length = 0; expectCode('INVALID_REFERENCE_DATE', () => store.getTemplateReadiness(invalid));
    assert.equal(storage.operations.some(operation => operation.op === 'setItem' || operation.op === 'removeItem'), false);
  }
  const damaged = new MemoryStorage({ [STORAGE_KEY]: '{damaged' });
  const recovery = createStore({ storage: damaged, now: makeClock(), uuid: () => 'x' }); recovery.load();
  expectCode('RECOVERY_REQUIRED', () => recovery.getTemplateReadiness({ referenceDate: '2026-02-15' }));
});
