'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Schema = require('../js/data-schema.js');
const { makeBudget } = require('./helpers.js');

function readFixture(name) {
  return JSON.parse(fs.readFileSync(new URL(`fixtures/${name}`, `file://${__dirname}/`), 'utf8'));
}

function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof Schema.DataError && error.code === code);
}

test('validates canonical data without mutating it', () => {
  const budget = makeBudget();
  const before = JSON.stringify(budget);
  assert.equal(Schema.validateActive(budget), true);
  assert.equal(JSON.stringify(budget), before);
});

test('clone rejects cycles, unsafe keys, sparse arrays, and non-JSON values', () => {
  const cyclic = {}; cyclic.self = cyclic;
  expectCode('CYCLIC_VALUE', () => Schema.clone(cyclic));
  expectCode('UNSAFE_KEY', () => Schema.clone(JSON.parse('{"__proto__":{"polluted":true}}')));
  const sparse = []; sparse.length = 1;
  expectCode('SPARSE_ARRAY', () => Schema.clone(sparse));
  expectCode('NON_JSON_VALUE', () => Schema.clone({ value: undefined }));
  expectCode('NON_FINITE_NUMBER', () => Schema.clone({ value: Infinity }));
  const accessor = {};
  Object.defineProperty(accessor, 'value', { enumerable: true, get() { return 1; } });
  expectCode('NON_DATA_PROPERTY', () => Schema.clone(accessor));
  expectCode('SYMBOL_KEY', () => Schema.clone({ [Symbol('hidden')]: true }));
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'hidden', { value: true, enumerable: false });
  expectCode('NON_DATA_PROPERTY', () => Schema.clone(nonEnumerable));
  const decoratedArray = [];
  decoratedArray.extra = true;
  expectCode('NON_JSON_PROPERTY', () => Schema.clone(decoratedArray));
});

test('rejects unknown and missing canonical fields', () => {
  const unknown = makeBudget(); unknown.extra = true;
  expectCode('UNKNOWN_FIELD', () => Schema.validateActive(unknown));
  const missing = makeBudget(); delete missing.settings;
  expectCode('MISSING_FIELD', () => Schema.validateActive(missing));
});

test('enforces collection and string bounds', () => {
  const tooManyCategories = makeBudget();
  tooManyCategories.categories = Array.from({ length: 101 }, (_, index) => ({ name: `C${index}`, items: [] }));
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(tooManyCategories));
  const longId = makeBudget();
  longId.months['2026-01'].paychecks[0].id = 'x'.repeat(129);
  expectCode('INVALID_STRING', () => Schema.validateActive(longId));
  const duplicate = makeBudget(); duplicate.settings.earners.push('Example Earner');
  expectCode('DUPLICATE_VALUE', () => Schema.validateActive(duplicate));
});

test('validates real month and date values while allowing an empty paycheck date', () => {
  const emptyDate = makeBudget(); emptyDate.months['2026-01'].paychecks[0].date = '';
  assert.equal(Schema.validateActive(emptyDate), true);
  const badMonth = makeBudget(); badMonth.months['2026-13'] = badMonth.months['2026-01']; delete badMonth.months['2026-01'];
  expectCode('INVALID_MONTH', () => Schema.validateActive(badMonth));
  const badDate = makeBudget(); badDate.months['2026-01'].paychecks[0].date = '2026-02-30';
  expectCode('INVALID_DATE', () => Schema.validateActive(badDate));
  const leapDate = makeBudget(); leapDate.months['2026-01'].paychecks[0].date = '2024-02-29';
  assert.equal(Schema.validateActive(leapDate), true);
});

test('enforces amounts and supported enums', () => {
  const zeroIncome = makeBudget(); zeroIncome.months['2026-01'].paychecks[0].amount = 0;
  expectCode('AMOUNT_OUT_OF_RANGE', () => Schema.validateActive(zeroIncome));
  const negative = makeBudget(); negative.months['2026-01'].expenses[0].actual = -1;
  expectCode('AMOUNT_OUT_OF_RANGE', () => Schema.validateActive(negative));
  const nonFinite = makeBudget(); nonFinite.months['2026-01'].expenses[0].actual = NaN;
  expectCode('NON_FINITE_NUMBER', () => Schema.validateActive(nonFinite));
  const method = makeBudget(); method.months['2026-01'].expenses[0].paymentMethod = 'cash';
  expectCode('INVALID_PAYMENT_METHOD', () => Schema.validateActive(method));
});

