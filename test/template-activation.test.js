'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const { STORAGE_KEY, StoreError, createStore } = require('../js/data.js');
const { makeV3Budget, MemoryStorage, makeClock } = require('./helpers.js');

function income(id, overrides = {}) {
  return {
    id, name: `Income ${id}`, earnerId: 'earner-example-1', plannedAmount: 100,
    enabled: false, archived: false, startDate: '2026-01-01', endDate: null,
    recurrence: { cadence: 'monthly', day: 15 }, ...overrides
  };
}

function expense(id, overrides = {}) {
  return {
    id, name: `Expense ${id}`, categoryId: 'category-example-1', categoryItemId: 'item-example-1',
    plannedAmount: 40, paymentMethod: 'bank', enabled: false, archived: false,
    startDate: '2026-01-01', endDate: null, recurrence: { cadence: 'monthly', day: 20 }, ...overrides
  };
}

function fixture() {
  const budget = makeV3Budget();
  budget.months = {};
  budget.templates = {
    income: [income('income-disabled'), income('income-active', { enabled: true })],
    expenses: [expense('expense-disabled'), expense('expense-future', { startDate: '2027-01-01' })]
  };
  Schema.validateV3(budget);
  return budget;
}

function ready(budget = fixture(), { storage, uuid } = {}) {
  storage ||= new MemoryStorage({ [STORAGE_KEY]: JSON.stringify(budget) });
  uuid ||= () => { throw new Error('activation must not request an identifier'); };
  const store = createStore({ storage, now: makeClock(), uuid });
  assert.equal(store.load().state, 'ready');
  storage.operations.length = 0;
  return { store, storage };
}

function code(expected, action) {
  assert.throws(action, error => error instanceof StoreError && error.code === expected);
}

test('activation preview is selected-only, frozen, detached, and byte-exact read-only', () => {
  const { store, storage } = ready();
  const before = storage.getItem(STORAGE_KEY);
  storage.operations.length = 0;
  const preview = store.previewTemplateActivation({
    targetMonth: '2026-02',
    selections: [
      { kind: 'income', templateId: 'income-disabled' },
      { kind: 'expense', templateId: 'expense-future' }
    ]
  });
  assert.equal(Object.isFrozen(preview), true);
  assert.equal(Object.isFrozen(preview.selected), true);
  assert.deepEqual(preview.counts, { selected: 2, additions: 1, skips: 1, conflicts: 0 });
  assert.deepEqual(preview.additions.income.map(item => item.templateId), ['income-disabled']);
  assert.deepEqual(preview.additions.expenses, []);
  assert.deepEqual(preview.skips.map(item => [item.templateId, item.reason]), [['expense-future', 'out-of-range']]);
  assert.equal(preview.additions.income.some(item => item.templateId === 'income-active'), false);
  assert.equal(storage.operations.some(item => item.op === 'setItem' || item.op === 'removeItem'), false);
  assert.equal(storage.getItem(STORAGE_KEY), before);
  assert.deepEqual(store.getAllMonthKeys(), []);
});

test('activation apply enables exactly selected templates in one write and never generates budget data', () => {
  const { store, storage } = ready();
  const before = store.getData();
  const preview = store.previewTemplateActivation({ targetMonth: '2026-02', selections: [
    { kind: 'income', templateId: 'income-disabled' },
    { kind: 'expense', templateId: 'expense-disabled' }
  ] });
  storage.operations.length = 0;
  assert.deepEqual(store.applyTemplateActivationPreview(preview), { enabledIncome: 1, enabledExpenses: 1 });
  const after = store.getData();
  const normalized = structuredClone(after);
  normalized.templates.income.find(item => item.id === 'income-disabled').enabled = false;
  normalized.templates.expenses.find(item => item.id === 'expense-disabled').enabled = false;
  assert.deepEqual(normalized, before);
  assert.deepEqual(Object.keys(after.months), []);
  assert.equal(storage.operations.filter(item => item.op === 'setItem' && item.key === STORAGE_KEY).length, 1);
  assert.equal(storage.operations.some(item => item.op === 'removeItem' && item.key !== 'zeroBudget_write_lock'), false);
  code('INVALID_TEMPLATE_ACTIVATION_PREVIEW', () => store.applyTemplateActivationPreview(preview));

  const recurring = store.previewRecurringMonth('2026-02');
  assert.equal(recurring.counts.additions, 3);
  assert.deepEqual(store.getAllMonthKeys(), []);
});