test('caps monthly monetary aggregates independently of individual values', () => {
  const income = makeBudget();
  income.months['2026-01'].paychecks.push({
    id: 'paycheck-example-2', earner: 'Example Earner', amount: 1_000_000_000_000, date: ''
  });
  expectCode('AGGREGATE_OUT_OF_RANGE', () => Schema.validateActive(income));

  const projected = makeBudget();
  projected.months['2026-01'].paychecks[0].amount = 1_000_000_000_000;
  projected.months['2026-01'].expenses.push({
    id: 'expense-example-2', category: 'Home', name: 'Utilities',
    paycheckAmounts: { 'paycheck-example-1': 1_000_000_000_000 }, actual: 0, paymentMethod: 'bank'
  });
  expectCode('AGGREGATE_OUT_OF_RANGE', () => Schema.validateActive(projected));

  const actual = makeBudget();
  actual.months['2026-01'].expenses.push({
    id: 'expense-example-2', category: 'Home', name: 'Utilities',
    paycheckAmounts: {}, actual: 1_000_000_000_000, paymentMethod: 'bank'
  });
  expectCode('AGGREGATE_OUT_OF_RANGE', () => Schema.validateActive(actual));

  const allocated = makeBudget();
  allocated.months['2026-01'].allocations.savings = 1_000_000_000_000;
  expectCode('AGGREGATE_OUT_OF_RANGE', () => Schema.validateActive(allocated));
});

test('rejects duplicate IDs and dangling paycheck references', () => {
  const duplicate = makeBudget(); duplicate.months['2026-01'].expenses[0].id = duplicate.months['2026-01'].paychecks[0].id;
  expectCode('DUPLICATE_ID', () => Schema.validateActive(duplicate));
  const dangling = makeBudget(); dangling.months['2026-01'].expenses[0].paycheckAmounts = { missing: 10 };
  expectCode('DANGLING_PAYCHECK_REFERENCE', () => Schema.validateActive(dangling));
});

test('requires declared earners and categories', () => {
  const earner = makeBudget(); earner.months['2026-01'].paychecks[0].earner = 'Unknown';
  expectCode('UNKNOWN_EARNER', () => Schema.validateActive(earner));
  const category = makeBudget(); category.months['2026-01'].expenses[0].category = 'Unknown';
  expectCode('UNKNOWN_CATEGORY', () => Schema.validateActive(category));
});

test('migrates legacy paycheck allocations losslessly and does not mutate input', () => {
  const legacy = makeBudget();
  delete legacy.schemaVersion;
  const expense = legacy.months['2026-01'].expenses[0];
  delete expense.paycheckAmounts;
  expense.paycheckId = legacy.months['2026-01'].paychecks[0].id;
  expense.projected = 1200;
  const before = JSON.stringify(legacy);
  const migrated = Schema.migrateActive(legacy);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(migrated.schemaVersion, 1);
  assert.deepEqual(migrated.months['2026-01'].expenses[0].paycheckAmounts, { 'paycheck-example-1': 1200 });
  assert.equal(Object.hasOwn(migrated.months['2026-01'].expenses[0], 'paycheckId'), false);
});

test('preserves a zero projected legacy amount and backfills documented omissions', () => {
  const legacy = makeBudget(); delete legacy.schemaVersion;
  const expense = legacy.months['2026-01'].expenses[0];
  delete expense.paycheckAmounts; delete expense.paymentMethod;
  expense.paycheckId = legacy.months['2026-01'].paychecks[0].id; expense.projected = 0;
  delete legacy.months['2026-01'].allocations;
  const migrated = Schema.migrateActive(legacy);
  assert.equal(migrated.months['2026-01'].expenses[0].paycheckAmounts['paycheck-example-1'], 0);
  assert.equal(migrated.months['2026-01'].expenses[0].actual, 1200);
  assert.equal(migrated.months['2026-01'].expenses[0].paymentMethod, 'bank');
  assert.deepEqual(migrated.months['2026-01'].allocations, { savings: 0, credit_card_debt: 0, investments: 0 });
});

test('does not repair a missing legacy actual field', () => {
  const legacy = makeBudget(); delete legacy.schemaVersion;
  delete legacy.months['2026-01'].expenses[0].actual;
  expectCode('MISSING_FIELD', () => Schema.migrateActive(legacy));
});

test('uses fixed generic defaults for missing legacy categories and earners', () => {
  const legacy = { months: {} };
  const migrated = Schema.migrateActive(legacy);
  assert.equal(migrated.categories.some(category => category.name === 'Housing'), true);
  assert.deepEqual(migrated.settings, { earners: ['Primary', 'Secondary'] });
});

test('rejects unsupported active versions and malformed legacy references', () => {
  const future = makeBudget(); future.schemaVersion = 2;
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateActive(future));
  const legacy = makeBudget(); delete legacy.schemaVersion;
  const expense = legacy.months['2026-01'].expenses[0]; delete expense.paycheckAmounts;
  expense.paycheckId = 'missing'; expense.projected = 10;
  expectCode('DANGLING_PAYCHECK_REFERENCE', () => Schema.migrateActive(legacy));
});

test('parses active JSON with stable safe errors', () => {
  const parsed = Schema.parseActive(JSON.stringify(makeBudget()));
  assert.deepEqual(parsed, makeBudget());
  expectCode('INVALID_JSON', () => Schema.parseActive('{'));
  const sentinel = 'PRIVATE-SENTINEL';
  try {
    Schema.parseActive(JSON.stringify({ sentinel }));
    assert.fail('expected an error');
  } catch (error) {
    assert.equal(error.message.includes(sentinel), false);
  }
});

test('builds and parses versioned backup envelopes as detached data', () => {
  const source = makeBudget();
  const envelope = Schema.buildBackup(source, '2026-01-15T12:00:00.000Z');
  source.categories[0].name = 'Changed';
  assert.equal(envelope.format, Schema.BACKUP_FORMAT);
  const parsed = Schema.parseBackup(JSON.stringify(envelope));
  assert.equal(parsed.data.categories[0].name, 'Home');
  envelope.data.categories[0].name = 'Also changed';
  assert.equal(parsed.data.categories[0].name, 'Home');
});

test('rejects malformed and future backup envelopes', () => {
  const envelope = Schema.buildBackup(makeBudget(), '2026-01-15T12:00:00.000Z');
  envelope.formatVersion = 2;
  expectCode('UNSUPPORTED_BACKUP_VERSION', () => Schema.parseBackup(JSON.stringify(envelope)));
  envelope.formatVersion = 1; envelope.exportedAt = 'not-a-date';
  expectCode('INVALID_TIMESTAMP', () => Schema.parseBackup(JSON.stringify(envelope)));
  envelope.exportedAt = '2026-01-15T12:00:00.000Z'; delete envelope.data.schemaVersion;
  expectCode('MISSING_FIELD', () => Schema.parseBackup(JSON.stringify(envelope)));
});

test('builds and parses validated snapshot envelopes for every supported reason', () => {
  for (const reason of ['daily', 'pre-import', 'pre-reset']) {
    const envelope = Schema.buildSnapshot(makeBudget(), {
      createdAt: '2026-01-15T12:00:00.000Z',
      localDate: '2026-01-15',
      reason
    });
    assert.deepEqual(Schema.parseSnapshot(JSON.stringify(envelope)), envelope);
  }
});

test('rejects malformed snapshot metadata and future versions', () => {
  expectCode('INVALID_SNAPSHOT_REASON', () => Schema.buildSnapshot(makeBudget(), {
    createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'manual'
  }));
  const envelope = Schema.buildSnapshot(makeBudget(), {
    createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'daily'
  });
  envelope.formatVersion = 2;
  expectCode('UNSUPPORTED_SNAPSHOT_VERSION', () => Schema.parseSnapshot(JSON.stringify(envelope)));
});

test('legacy migration rejects missing months and backfills missing month collections', () => {
  expectCode('MISSING_FIELD', () => Schema.migrateActive({ categories: [], settings: { earners: [] } }));
  const legacy = {
    categories: [],
    settings: { earners: [] },
    months: { '2026-01': {} }
  };
  assert.deepEqual(Schema.migrateActive(legacy).months['2026-01'], {
    paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }
  });
});