test('activation requests reject malformed, duplicate, missing, enabled, and archived selections without writes', () => {
  const budget = fixture();
  budget.templates.expenses.push(expense('expense-archived', { archived: true }));
  const { store, storage } = ready(budget);
  const cases = [
    ['INVALID_TEMPLATE_ACTIVATION_REQUEST', null],
    ['INVALID_TEMPLATE_ACTIVATION_REQUEST', { targetMonth: '2026-02', selections: [] }],
    ['INVALID_TEMPLATE_ACTIVATION_REQUEST', { targetMonth: '2026-02', selections: [{ kind: 'expenses', templateId: 'expense-disabled' }] }],
    ['INVALID_TEMPLATE_ACTIVATION_REQUEST', { targetMonth: '2026-02', selections: [{ kind: 'income', templateId: 'income-disabled', extra: true }] }],
    ['DUPLICATE_TEMPLATE_ACTIVATION_SELECTION', { targetMonth: '2026-02', selections: [{ kind: 'income', templateId: 'income-disabled' }, { kind: 'income', templateId: 'income-disabled' }] }],
    ['INCOME_TEMPLATE_NOT_FOUND', { targetMonth: '2026-02', selections: [{ kind: 'income', templateId: 'missing' }] }],
    ['TEMPLATE_ALREADY_ENABLED', { targetMonth: '2026-02', selections: [{ kind: 'income', templateId: 'income-active' }] }],
    ['TEMPLATE_ARCHIVED', { targetMonth: '2026-02', selections: [{ kind: 'expense', templateId: 'expense-archived' }] }],
    ['INVALID_MONTH', { targetMonth: '2026-13', selections: [{ kind: 'income', templateId: 'income-disabled' }] }]
  ];
  const raw = storage.getItem(STORAGE_KEY);
  storage.operations.length = 0;
  for (const [expected, request] of cases) code(expected, () => store.previewTemplateActivation(request));
  assert.equal(storage.getItem(STORAGE_KEY), raw);
  assert.equal(storage.operations.some(item => item.op === 'setItem' || item.op === 'removeItem'), false);
});

test('activation capabilities reject clones, foreign stores, replay, stale state, and rollback write faults', () => {
  const first = ready();
  const second = ready();
  const preview = first.store.previewTemplateActivation({ targetMonth: '2026-02', selections: [
    { kind: 'income', templateId: 'income-disabled' }
  ] });
  code('INVALID_TEMPLATE_ACTIVATION_PREVIEW', () => first.store.applyTemplateActivationPreview(structuredClone(preview)));
  code('INVALID_TEMPLATE_ACTIVATION_PREVIEW', () => second.store.applyTemplateActivationPreview(preview));
  first.store.updateExpenseTemplate('expense-disabled', { plannedAmount: 41 });
  code('STALE_TEMPLATE_ACTIVATION_PREVIEW', () => first.store.applyTemplateActivationPreview(preview));
  code('INVALID_TEMPLATE_ACTIVATION_PREVIEW', () => first.store.applyTemplateActivationPreview(preview));

  const faulted = ready();
  const faultPreview = faulted.store.previewTemplateActivation({ targetMonth: '2026-02', selections: [
    { kind: 'income', templateId: 'income-disabled' }, { kind: 'expense', templateId: 'expense-disabled' }
  ] });
  const before = faulted.store.getData();
  const raw = faulted.storage.getItem(STORAGE_KEY);
  faulted.storage.fail({ op: 'setItem', key: STORAGE_KEY, once: true });
  code('PRIMARY_WRITE_FAILED', () => faulted.store.applyTemplateActivationPreview(faultPreview));
  assert.deepEqual(faulted.store.getData(), before);
  assert.equal(faulted.storage.getItem(STORAGE_KEY), raw);
  code('INVALID_TEMPLATE_ACTIVATION_PREVIEW', () => faulted.store.applyTemplateActivationPreview(faultPreview));
});