test('caps one expense projected sum across multiple valid paycheck references', () => {
  const budget = makeBudget();
  const month = budget.months['2026-01'];
  month.paychecks = [
    { id: 'p1', earner: 'Example Earner', amount: 500_000_000_000, date: '' },
    { id: 'p2', earner: 'Example Earner', amount: 500_000_000_000, date: '' }
  ];
  month.expenses[0].paycheckAmounts = { p1: 500_000_000_000, p2: 500_000_000_001 };
  expectCode('AGGREGATE_OUT_OF_RANGE', () => Schema.validateActive(budget));
});

test('enforces exact nested keys for every canonical record type', () => {
  const cases = [
    ['category extra', b => { b.categories[0].extra = true; }, 'UNKNOWN_FIELD'],
    ['category missing', b => { delete b.categories[0].items; }, 'MISSING_FIELD'],
    ['settings extra', b => { b.settings.extra = true; }, 'UNKNOWN_FIELD'],
    ['settings missing', b => { delete b.settings.earners; }, 'MISSING_FIELD'],
    ['month extra', b => { b.months['2026-01'].extra = true; }, 'UNKNOWN_FIELD'],
    ['month missing', b => { delete b.months['2026-01'].allocations; }, 'MISSING_FIELD'],
    ['paycheck extra', b => { b.months['2026-01'].paychecks[0].extra = true; }, 'UNKNOWN_FIELD'],
    ['paycheck missing', b => { delete b.months['2026-01'].paychecks[0].date; }, 'MISSING_FIELD'],
    ['expense extra', b => { b.months['2026-01'].expenses[0].extra = true; }, 'UNKNOWN_FIELD'],
    ['expense missing', b => { delete b.months['2026-01'].expenses[0].actual; }, 'MISSING_FIELD'],
    ['allocations extra', b => { b.months['2026-01'].allocations.extra = 0; }, 'UNKNOWN_FIELD'],
    ['allocations missing', b => { delete b.months['2026-01'].allocations.savings; }, 'MISSING_FIELD']
  ];
  for (const [label, mutate, code] of cases) {
    const budget = makeBudget(); mutate(budget);
    assert.throws(() => Schema.validateActive(budget), error => error.code === code, label);
  }
});

test('accepts boundary sizes and rejects collection limits plus one', () => {
  const categoryBoundary = makeBudget();
  categoryBoundary.categories = Array.from({ length: 100 }, (_, i) => ({ name: `Category ${i}`, items: [] }));
  categoryBoundary.months['2026-01'].expenses[0].category = 'Category 0';
  assert.equal(Schema.validateActive(categoryBoundary), true);
  const categoryOverflow = makeBudget();
  categoryOverflow.categories = Array.from({ length: 101 }, (_, i) => ({ name: `Category ${i}`, items: [] }));
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(categoryOverflow));

  const itemOverflow = makeBudget(); itemOverflow.categories[0].items = Array.from({ length: 201 }, (_, i) => `Item ${i}`);
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(itemOverflow));
  const earnerOverflow = makeBudget(); earnerOverflow.settings.earners = Array.from({ length: 51 }, (_, i) => `Earner ${i}`);
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(earnerOverflow));

  const itemBoundary = makeBudget(); itemBoundary.categories[0].items = Array.from({ length: 200 }, (_, i) => `Item ${i}`);
  assert.equal(Schema.validateActive(itemBoundary), true);
  const earnerBoundary = makeBudget(); earnerBoundary.settings.earners = Array.from({ length: 50 }, (_, i) => `Earner ${i}`);
  earnerBoundary.months['2026-01'].paychecks[0].earner = 'Earner 0';
  assert.equal(Schema.validateActive(earnerBoundary), true);

  const monthOverflow = makeBudget(); monthOverflow.months = {};
  for (let i = 0; i < 601; i += 1) {
    const year = 2000 + Math.floor(i / 12); const month = String((i % 12) + 1).padStart(2, '0');
    monthOverflow.months[`${year}-${month}`] = { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 } };
  }
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(monthOverflow));
  delete monthOverflow.months['2050-01'];
  assert.equal(Object.keys(monthOverflow.months).length, 600);
  assert.equal(Schema.validateActive(monthOverflow), true);

  const paycheckOverflow = makeBudget(); paycheckOverflow.months['2026-01'].paychecks = Array.from({ length: 501 }, (_, i) => ({
    id: `p${i}`, earner: 'Example Earner', amount: 1, date: ''
  })); paycheckOverflow.months['2026-01'].expenses = [];
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(paycheckOverflow));
  paycheckOverflow.months['2026-01'].paychecks.pop();
  assert.equal(Schema.validateActive(paycheckOverflow), true);

  const expenseOverflow = makeBudget(); expenseOverflow.months['2026-01'].paychecks = [];
  expenseOverflow.months['2026-01'].expenses = Array.from({ length: 5001 }, (_, i) => ({
    id: `e${i}`, category: 'Home', name: 'Item', paycheckAmounts: {}, actual: 0, paymentMethod: 'bank'
  }));
  expectCode('TOO_MANY_ITEMS', () => Schema.validateActive(expenseOverflow));
  expenseOverflow.months['2026-01'].expenses.pop();
  assert.equal(Schema.validateActive(expenseOverflow), true);
});

test('accepts exact string and money boundaries and rejects plus one', () => {
  const stringBoundary = makeBudget();
  stringBoundary.settings.earners[0] = 'e'.repeat(120);
  stringBoundary.months['2026-01'].paychecks[0].earner = 'e'.repeat(120);
  stringBoundary.months['2026-01'].paychecks[0].id = 'p'.repeat(128);
  stringBoundary.categories[0].name = 'c'.repeat(120);
  stringBoundary.categories[0].items = ['i'.repeat(120)];
  stringBoundary.months['2026-01'].expenses[0].category = 'c'.repeat(120);
  stringBoundary.months['2026-01'].expenses[0].name = 'n'.repeat(120);
  stringBoundary.months['2026-01'].expenses[0].paycheckAmounts = { ['p'.repeat(128)]: 0 };
  assert.equal(Schema.validateActive(stringBoundary), true);
  const nameOverflow = makeBudget(); nameOverflow.categories[0].name = 'n'.repeat(121);
  expectCode('INVALID_STRING', () => Schema.validateActive(nameOverflow));
  const idOverflow = makeBudget(); idOverflow.months['2026-01'].paychecks[0].id = 'p'.repeat(129);
  expectCode('INVALID_STRING', () => Schema.validateActive(idOverflow));

  const moneyBoundary = makeBudget();
  const month = moneyBoundary.months['2026-01'];
  month.paychecks[0].amount = 1_000_000_000_000;
  month.expenses[0].paycheckAmounts = {}; month.expenses[0].actual = 0;
  month.allocations = { savings: 0, credit_card_debt: 0, investments: 0 };
  assert.equal(Schema.validateActive(moneyBoundary), true);
  const moneyOverflow = makeBudget(); moneyOverflow.months['2026-01'].expenses[0].actual = 1_000_000_000_001;
  expectCode('AMOUNT_OUT_OF_RANGE', () => Schema.validateActive(moneyOverflow));
  const paycheckZero = makeBudget(); paycheckZero.months['2026-01'].paychecks[0].amount = 0;
  expectCode('AMOUNT_OUT_OF_RANGE', () => Schema.validateActive(paycheckZero));
});

test('rejects unsafe keys at nested depths from JSON input', () => {
  const category = makeBudget();
  category.categories[0] = JSON.parse('{"name":"Home","items":[],"__proto__":{}}');
  expectCode('UNSAFE_KEY', () => Schema.validateActive(category));
  const amounts = makeBudget();
  amounts.months['2026-01'].expenses[0].paycheckAmounts = JSON.parse('{"__proto__":10}');
  expectCode('UNSAFE_KEY', () => Schema.validateActive(amounts));
  const monthMap = makeBudget();
  monthMap.months = JSON.parse('{"constructor":{}}');
  expectCode('UNSAFE_KEY', () => Schema.validateActive(monthMap));
});

test('accepts Object.prototype and null prototypes but rejects custom prototypes', () => {
  assert.deepEqual(Schema.clone({ value: 1 }), { value: 1 });
  const nullObject = Object.create(null); nullObject.value = 1;
  assert.deepEqual(Schema.clone(nullObject), { value: 1 });
  const custom = Object.create({ inherited: true }); custom.value = 1;
  expectCode('NON_PLAIN_OBJECT', () => Schema.clone(custom));
});

test('detects duplicate category names, IDs in each collection, and dangling refs', () => {
  const categories = makeBudget(); categories.categories.push({ name: 'Home', items: [] });
  expectCode('DUPLICATE_VALUE', () => Schema.validateActive(categories));
  const paychecks = makeBudget(); paychecks.months['2026-01'].paychecks.push({
    id: 'paycheck-example-1', earner: 'Example Earner', amount: 1, date: ''
  });
  expectCode('DUPLICATE_ID', () => Schema.validateActive(paychecks));
  const expenses = makeBudget(); expenses.months['2026-01'].expenses.push({
    ...expenses.months['2026-01'].expenses[0], paycheckAmounts: {}
  });
  expectCode('DUPLICATE_ID', () => Schema.validateActive(expenses));
  const dangling = makeBudget(); dangling.months['2026-01'].expenses[0].paycheckAmounts = { missing: 0 };
  expectCode('DANGLING_PAYCHECK_REFERENCE', () => Schema.validateActive(dangling));
});

test('rejects blocked identifier values before they can become dynamic keys', () => {
  for (const blocked of ['__proto__', 'prototype', 'constructor']) {
    const paycheck = makeBudget();
    paycheck.months['2026-01'].paychecks[0].id = blocked;
    paycheck.months['2026-01'].expenses[0].paycheckAmounts = {};
    expectCode('UNSAFE_IDENTIFIER', () => Schema.validateActive(paycheck));

    const expense = makeBudget();
    expense.months['2026-01'].expenses[0].id = blocked;
    expectCode('UNSAFE_IDENTIFIER', () => Schema.validateActive(expense));
  }
});

test('legacy migration rejects unsafe paycheckId before assignment without mutating or dropping source amount', () => {
  const legacy = makeBudget();
  delete legacy.schemaVersion;
  const month = legacy.months['2026-01'];
  month.paychecks[0].id = '__proto__';
  const expense = month.expenses[0];
  delete expense.paycheckAmounts;
  expense.paycheckId = '__proto__';
  expense.projected = 1200;
  const before = JSON.stringify(legacy);
  expectCode('UNSAFE_IDENTIFIER', () => Schema.migrateActive(legacy));
  assert.equal(JSON.stringify(legacy), before);
  assert.equal(expense.projected, 1200);
  assert.equal(expense.paycheckId, '__proto__');
});

test('category display names retain hostile key spellings as ordinary string values', () => {
  const budget = makeBudget();
  budget.categories[0].name = '__proto__';
  budget.months['2026-01'].expenses[0].category = '__proto__';
  assert.equal(Schema.validateActive(budget), true);
});

test('classic-script and CommonJS expose the exact same public API and behavior', () => {
  const source = fs.readFileSync(require.resolve('../js/data-schema.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'data-schema.js' });
  const browserApi = context.ZeroBudgetSchema;
  const expectedKeys = [
    'BACKUP_FORMAT', 'BACKUP_FORMAT_VERSION', 'DataError', 'SCHEMA_VERSION', 'SNAPSHOT_FORMAT',
    'SNAPSHOT_FORMAT_VERSION', 'V2_SCHEMA_VERSION', 'buildBackup', 'buildSnapshot', 'clone', 'migrateActive',
    'migrateToV2', 'parseActive', 'parseBackup', 'parseSnapshot', 'validateActive', 'validateV2'
  ];
  assert.deepEqual(Object.keys(Schema).sort(), expectedKeys);
  assert.deepEqual(Array.from(Object.keys(browserApi).sort()), expectedKeys);
  const text = JSON.stringify(makeBudget());
  assert.equal(JSON.stringify(browserApi.parseActive(text)), JSON.stringify(Schema.parseActive(text)));
  assert.equal(browserApi.BACKUP_FORMAT, Schema.BACKUP_FORMAT);
  assert.equal(JSON.stringify(browserApi.migrateToV2(browserApi.parseActive(text))), JSON.stringify(Schema.migrateToV2(JSON.parse(text))));
});

test('dormant v2 migration matches its exact golden deterministically without mutating v1', () => {
  const source = readFixture('schema-v1-migration.json');
  const golden = readFixture('schema-v2-golden.json');
  const before = JSON.stringify(source);
  const first = Schema.migrateToV2(source);
  const second = Schema.migrateToV2(structuredClone(source));
  assert.deepEqual(first, golden);
  assert.deepEqual(second, golden);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(source), before);
  assert.equal(Schema.validateV2(first), true);
  assert.equal(Schema.SCHEMA_VERSION, 1);
  assert.equal(Schema.V2_SCHEMA_VERSION, 2);
});

test('v0 migrates through v1 to v2 without losing legacy paycheck allocation', () => {
  const legacy = makeBudget(); delete legacy.schemaVersion;
  const expense = legacy.months['2026-01'].expenses[0];
  delete expense.paycheckAmounts; expense.paycheckId = 'paycheck-example-1'; expense.projected = 432;
  const migrated = Schema.migrateToV2(legacy);
  assert.deepEqual(migrated.months['2026-01'].expenses[0].paycheckAmounts, { 'paycheck-example-1': 432 });
  assert.equal(migrated.months['2026-01'].expenses[0].categoryItemId, null);
});

test('v2 accepts coherent empty, archived, historical, and provenance states', () => {
  assert.equal(Schema.validateV2({ schemaVersion: 2, categories: [], settings: { earners: [] }, months: {} }), true);
  const v2 = readFixture('schema-v2-golden.json');
  v2.categories[0].archived = true;
  v2.categories[0].items[0].archived = true;
  v2.settings.earners[0].archived = true;
  v2.months['2027-03'].paychecks[0].earner = 'Former display name';
  v2.months['2027-03'].expenses[0].category = 'Former category label';
  v2.months['2027-03'].expenses[0].categoryItemId = 'migrated-item-0001-0001';
  v2.months['2027-03'].expenses[0].name = 'Historical custom label';
  v2.months['2027-03'].paychecks[0].id = 'migrated-category-0001';
  v2.months['2027-03'].expenses[0].paycheckAmounts = { 'migrated-category-0001': 975 };
  assert.equal(Schema.validateV2(v2), true);
});

test('native v2 migration validates and returns a detached equal clone', () => {
  const source = readFixture('schema-v2-golden.json');
  const migrated = Schema.migrateToV2(source);
  assert.deepEqual(migrated, source);
  assert.notEqual(migrated, source);
  migrated.categories[0].items[0].name = 'Changed';
  assert.equal(source.categories[0].items[0].name, 'Lease');
});

test('v2 rejects malformed structure, unsafe identifiers, and catalog collisions', () => {
  const cases = [
    ['UNKNOWN_FIELD', v => { v.categories[0].extra = true; }],
    ['MISSING_FIELD', v => { delete v.categories[0].archived; }],
    ['EXPECTED_BOOLEAN', v => { v.categories[0].archived = 0; }],
    ['UNSAFE_IDENTIFIER', v => { v.categories[0].id = '__proto__'; }],
    ['DUPLICATE_ID', v => { v.settings.earners[0].id = v.categories[0].items[0].id; }],
    ['DUPLICATE_VALUE', v => { v.categories[1].name = v.categories[0].name; }]
  ];
  for (const [code, mutate] of cases) {
    const v2 = readFixture('schema-v2-golden.json'); mutate(v2);
    expectCode(code, () => Schema.validateV2(v2));
  }
});

test('v2 enforces structural references and category item ownership', () => {
  const danglingEarner = readFixture('schema-v2-golden.json');
  danglingEarner.months['2027-03'].paychecks[0].earnerId = 'missing';
  expectCode('DANGLING_EARNER_REFERENCE', () => Schema.validateV2(danglingEarner));
  const danglingCategory = readFixture('schema-v2-golden.json');
  danglingCategory.months['2027-03'].expenses[0].categoryId = 'missing';
  expectCode('DANGLING_CATEGORY_REFERENCE', () => Schema.validateV2(danglingCategory));
  const danglingItem = readFixture('schema-v2-golden.json');
  danglingItem.months['2027-03'].expenses[0].categoryItemId = 'missing';
  expectCode('DANGLING_CATEGORY_ITEM_REFERENCE', () => Schema.validateV2(danglingItem));
  const wrongCategory = readFixture('schema-v2-golden.json');
  wrongCategory.categories[1].items.push({ id: 'travel-item', name: 'Fare', archived: false });
  wrongCategory.months['2027-03'].expenses[0].categoryItemId = 'travel-item';
  expectCode('DANGLING_CATEGORY_ITEM_REFERENCE', () => Schema.validateV2(wrongCategory));
});

test('v2 retains v1 bounds and rejects unsupported migration versions', () => {
  const longName = readFixture('schema-v2-golden.json'); longName.categories[0].items[0].name = 'x'.repeat(121);
  expectCode('INVALID_STRING', () => Schema.validateV2(longName));
  const tooMuch = readFixture('schema-v2-golden.json'); tooMuch.months['2027-03'].expenses[0].actual = 1_000_000_000_001;
  expectCode('AMOUNT_OUT_OF_RANGE', () => Schema.validateV2(tooMuch));
  const future = makeBudget(); future.schemaVersion = 3;
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateToV2(future));
  const invalid = makeBudget(); invalid.schemaVersion = '1';
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateToV2(invalid));
});

test('active v1 parsers and envelopes remain v1 and reject dormant v2', () => {
  const v2 = readFixture('schema-v2-golden.json');
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.validateActive(v2));
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.parseActive(JSON.stringify(v2)));
  const backup = { format: Schema.BACKUP_FORMAT, formatVersion: Schema.BACKUP_FORMAT_VERSION, exportedAt: '2027-03-01T00:00:00.000Z', data: v2 };
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.parseBackup(JSON.stringify(backup)));
  assert.equal(Schema.buildBackup(makeBudget(), '2027-03-01T00:00:00.000Z').data.schemaVersion, 1);
  const snapshot = {
    format: Schema.SNAPSHOT_FORMAT, formatVersion: Schema.SNAPSHOT_FORMAT_VERSION,
    createdAt: '2027-03-01T00:00:00.000Z', localDate: '2027-03-01', reason: 'daily', data: v2
  };
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.parseSnapshot(JSON.stringify(snapshot)));
  assert.equal(Schema.buildSnapshot(makeBudget(), {
    createdAt: '2027-03-01T00:00:00.000Z', localDate: '2027-03-01', reason: 'daily'
  }).data.schemaVersion, 1);
});

test('backup envelopes enforce exact shape, format, date, and detachment', () => {
  const source = makeBudget();
  const built = Schema.buildBackup(source, '2026-01-15T12:00:00.000Z');
  source.categories[0].name = 'Mutated';
  assert.equal(built.data.categories[0].name, 'Home');
  const extra = structuredClone(built); extra.extra = true;
  expectCode('UNKNOWN_FIELD', () => Schema.parseBackup(JSON.stringify(extra)));
  const missing = structuredClone(built); delete missing.data;
  expectCode('MISSING_FIELD', () => Schema.parseBackup(JSON.stringify(missing)));
  const format = structuredClone(built); format.format = 'other';
  expectCode('INVALID_BACKUP_FORMAT', () => Schema.parseBackup(JSON.stringify(format)));
  const date = structuredClone(built); date.exportedAt = '2026-02-30T12:00:00.000Z';
  expectCode('INVALID_TIMESTAMP', () => Schema.parseBackup(JSON.stringify(date)));
  const parsed = Schema.parseBackup(JSON.stringify(built)); parsed.data.categories[0].name = 'Changed';
  assert.equal(built.data.categories[0].name, 'Home');
});

test('snapshot envelopes enforce exact shape, format, local date, and detachment', () => {
  const built = Schema.buildSnapshot(makeBudget(), {
    createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'daily'
  });
  const extra = structuredClone(built); extra.extra = true;
  expectCode('UNKNOWN_FIELD', () => Schema.parseSnapshot(JSON.stringify(extra)));
  const missing = structuredClone(built); delete missing.localDate;
  expectCode('MISSING_FIELD', () => Schema.parseSnapshot(JSON.stringify(missing)));
  const format = structuredClone(built); format.format = 'other';
  expectCode('INVALID_SNAPSHOT_FORMAT', () => Schema.parseSnapshot(JSON.stringify(format)));
  const date = structuredClone(built); date.localDate = '2026-02-30';
  expectCode('INVALID_DATE', () => Schema.parseSnapshot(JSON.stringify(date)));
  const parsed = Schema.parseSnapshot(JSON.stringify(built)); parsed.data.categories[0].name = 'Changed';
  assert.equal(built.data.categories[0].name, 'Home');
});
