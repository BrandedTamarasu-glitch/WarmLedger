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

function makeV3WithTemplates() {
  const v3 = readFixture('schema-v3-golden.json');
  v3.templates.income.push({
    id: 'income-template-1', name: 'Example income', earnerId: 'migrated-earner-0001',
    plannedAmount: 2400, enabled: true, archived: false,
    startDate: '2027-01-01', endDate: null,
    recurrence: { cadence: 'weekly', anchorDate: '2027-01-01' }
  });
  v3.templates.expenses.push({
    id: 'expense-template-1', name: 'Example expense', categoryId: 'migrated-category-0001',
    categoryItemId: 'migrated-item-0001-0001', plannedAmount: 975, paymentMethod: 'bank',
    enabled: false, archived: true, startDate: '2027-01-01', endDate: '2027-12-31',
    recurrence: { cadence: 'twice-monthly', days: [1, 31] }
  });
  return v3;
}

function expectCode(code, fn) {
  assert.throws(fn, error => error instanceof Schema.DataError && error.code === code);
}

function validateV1Input(input) {
  Schema.migrateToV2(input);
  return true;
}

test('validates canonical data without mutating it', () => {
  const budget = makeBudget();
  const before = JSON.stringify(budget);
  assert.equal(validateV1Input(budget), true);
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
  expectCode('UNKNOWN_FIELD', () => validateV1Input(unknown));
  const missing = makeBudget(); delete missing.settings;
  expectCode('MISSING_FIELD', () => validateV1Input(missing));
});

test('enforces collection and string bounds', () => {
  const tooManyCategories = makeBudget();
  tooManyCategories.categories = Array.from({ length: 101 }, (_, index) => ({ name: `C${index}`, items: [] }));
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(tooManyCategories));
  const longId = makeBudget();
  longId.months['2026-01'].paychecks[0].id = 'x'.repeat(129);
  expectCode('INVALID_STRING', () => validateV1Input(longId));
  const duplicate = makeBudget(); duplicate.settings.earners.push('Example Earner');
  expectCode('DUPLICATE_VALUE', () => validateV1Input(duplicate));
});

test('validates real month and date values while allowing an empty paycheck date', () => {
  const emptyDate = makeBudget(); emptyDate.months['2026-01'].paychecks[0].date = '';
  assert.equal(validateV1Input(emptyDate), true);
  const badMonth = makeBudget(); badMonth.months['2026-13'] = badMonth.months['2026-01']; delete badMonth.months['2026-01'];
  expectCode('INVALID_MONTH', () => validateV1Input(badMonth));
  const badDate = makeBudget(); badDate.months['2026-01'].paychecks[0].date = '2026-02-30';
  expectCode('INVALID_DATE', () => validateV1Input(badDate));
  const leapDate = makeBudget(); leapDate.months['2026-01'].paychecks[0].date = '2024-02-29';
  assert.equal(validateV1Input(leapDate), true);
});

test('enforces amounts and supported enums', () => {
  const zeroIncome = makeBudget(); zeroIncome.months['2026-01'].paychecks[0].amount = 0;
  expectCode('AMOUNT_OUT_OF_RANGE', () => validateV1Input(zeroIncome));
  const negative = makeBudget(); negative.months['2026-01'].expenses[0].actual = -1;
  expectCode('AMOUNT_OUT_OF_RANGE', () => validateV1Input(negative));
  const nonFinite = makeBudget(); nonFinite.months['2026-01'].expenses[0].actual = NaN;
  expectCode('NON_FINITE_NUMBER', () => validateV1Input(nonFinite));
  const method = makeBudget(); method.months['2026-01'].expenses[0].paymentMethod = 'cash';
  expectCode('INVALID_PAYMENT_METHOD', () => validateV1Input(method));
});

test('caps monthly monetary aggregates independently of individual values', () => {
  const income = makeBudget();
  income.months['2026-01'].paychecks.push({
    id: 'paycheck-example-2', earner: 'Example Earner', amount: 1_000_000_000_000, date: ''
  });
  expectCode('AGGREGATE_OUT_OF_RANGE', () => validateV1Input(income));

  const projected = makeBudget();
  projected.months['2026-01'].paychecks[0].amount = 1_000_000_000_000;
  projected.months['2026-01'].expenses.push({
    id: 'expense-example-2', category: 'Home', name: 'Utilities',
    paycheckAmounts: { 'paycheck-example-1': 1_000_000_000_000 }, actual: 0, paymentMethod: 'bank'
  });
  expectCode('AGGREGATE_OUT_OF_RANGE', () => validateV1Input(projected));

  const actual = makeBudget();
  actual.months['2026-01'].expenses.push({
    id: 'expense-example-2', category: 'Home', name: 'Utilities',
    paycheckAmounts: {}, actual: 1_000_000_000_000, paymentMethod: 'bank'
  });
  expectCode('AGGREGATE_OUT_OF_RANGE', () => validateV1Input(actual));

  const allocated = makeBudget();
  allocated.months['2026-01'].allocations.savings = 1_000_000_000_000;
  expectCode('AGGREGATE_OUT_OF_RANGE', () => validateV1Input(allocated));
});

test('rejects duplicate IDs and dangling paycheck references', () => {
  const duplicate = makeBudget(); duplicate.months['2026-01'].expenses[0].id = duplicate.months['2026-01'].paychecks[0].id;
  expectCode('DUPLICATE_ID', () => validateV1Input(duplicate));
  const dangling = makeBudget(); dangling.months['2026-01'].expenses[0].paycheckAmounts = { missing: 10 };
  expectCode('DANGLING_PAYCHECK_REFERENCE', () => validateV1Input(dangling));
});

test('requires declared earners and categories', () => {
  const earner = makeBudget(); earner.months['2026-01'].paychecks[0].earner = 'Unknown';
  expectCode('UNKNOWN_EARNER', () => validateV1Input(earner));
  const category = makeBudget(); category.months['2026-01'].expenses[0].category = 'Unknown';
  expectCode('UNKNOWN_CATEGORY', () => validateV1Input(category));
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
  assert.equal(migrated.schemaVersion, 3);
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
  assert.equal(migrated.months['2026-01'].expenses[0].actualAmount, 1200);
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
  assert.deepEqual(migrated.settings.earners.map(earner => earner.name), ['Primary', 'Secondary']);
});

test('rejects unsupported active versions and malformed legacy references', () => {
  const future = makeBudget(); future.schemaVersion = 4;
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateActive(future));
  const legacy = makeBudget(); delete legacy.schemaVersion;
  const expense = legacy.months['2026-01'].expenses[0]; delete expense.paycheckAmounts;
  expense.paycheckId = 'missing'; expense.projected = 10;
  expectCode('DANGLING_PAYCHECK_REFERENCE', () => Schema.migrateActive(legacy));
});

test('parses active JSON with stable safe errors', () => {
  const parsed = Schema.parseActive(JSON.stringify(makeBudget()));
  assert.deepEqual(parsed, Schema.migrateToV3(makeBudget()));
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
  expectCode('UNKNOWN_FIELD', () => Schema.parseBackup(JSON.stringify(envelope)));
});

test('builds and parses validated snapshot envelopes for every supported reason', () => {
  for (const reason of ['daily', 'pre-import', 'pre-sharding', 'pre-reset']) {
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

test('schema v4 persists every money family as integer cents and hydrates losslessly', () => {
  const v3 = makeV3WithTemplates();
  const monthKey = Object.keys(v3.months)[0];
  const month = v3.months[monthKey];
  v3.templates.income[0].plannedAmount = 2400.29;
  v3.templates.expenses[0].plannedAmount = 975.01;
  month.paychecks[0].plannedAmount = 2000.02;
  month.paychecks[0].actualAmount = null;
  month.expenses[0].plannedAmount = 1200.03;
  month.expenses[0].actualAmount = 0;
  month.expenses[0].paycheckAmounts[month.paychecks[0].id] = 1199.99;
  month.allocations = { savings: 100.01, credit_card_debt: 0, investments: 50.5 };

  const persisted = Schema.migrateV3ToV4ExactMoney(v3);
  assert.equal(persisted.schemaVersion, 4);
  assert.equal(persisted.templates.income[0].plannedAmount, 240029);
  assert.equal(persisted.templates.expenses[0].plannedAmount, 97501);
  assert.equal(persisted.months[monthKey].paychecks[0].plannedAmount, 200002);
  assert.equal(persisted.months[monthKey].paychecks[0].actualAmount, null);
  assert.equal(persisted.months[monthKey].expenses[0].plannedAmount, 120003);
  assert.equal(persisted.months[monthKey].expenses[0].actualAmount, 0);
  assert.equal(persisted.months[monthKey].expenses[0].paycheckAmounts[month.paychecks[0].id], 119999);
  assert.deepEqual(persisted.months[monthKey].allocations,
    { savings: 10001, credit_card_debt: 0, investments: 5050 });
  assert.equal(Schema.validateV4(persisted), true);
  assert.deepEqual(Schema.hydrateV4ExactMoney(persisted), v3);
});

test('schema v4 conversion rejects sub-cent values without rounding or mutating input', () => {
  const v3 = makeV3WithTemplates();
  v3.months[Object.keys(v3.months)[0]].expenses[0].actualAmount = 12.345;
  const before = JSON.stringify(v3);
  expectCode('SUB_CENT_AMOUNT', () => Schema.dehydrateV4ExactMoney(v3));
  assert.equal(JSON.stringify(v3), before);
  assert.equal(Schema.decimalMoneyToCents(0.29), 29);
  assert.equal(Schema.centsToDecimalMoney(29), 0.29);
});

test('schema v4 rejects malformed, negative, unsafe, and out-of-range cents', () => {
  const persisted = Schema.dehydrateV4ExactMoney(makeV3WithTemplates());
  const expense = persisted.months[Object.keys(persisted.months)[0]].expenses[0];
  expense.plannedAmount = 1.5;
  expectCode('INVALID_CENTS', () => Schema.validateV4(persisted));
  expense.plannedAmount = -1;
  expectCode('CENTS_OUT_OF_RANGE', () => Schema.validateV4(persisted));
  expense.plannedAmount = Number.MAX_SAFE_INTEGER;
  expectCode('CENTS_OUT_OF_RANGE', () => Schema.validateV4(persisted));
  expense.plannedAmount = Number.MAX_SAFE_INTEGER + 1;
  expectCode('INVALID_CENTS', () => Schema.validateV4(persisted));
});

test('schema v4 active, backup, and snapshot codecs preserve envelope version 1', () => {
  const v3 = makeV3WithTemplates();
  const persisted = Schema.buildActiveData(v3, Schema.V4_SCHEMA_VERSION);
  assert.equal(persisted.schemaVersion, 4);
  assert.deepEqual(Schema.parseActiveData(JSON.stringify(persisted)), v3);

  const backup = Schema.buildV4Backup(v3, '2026-01-15T12:00:00.000Z');
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.data.schemaVersion, 4);
  assert.deepEqual(Schema.parseV4Backup(JSON.stringify(backup)).data, v3);

  const snapshot = Schema.buildV4Snapshot(v3, {
    createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'pre-import'
  });
  assert.equal(snapshot.formatVersion, 1);
  assert.equal(snapshot.data.schemaVersion, 4);
  assert.deepEqual(Schema.parseV4Snapshot(JSON.stringify(snapshot)).data, v3);
});

test('dormant schema v5 migrates only persisted v4 and defaults every record cleared false', () => {
  const v4 = Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates());
  const before = JSON.stringify(v4);
  const v5 = Schema.migrateV4ToV5(v4);
  assert.equal(v5.schemaVersion, 5);
  for (const month of Object.values(v5.months)) {
    assert.equal(month.paychecks.every(record => record.cleared === false), true);
    assert.equal(month.expenses.every(record => record.cleared === false), true);
  }
  assert.equal(JSON.stringify(v4), before);
  assert.equal(Schema.validateV5(v5), true);
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateV4ToV5(makeV3WithTemplates()));
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateV4ToV5(makeBudget()));
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateV4ToV5(v5));
});

test('schema v5 hydrate/dehydrate preserves exact cents, cleared flags, and source graphs', () => {
  const v3 = makeV3WithTemplates();
  const month = v3.months[Object.keys(v3.months)[0]];
  month.paychecks[0].plannedAmount = 2000.29;
  month.paychecks[0].actualAmount = 0;
  month.expenses[0].plannedAmount = 1200.03;
  month.expenses[0].actualAmount = null;
  month.expenses[0].paycheckAmounts[month.paychecks[0].id] = 1199.99;
  const v4 = Schema.migrateV3ToV4ExactMoney(v3);
  const persisted = Schema.migrateV4ToV5(v4);
  persisted.months[Object.keys(persisted.months)[0]].paychecks[0].cleared = true;
  const persistedBefore = JSON.stringify(persisted);
  const runtime = Schema.hydrateV5ExactMoney(persisted);
  assert.equal(runtime.schemaVersion, 3);
  assert.equal(runtime.months[Object.keys(runtime.months)[0]].paychecks[0].plannedAmount, 2000.29);
  assert.equal(runtime.months[Object.keys(runtime.months)[0]].paychecks[0].actualAmount, 0);
  assert.equal(runtime.months[Object.keys(runtime.months)[0]].paychecks[0].cleared, true);
  assert.equal(runtime.months[Object.keys(runtime.months)[0]].expenses[0].cleared, false);
  assert.deepEqual(Schema.dehydrateV5ExactMoney(runtime), persisted);
  assert.equal(JSON.stringify(persisted), persistedBefore);
  const runtimeBefore = JSON.stringify(runtime);
  assert.deepEqual(Schema.buildActiveData(runtime, Schema.V5_SCHEMA_VERSION), persisted);
  assert.equal(JSON.stringify(runtime), runtimeBefore);
  assert.deepEqual(Schema.parseActiveData(JSON.stringify(persisted)), runtime);
});

test('schema v5 strictly requires only boolean cleared additions and rejects sub-cent runtime conversion', () => {
  const persisted = Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates()));
  const month = persisted.months[Object.keys(persisted.months)[0]];
  const missing = structuredClone(persisted); delete missing.months[Object.keys(missing.months)[0]].paychecks[0].cleared;
  expectCode('MISSING_FIELD', () => Schema.validateV5(missing));
  const unknown = structuredClone(persisted); unknown.months[Object.keys(unknown.months)[0]].expenses[0].clearedAt = null;
  expectCode('UNKNOWN_FIELD', () => Schema.validateV5(unknown));
  const nonBoolean = structuredClone(persisted); nonBoolean.months[Object.keys(nonBoolean.months)[0]].expenses[0].cleared = 0;
  expectCode('EXPECTED_BOOLEAN', () => Schema.validateV5(nonBoolean));
  const fractionalCents = structuredClone(persisted); fractionalCents.months[Object.keys(fractionalCents.months)[0]].expenses[0].plannedAmount = 1.5;
  expectCode('INVALID_CENTS', () => Schema.validateV5(fractionalCents));
  const runtime = Schema.hydrateV5ExactMoney(persisted);
  runtime.months[Object.keys(runtime.months)[0]].expenses[0].actualAmount = 12.345;
  const before = JSON.stringify(runtime);
  expectCode('SUB_CENT_AMOUNT', () => Schema.dehydrateV5ExactMoney(runtime));
  assert.equal(JSON.stringify(runtime), before);
  assert.equal(month.paychecks[0].cleared, false);
});

test('schema v5 policy and format-v1 backup/snapshot codecs round trip only explicit v5 data', () => {
  const persisted = Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates()));
  persisted.months[Object.keys(persisted.months)[0]].expenses[0].cleared = true;
  const runtime = Schema.hydrateV5ExactMoney(persisted);
  assert.equal(Object.isFrozen(Schema.V5_SCHEMA_POLICY), true);
  assert.equal(Schema.V5_SCHEMA_POLICY.SCHEMA_VERSION, 5);
  assert.deepEqual(Schema.V5_SCHEMA_POLICY.parseActive(JSON.stringify(persisted)), runtime);
  const backup = Schema.buildV5Backup(runtime, '2026-01-15T12:00:00.000Z');
  assert.equal(backup.formatVersion, 1); assert.deepEqual(backup.data, persisted);
  assert.deepEqual(Schema.parseV5Backup(JSON.stringify(backup)).data, runtime);
  const snapshot = Schema.buildV5Snapshot(runtime, {
    createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'pre-import'
  });
  assert.equal(snapshot.formatVersion, 1); assert.deepEqual(snapshot.data, persisted);
  assert.deepEqual(Schema.parseV5Snapshot(JSON.stringify(snapshot)).data, runtime);
  expectCode('MISSING_FIELD', () => Schema.buildV5Backup(makeV3WithTemplates(), '2026-01-15T12:00:00.000Z'));
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.parseV5Backup(JSON.stringify(Schema.buildV4Backup(
    makeV3WithTemplates(), '2026-01-15T12:00:00.000Z'))));
});

test('schema v6 migration adds only empty accounts and null references without changing schema 5 semantics', () => {
  const v5 = Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates()));
  v5.months[Object.keys(v5.months)[0]].expenses[0].cleared = true;
  const before = JSON.stringify(v5);
  const v6 = Schema.migrateV5ToV6(v5);
  assert.equal(v6.schemaVersion, 6);
  assert.deepEqual(v6.settings.accounts, []);
  assert.equal(v6.templates.income.every(item => item.accountId === null), true);
  assert.equal(v6.templates.expenses.every(item => item.accountId === null), true);
  assert.equal(Object.values(v6.months).every(month => [...month.paychecks, ...month.expenses].every(item => item.accountId === null)), true);
  assert.equal(JSON.stringify(v5), before);
  assert.equal(Schema.validateV6(v6), true);
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateV5ToV6(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates())));
});

test('schema v6 validates account references, payment compatibility, and archived historical references', () => {
  const persisted = Schema.migrateV5ToV6(Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates())));
  persisted.settings.accounts.push(
    { id: 'account-bank', name: 'House Checking', kind: 'bank', archived: true },
    { id: 'account-card', name: 'House Card', kind: 'credit_card', archived: false }
  );
  persisted.templates.income[0].accountId = 'account-bank';
  persisted.templates.expenses[0].accountId = 'account-bank';
  const month = persisted.months[Object.keys(persisted.months)[0]];
  month.paychecks[0].accountId = 'account-bank'; month.expenses[0].accountId = 'account-bank';
  assert.equal(Schema.validateV6(persisted), true);
  const dangling = structuredClone(persisted); dangling.templates.income[0].accountId = 'account-missing';
  expectCode('DANGLING_ACCOUNT_REFERENCE', () => Schema.validateV6(dangling));
  const incompatibleExpense = structuredClone(persisted); incompatibleExpense.months[Object.keys(incompatibleExpense.months)[0]].expenses[0].accountId = 'account-card';
  expectCode('INCOMPATIBLE_ACCOUNT_KIND', () => Schema.validateV6(incompatibleExpense));
  const incompatibleIncome = structuredClone(persisted); incompatibleIncome.templates.income[0].accountId = 'account-card';
  expectCode('INCOMPATIBLE_ACCOUNT_KIND', () => Schema.validateV6(incompatibleIncome));
  const duplicate = structuredClone(persisted); duplicate.settings.accounts.push({ id: 'account-other', name: 'House Checking', kind: 'other', archived: false });
  expectCode('DUPLICATE_VALUE', () => Schema.validateV6(duplicate));
});

test('schema v6 active, backup, snapshot, and sharded codecs preserve accounts and references', () => {
  const persisted = Schema.migrateV5ToV6(Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates())));
  persisted.settings.accounts.push({ id: 'account-bank', name: 'House Checking', kind: 'bank', archived: false });
  persisted.templates.income[0].accountId = 'account-bank';
  const runtime = Schema.hydrateV6ExactMoney(persisted);
  assert.deepEqual(Schema.dehydrateV6ExactMoney(runtime), persisted);
  assert.deepEqual(Schema.parseV6Active(JSON.stringify(persisted)), runtime);
  const backup = Schema.buildV6Backup(runtime, '2026-01-15T12:00:00.000Z');
  assert.equal(backup.formatVersion, 1); assert.deepEqual(Schema.parseV6Backup(JSON.stringify(backup)).data, runtime);
  const snapshot = Schema.buildV6Snapshot(runtime, { createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'pre-accounts' });
  assert.equal(snapshot.formatVersion, 1); assert.deepEqual(Schema.parseV6Snapshot(JSON.stringify(snapshot)).data, runtime);
  const parts = Schema.buildShardedFragments(runtime, 6);
  assert.deepEqual(Schema.assembleShardedActiveData(parts.global, parts.months, 6), runtime);
});

test('schema v7 migration adds actual-account fields only to saved records and preserves format-v1 codecs', () => {
  const v6 = Schema.migrateV5ToV6(Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates())));
  const before = JSON.stringify(v6); const v7 = Schema.migrateV6ToV7(v6);
  assert.equal(v7.schemaVersion, 7); assert.equal(JSON.stringify(v6), before);
  assert.equal(Object.values(v7.months).every(month => [...month.paychecks, ...month.expenses]
    .every(record => record.actualAccountId === null)), true);
  assert.equal(Object.hasOwn(v7.templates.income[0], 'actualAccountId'), false);
  assert.equal(Object.hasOwn(v7.templates.expenses[0], 'actualAccountId'), false);
  const runtime = Schema.hydrateV7ExactMoney(v7);
  assert.deepEqual(Schema.dehydrateV7ExactMoney(runtime), v7);
  const backup = Schema.buildV7Backup(runtime, '2026-01-15T12:00:00.000Z');
  assert.equal(backup.formatVersion, 1); assert.deepEqual(Schema.parseV7Backup(JSON.stringify(backup)).data, runtime);
  const snapshot = Schema.buildV7Snapshot(runtime, { createdAt: '2026-01-15T12:00:00.000Z', localDate: '2026-01-15', reason: 'pre-actual-accounts' });
  assert.equal(snapshot.formatVersion, 1); assert.deepEqual(Schema.parseV7Snapshot(JSON.stringify(snapshot)).data, runtime);
  const parts = Schema.buildShardedFragments(runtime, 7);
  assert.deepEqual(Schema.assembleShardedActiveData(parts.global, parts.months, 7), runtime);
});

test('schema v7 strictly validates actual-account eligibility and compatibility', () => {
  const v7 = Schema.migrateV6ToV7(Schema.migrateV5ToV6(Schema.migrateV4ToV5(Schema.migrateV3ToV4ExactMoney(makeV3WithTemplates()))));
  v7.settings.accounts.push(
    { id: 'account-bank', name: 'House Checking', kind: 'bank', archived: true },
    { id: 'account-card', name: 'House Card', kind: 'credit_card', archived: false }
  );
  const monthKey = Object.keys(v7.months)[0]; const month = v7.months[monthKey];
  month.paychecks[0].actualAmount = 100; month.paychecks[0].date = `${monthKey}-01`; month.paychecks[0].actualAccountId = 'account-bank';
  month.expenses[0].actualAmount = 100; month.expenses[0].date = `${monthKey}-02`; month.expenses[0].actualAccountId = 'account-bank';
  assert.equal(Schema.validateV7(v7), true);
  const noAmount = structuredClone(v7); noAmount.months[Object.keys(noAmount.months)[0]].paychecks[0].actualAmount = null;
  expectCode('INELIGIBLE_ACTUAL_ACCOUNT_REFERENCE', () => Schema.validateV7(noAmount));
  const noDate = structuredClone(v7); noDate.months[Object.keys(noDate.months)[0]].expenses[0].date = '';
  expectCode('INELIGIBLE_ACTUAL_ACCOUNT_REFERENCE', () => Schema.validateV7(noDate));
  const incompatible = structuredClone(v7); incompatible.months[Object.keys(incompatible.months)[0]].expenses[0].actualAccountId = 'account-card';
  expectCode('INCOMPATIBLE_ACCOUNT_KIND', () => Schema.validateV7(incompatible));
  const templateField = structuredClone(v7); templateField.templates.income[0].actualAccountId = null;
  expectCode('UNKNOWN_FIELD', () => Schema.validateV7(templateField));
});

test('legacy migration rejects missing months and backfills missing month collections', () => {
  expectCode('MISSING_FIELD', () => Schema.migrateActive({ categories: [], settings: { earners: [] } }));
  const legacy = {
    categories: [],
    settings: { earners: [] },
    months: { '2026-01': {} }
  };
  assert.deepEqual(Schema.migrateActive(legacy).months['2026-01'], {
    paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 },
    suppressedOccurrences: []
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
  expectCode('AGGREGATE_OUT_OF_RANGE', () => validateV1Input(budget));
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
    assert.throws(() => validateV1Input(budget), error => error.code === code, label);
  }
});

test('accepts boundary sizes and rejects collection limits plus one', () => {
  const categoryBoundary = makeBudget();
  categoryBoundary.categories = Array.from({ length: 100 }, (_, i) => ({ name: `Category ${i}`, items: [] }));
  categoryBoundary.months['2026-01'].expenses[0].category = 'Category 0';
  assert.equal(validateV1Input(categoryBoundary), true);
  const categoryOverflow = makeBudget();
  categoryOverflow.categories = Array.from({ length: 101 }, (_, i) => ({ name: `Category ${i}`, items: [] }));
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(categoryOverflow));

  const itemOverflow = makeBudget(); itemOverflow.categories[0].items = Array.from({ length: 201 }, (_, i) => `Item ${i}`);
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(itemOverflow));
  const earnerOverflow = makeBudget(); earnerOverflow.settings.earners = Array.from({ length: 51 }, (_, i) => `Earner ${i}`);
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(earnerOverflow));

  const itemBoundary = makeBudget(); itemBoundary.categories[0].items = Array.from({ length: 200 }, (_, i) => `Item ${i}`);
  assert.equal(validateV1Input(itemBoundary), true);
  const earnerBoundary = makeBudget(); earnerBoundary.settings.earners = Array.from({ length: 50 }, (_, i) => `Earner ${i}`);
  earnerBoundary.months['2026-01'].paychecks[0].earner = 'Earner 0';
  assert.equal(validateV1Input(earnerBoundary), true);

  const monthOverflow = makeBudget(); monthOverflow.months = {};
  for (let i = 0; i < 601; i += 1) {
    const year = 2000 + Math.floor(i / 12); const month = String((i % 12) + 1).padStart(2, '0');
    monthOverflow.months[`${year}-${month}`] = { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 } };
  }
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(monthOverflow));
  delete monthOverflow.months['2050-01'];
  assert.equal(Object.keys(monthOverflow.months).length, 600);
  assert.equal(validateV1Input(monthOverflow), true);

  const paycheckOverflow = makeBudget(); paycheckOverflow.months['2026-01'].paychecks = Array.from({ length: 501 }, (_, i) => ({
    id: `p${i}`, earner: 'Example Earner', amount: 1, date: ''
  })); paycheckOverflow.months['2026-01'].expenses = [];
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(paycheckOverflow));
  paycheckOverflow.months['2026-01'].paychecks.pop();
  assert.equal(validateV1Input(paycheckOverflow), true);

  const expenseOverflow = makeBudget(); expenseOverflow.months['2026-01'].paychecks = [];
  expenseOverflow.months['2026-01'].expenses = Array.from({ length: 5001 }, (_, i) => ({
    id: `e${i}`, category: 'Home', name: 'Item', paycheckAmounts: {}, actual: 0, paymentMethod: 'bank'
  }));
  expectCode('TOO_MANY_ITEMS', () => validateV1Input(expenseOverflow));
  expenseOverflow.months['2026-01'].expenses.pop();
  assert.equal(validateV1Input(expenseOverflow), true);
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
  assert.equal(validateV1Input(stringBoundary), true);
  const nameOverflow = makeBudget(); nameOverflow.categories[0].name = 'n'.repeat(121);
  expectCode('INVALID_STRING', () => validateV1Input(nameOverflow));
  const idOverflow = makeBudget(); idOverflow.months['2026-01'].paychecks[0].id = 'p'.repeat(129);
  expectCode('INVALID_STRING', () => validateV1Input(idOverflow));

  const moneyBoundary = makeBudget();
  const month = moneyBoundary.months['2026-01'];
  month.paychecks[0].amount = 1_000_000_000_000;
  month.expenses[0].paycheckAmounts = {}; month.expenses[0].actual = 0;
  month.allocations = { savings: 0, credit_card_debt: 0, investments: 0 };
  assert.equal(validateV1Input(moneyBoundary), true);
  const moneyOverflow = makeBudget(); moneyOverflow.months['2026-01'].expenses[0].actual = 1_000_000_000_001;
  expectCode('AMOUNT_OUT_OF_RANGE', () => validateV1Input(moneyOverflow));
  const paycheckZero = makeBudget(); paycheckZero.months['2026-01'].paychecks[0].amount = 0;
  expectCode('AMOUNT_OUT_OF_RANGE', () => validateV1Input(paycheckZero));
});

test('rejects unsafe keys at nested depths from JSON input', () => {
  const category = makeBudget();
  category.categories[0] = JSON.parse('{"name":"Home","items":[],"__proto__":{}}');
  expectCode('UNSAFE_KEY', () => validateV1Input(category));
  const amounts = makeBudget();
  amounts.months['2026-01'].expenses[0].paycheckAmounts = JSON.parse('{"__proto__":10}');
  expectCode('UNSAFE_KEY', () => validateV1Input(amounts));
  const monthMap = makeBudget();
  monthMap.months = JSON.parse('{"constructor":{}}');
  expectCode('UNSAFE_KEY', () => validateV1Input(monthMap));
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
  expectCode('DUPLICATE_VALUE', () => validateV1Input(categories));
  const paychecks = makeBudget(); paychecks.months['2026-01'].paychecks.push({
    id: 'paycheck-example-1', earner: 'Example Earner', amount: 1, date: ''
  });
  expectCode('DUPLICATE_ID', () => validateV1Input(paychecks));
  const expenses = makeBudget(); expenses.months['2026-01'].expenses.push({
    ...expenses.months['2026-01'].expenses[0], paycheckAmounts: {}
  });
  expectCode('DUPLICATE_ID', () => validateV1Input(expenses));
  const dangling = makeBudget(); dangling.months['2026-01'].expenses[0].paycheckAmounts = { missing: 0 };
  expectCode('DANGLING_PAYCHECK_REFERENCE', () => validateV1Input(dangling));
});

test('rejects blocked identifier values before they can become dynamic keys', () => {
  for (const blocked of ['__proto__', 'prototype', 'constructor']) {
    const paycheck = makeBudget();
    paycheck.months['2026-01'].paychecks[0].id = blocked;
    paycheck.months['2026-01'].expenses[0].paycheckAmounts = {};
    expectCode('UNSAFE_IDENTIFIER', () => validateV1Input(paycheck));

    const expense = makeBudget();
    expense.months['2026-01'].expenses[0].id = blocked;
    expectCode('UNSAFE_IDENTIFIER', () => validateV1Input(expense));
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
  assert.equal(validateV1Input(budget), true);
});

test('classic-script and CommonJS expose the exact same public API and behavior', () => {
  const source = fs.readFileSync(require.resolve('../js/data-schema.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename: 'data-schema.js' });
  const browserApi = context.ZeroBudgetSchema;
  const expectedKeys = [
    'ACTIVE_SCHEMA_POLICY', 'BACKUP_FORMAT', 'BACKUP_FORMAT_VERSION', 'DataError', 'SCHEMA_VERSION', 'SNAPSHOT_FORMAT',
    'SNAPSHOT_FORMAT_VERSION', 'V2_SCHEMA_VERSION', 'V3_SCHEMA_POLICY', 'V3_SCHEMA_VERSION', 'V4_SCHEMA_POLICY', 'V4_SCHEMA_VERSION',
    'V5_SCHEMA_POLICY', 'V5_SCHEMA_VERSION', 'V6_SCHEMA_POLICY', 'V6_SCHEMA_VERSION', 'V7_SCHEMA_POLICY', 'V7_SCHEMA_VERSION',
    'assembleShardedActiveData', 'buildActiveData', 'buildBackup', 'buildShardedFragments', 'buildSnapshot',
    'buildV4Backup', 'buildV4Snapshot', 'buildV5Backup', 'buildV5Snapshot', 'buildV6Backup', 'buildV6Snapshot', 'buildV7Backup', 'buildV7Snapshot',
    'centsToDecimalMoney', 'clone', 'decimalMoneyToCents', 'dehydrateV4ExactMoney', 'dehydrateV5ExactMoney', 'dehydrateV6ExactMoney', 'dehydrateV7ExactMoney',
    'hydrateV4ExactMoney', 'hydrateV5ExactMoney', 'hydrateV6ExactMoney', 'hydrateV7ExactMoney', 'migrateActive', 'migrateToV2', 'migrateToV3',
    'migrateV3ToV4ExactMoney', 'migrateV4ToV5', 'migrateV5ToV6', 'migrateV6ToV7', 'parseActive', 'parseActiveData', 'parseBackup', 'parseSnapshot',
    'parseV4Active', 'parseV4Backup', 'parseV4Snapshot', 'parseV5Active', 'parseV5Backup', 'parseV5Snapshot', 'parseV6Active', 'parseV6Backup', 'parseV6Snapshot', 'parseV7Active', 'parseV7Backup', 'parseV7Snapshot',
    'validateActive', 'validateGlobalFragment', 'validateMonthFragment', 'validateShardedFragments',
    'validateV2', 'validateV3', 'validateV4', 'validateV5', 'validateV6', 'validateV7'
  ].sort();
  assert.deepEqual(Object.keys(Schema).sort(), expectedKeys);
  assert.deepEqual(Array.from(Object.keys(browserApi).sort()), expectedKeys);
  const text = JSON.stringify(makeBudget());
  assert.equal(JSON.stringify(browserApi.parseActive(text)), JSON.stringify(Schema.parseActive(text)));
  assert.equal(browserApi.BACKUP_FORMAT, Schema.BACKUP_FORMAT);
  context.activeText = text;
  const browserV2 = vm.runInContext('ZeroBudgetSchema.migrateToV2(JSON.parse(activeText))', context);
  assert.equal(JSON.stringify(browserV2), JSON.stringify(Schema.migrateToV2(JSON.parse(text))));
  assert.equal(JSON.stringify(browserApi.migrateToV3(browserApi.parseActive(text))), JSON.stringify(Schema.migrateToV3(JSON.parse(text))));
});

test('explicit v2 migration matches its exact golden deterministically without mutating v1', () => {
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
  assert.equal(Schema.SCHEMA_VERSION, 3);
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

test('v3 migration matches its golden deterministically without mutating v2', () => {
  const source = readFixture('schema-v2-golden.json');
  const golden = readFixture('schema-v3-golden.json');
  const before = JSON.stringify(source);
  const first = Schema.migrateToV3(source);
  const second = Schema.migrateToV3(structuredClone(source));
  assert.deepEqual(first, golden);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(source), before);
  assert.equal(Schema.validateV3(first), true);
  assert.equal(Schema.SCHEMA_VERSION, 3);
  assert.equal(Schema.V3_SCHEMA_VERSION, 3);
});

test('v0 and v1 migrate through v2 to v3 with exact amount semantics', () => {
  for (const legacy of [makeBudget(), (() => { const value = makeBudget(); delete value.schemaVersion; return value; })()]) {
    legacy.months['2026-01'].expenses[0].actual = 0;
    const migrated = Schema.migrateToV3(legacy);
    const paycheck = migrated.months['2026-01'].paychecks[0];
    const expense = migrated.months['2026-01'].expenses[0];
    assert.equal(paycheck.plannedAmount, 2500);
    assert.equal(paycheck.actualAmount, 2500);
    assert.equal(expense.plannedAmount, 1200);
    assert.equal(expense.actualAmount, null);
    assert.equal(expense.date, '');
    assert.equal(paycheck.sourceTemplateId, null);
    assert.equal(expense.occurrenceKey, null);
    assert.deepEqual(migrated.templates, { income: [], expenses: [] });
    assert.deepEqual(migrated.months['2026-01'].suppressedOccurrences, []);
  }
});

test('v3 migration deterministically clears a valid legacy cross-month paycheck date', () => {
  const source = readFixture('schema-v2-golden.json');
  source.months['2027-03'].paychecks[0].date = '2027-04-01';
  const before = JSON.stringify(source);
  assert.equal(Schema.validateV2(source), true);
  const first = Schema.migrateToV3(source);
  const second = Schema.migrateToV3(structuredClone(source));
  assert.equal(first.months['2027-03'].paychecks[0].date, '');
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(source), before);
  assert.equal(Schema.validateV3(first), true);
});

test('native v3 validates templates, archived references, recurrence unions, and detached cloning', () => {
  const source = makeV3WithTemplates();
  source.categories[0].archived = true;
  source.categories[0].items[0].archived = true;
  source.settings.earners[0].archived = true;
  assert.equal(Schema.validateV3(source), true);
  const migrated = Schema.migrateToV3(source);
  assert.deepEqual(migrated, source);
  migrated.templates.income[0].name = 'Changed';
  assert.equal(source.templates.income[0].name, 'Example income');

  for (const recurrence of [
    { cadence: 'monthly', day: 31 },
    { cadence: 'twice-monthly', days: [1, 31] },
    { cadence: 'weekly', anchorDate: '2024-02-29' },
    { cadence: 'weekly', anchorDate: '0000-02-29' },
    { cadence: 'biweekly', anchorDate: '2100-02-28' }
  ]) {
    const candidate = makeV3WithTemplates(); candidate.templates.income[0].recurrence = recurrence;
    assert.equal(Schema.validateV3(candidate), true);
  }
});

test('v3 enforces exact template keys, types, dates, recurrence ranges, and cross-kind IDs', () => {
  const cases = [
    ['UNKNOWN_FIELD', v => { v.templates.income[0].extra = true; }],
    ['MISSING_FIELD', v => { delete v.templates.expenses[0].enabled; }],
    ['EXPECTED_BOOLEAN', v => { v.templates.income[0].enabled = 1; }],
    ['MISSING_FIELD', v => { delete v.months['2027-03'].expenses[0].date; }],
    ['INVALID_DATE', v => { v.months['2027-03'].expenses[0].date = '2027-02-30'; }],
    ['INVALID_DATE_RANGE', v => { v.templates.income[0].endDate = '2026-12-31'; }],
    ['INVALID_RECURRENCE_DAY', v => { v.templates.income[0].recurrence = { cadence: 'monthly', day: 0 }; }],
    ['INVALID_RECURRENCE_DAYS', v => { v.templates.income[0].recurrence = { cadence: 'twice-monthly', days: [15, 15] }; }],
    ['INVALID_RECURRENCE_CADENCE', v => { v.templates.income[0].recurrence = { cadence: 'yearly' }; }],
    ['DUPLICATE_ID', v => { v.templates.expenses[0].id = v.templates.income[0].id; }],
    ['DANGLING_EARNER_REFERENCE', v => { v.templates.income[0].earnerId = 'missing'; }],
    ['DANGLING_CATEGORY_REFERENCE', v => { v.templates.expenses[0].categoryId = 'missing'; }],
    ['DANGLING_CATEGORY_ITEM_REFERENCE', v => { v.templates.expenses[0].categoryItemId = 'migrated-item-0001-0002'; v.templates.expenses[0].categoryId = 'migrated-category-0002'; }]
  ];
  for (const [code, mutate] of cases) {
    const v3 = makeV3WithTemplates(); mutate(v3);
    expectCode(code, () => Schema.validateV3(v3));
  }
});

test('v3 enforces planned, actual, allocation, provenance, and occurrence uniqueness rules', () => {
  const valid = makeV3WithTemplates();
  const paycheck = valid.months['2027-03'].paychecks[0];
  paycheck.sourceTemplateId = 'income-template-1'; paycheck.occurrenceKey = '2027-03-12#0001';
  const expense = valid.months['2027-03'].expenses[0];
  expense.date = '2027-03-01'; expense.sourceTemplateId = 'expense-template-1'; expense.occurrenceKey = '2027-03-01#0001';
  valid.months['2027-03'].suppressedOccurrences.push({ sourceTemplateId: 'expense-template-1', occurrenceKey: '2027-03-31#0001' });
  assert.equal(Schema.validateV3(valid), true);

  const cases = [
    ['INVALID_PROVENANCE_PAIR', v => { v.months['2027-03'].paychecks[0].sourceTemplateId = 'income-template-1'; }],
    ['DANGLING_TEMPLATE_REFERENCE', v => { v.months['2027-03'].paychecks[0].sourceTemplateId = 'expense-template-1'; v.months['2027-03'].paychecks[0].occurrenceKey = '2027-03-01#0001'; }],
    ['INVALID_OCCURRENCE_KEY', v => { v.months['2027-03'].expenses[0].sourceTemplateId = 'expense-template-1'; v.months['2027-03'].expenses[0].occurrenceKey = '2027-03-01#0000'; }],
    ['GENERATED_DATE_MISMATCH', v => { v.months['2027-03'].paychecks[0].sourceTemplateId = 'income-template-1'; v.months['2027-03'].paychecks[0].occurrenceKey = '2027-03-12#0001'; v.months['2027-03'].paychecks[0].date = '2027-03-25'; }],
    ['GENERATED_DATE_MISMATCH', v => { v.months['2027-03'].expenses[0].sourceTemplateId = 'expense-template-1'; v.months['2027-03'].expenses[0].occurrenceKey = '2027-03-01#0001'; v.months['2027-03'].expenses[0].date = ''; }],
    ['RECORD_MONTH_MISMATCH', v => { v.months['2027-03'].paychecks[0].date = '2027-04-01'; }],
    ['RECORD_MONTH_MISMATCH', v => { v.months['2027-03'].expenses[0].date = '2027-02-28'; }],
    ['OCCURRENCE_MONTH_MISMATCH', v => { v.months['2027-03'].expenses[0].sourceTemplateId = 'expense-template-1'; v.months['2027-03'].expenses[0].occurrenceKey = '2027-04-01#0001'; }],
    ['OCCURRENCE_MONTH_MISMATCH', v => { v.months['2027-03'].suppressedOccurrences.push({ sourceTemplateId: 'income-template-1', occurrenceKey: '2027-02-28#0001' }); }],
    ['ALLOCATION_EXCEEDS_PLANNED', v => { v.months['2027-03'].expenses[0].plannedAmount = 974; }],
    ['AMOUNT_OUT_OF_RANGE', v => { v.months['2027-03'].paychecks[0].actualAmount = -1; }],
    ['DUPLICATE_OCCURRENCE', v => {
      v.months['2027-03'].paychecks[0].sourceTemplateId = 'income-template-1';
      v.months['2027-03'].paychecks[0].occurrenceKey = '2027-03-12#0001';
      v.months['2027-03'].suppressedOccurrences.push({ sourceTemplateId: 'income-template-1', occurrenceKey: '2027-03-12#0001' });
    }]
  ];
  for (const [code, mutate] of cases) {
    const v3 = makeV3WithTemplates(); mutate(v3);
    expectCode(code, () => Schema.validateV3(v3));
  }
});

test('active v3 APIs accept v0 through v3 while explicit v2 compatibility remains isolated', () => {
  const v2 = readFixture('schema-v2-golden.json'); const v3 = readFixture('schema-v3-golden.json');
  assert.equal(Schema.validateActive(v3), true);
  assert.deepEqual(Schema.migrateActive(v3), v3);
  assert.deepEqual(Schema.parseActive(JSON.stringify(v3)), v3);
  expectCode('MISSING_FIELD', () => Schema.validateActive(v2));
  assert.equal(Schema.migrateActive(v2).schemaVersion, 3);
  assert.equal(Schema.buildBackup(v2, '2027-03-01T00:00:00.000Z').data.schemaVersion, 3);
  assert.equal(Schema.buildBackup(v3, '2027-03-01T00:00:00.000Z').data.schemaVersion, 3);
  assert.equal(Schema.validateV2(v2), true);
  assert.deepEqual(Schema.migrateToV2(v2), v2);
  const future = structuredClone(v3); future.schemaVersion = 4;
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.migrateToV3(future));
});

test('schema policies are frozen, coherent, and retain their DataError and clone references', () => {
  const active = Schema.ACTIVE_SCHEMA_POLICY; const v3 = Schema.V3_SCHEMA_POLICY;
  assert.equal(Object.isFrozen(active), true);
  assert.equal(Object.isFrozen(v3), true);
  assert.equal(active.SCHEMA_VERSION, 3);
  assert.equal(v3.SCHEMA_VERSION, 3);
  assert.equal(active.DataError, Schema.DataError);
  assert.equal(v3.DataError, Schema.DataError);
  assert.equal(active.clone, Schema.clone);
  assert.equal(v3.clone, Schema.clone);
  assert.equal(active.migrateActive, Schema.migrateActive);
  assert.equal(v3.migrateActive, Schema.migrateToV3);
  assert.equal(active.validateActive, Schema.validateActive);
  assert.equal(v3.validateActive, Schema.validateV3);
});

test('v3 policy migrates and parses detached v0 through v3 data', () => {
  const v1 = makeBudget(); const v0 = structuredClone(v1); delete v0.schemaVersion;
  const v2 = readFixture('schema-v2-golden.json'); const v3 = readFixture('schema-v3-golden.json');
  for (const source of [v0, v1, v2, v3]) {
    const before = JSON.stringify(source);
    const migrated = Schema.V3_SCHEMA_POLICY.migrateActive(source);
    const parsed = Schema.V3_SCHEMA_POLICY.parseActive(JSON.stringify(source));
    assert.equal(migrated.schemaVersion, 3);
    assert.deepEqual(parsed, migrated);
    assert.notEqual(migrated, source);
    assert.equal(JSON.stringify(source), before);
    const detached = Schema.V3_SCHEMA_POLICY.clone(migrated);
    detached.categories[0].name = 'Changed';
    assert.notEqual(detached.categories[0].name, migrated.categories[0].name);
  }
});

test('v3 policy builds and parses format-v1 backups and snapshots containing v0 through v3', () => {
  const v1 = makeBudget(); const v0 = structuredClone(v1); delete v0.schemaVersion;
  const inputs = [v0, v1, readFixture('schema-v2-golden.json'), readFixture('schema-v3-golden.json')];
  for (const source of inputs) {
    const builtBackup = Schema.V3_SCHEMA_POLICY.buildBackup(source, '2027-03-01T00:00:00.000Z');
    assert.equal(builtBackup.formatVersion, 1);
    assert.equal(builtBackup.data.schemaVersion, 3);
    assert.deepEqual(Schema.V3_SCHEMA_POLICY.parseBackup(JSON.stringify(builtBackup)), builtBackup);
    const legacyBackup = {
      format: Schema.BACKUP_FORMAT, formatVersion: 1,
      exportedAt: '2027-03-01T00:00:00.000Z', data: source
    };
    assert.equal(Schema.V3_SCHEMA_POLICY.parseBackup(JSON.stringify(legacyBackup)).data.schemaVersion, 3);
    for (const reason of ['daily', 'pre-import', 'pre-sharding', 'pre-reset']) {
      const built = Schema.V3_SCHEMA_POLICY.buildSnapshot(source, {
        createdAt: '2027-03-01T00:00:00.000Z', localDate: '2027-03-01', reason
      });
      assert.equal(built.formatVersion, 1);
      assert.equal(built.data.schemaVersion, 3);
      assert.deepEqual(Schema.V3_SCHEMA_POLICY.parseSnapshot(JSON.stringify(built)), built);
      const legacySnapshot = {
        format: Schema.SNAPSHOT_FORMAT, formatVersion: 1,
        createdAt: '2027-03-01T00:00:00.000Z', localDate: '2027-03-01', reason, data: source
      };
      assert.equal(Schema.V3_SCHEMA_POLICY.parseSnapshot(JSON.stringify(legacySnapshot)).data.schemaVersion, 3);
    }
  }
});

test('v3 policy rejects future active and embedded versions', () => {
  const future = readFixture('schema-v3-golden.json'); future.schemaVersion = 4;
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.V3_SCHEMA_POLICY.migrateActive(future));
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.V3_SCHEMA_POLICY.parseActive(JSON.stringify(future)));
  const backup = {
    format: Schema.BACKUP_FORMAT, formatVersion: 1,
    exportedAt: '2027-03-01T00:00:00.000Z', data: future
  };
  expectCode('UNSUPPORTED_SCHEMA_VERSION', () => Schema.V3_SCHEMA_POLICY.parseBackup(JSON.stringify(backup)));
});

test('active v3 policy is behavior and serialization equivalent to existing active functions', () => {
  const source = makeBudget(); const timestamp = '2027-03-01T00:00:00.000Z';
  assert.equal(JSON.stringify(Schema.ACTIVE_SCHEMA_POLICY.migrateActive(source)), JSON.stringify(Schema.migrateActive(source)));
  assert.equal(JSON.stringify(Schema.ACTIVE_SCHEMA_POLICY.parseActive(JSON.stringify(source))), JSON.stringify(Schema.parseActive(JSON.stringify(source))));
  assert.equal(JSON.stringify(Schema.ACTIVE_SCHEMA_POLICY.buildBackup(source, timestamp)), JSON.stringify(Schema.buildBackup(source, timestamp)));
  const snapshotMetadata = { createdAt: timestamp, localDate: '2027-03-01', reason: 'daily' };
  assert.equal(JSON.stringify(Schema.ACTIVE_SCHEMA_POLICY.buildSnapshot(source, snapshotMetadata)),
    JSON.stringify(Schema.buildSnapshot(source, snapshotMetadata)));
  assert.equal(Schema.ACTIVE_SCHEMA_POLICY.validateActive(readFixture('schema-v3-golden.json')), true);
});

test('active validation is strict v3 while parsers and legacy envelopes migrate to v3', () => {
  const v2 = readFixture('schema-v2-golden.json'); const v3 = readFixture('schema-v3-golden.json');
  assert.equal(Schema.validateActive(v3), true);
  expectCode('MISSING_FIELD', () => Schema.validateActive(v2));
  assert.deepEqual(Schema.parseActive(JSON.stringify(v3)), v3);
  assert.equal(Schema.parseActive(JSON.stringify(makeBudget())).schemaVersion, 3);
  const backup = { format: Schema.BACKUP_FORMAT, formatVersion: Schema.BACKUP_FORMAT_VERSION, exportedAt: '2027-03-01T00:00:00.000Z', data: makeBudget() };
  assert.equal(Schema.parseBackup(JSON.stringify(backup)).data.schemaVersion, 3);
  assert.equal(Schema.buildBackup(makeBudget(), '2027-03-01T00:00:00.000Z').data.schemaVersion, 3);
  const snapshot = {
    format: Schema.SNAPSHOT_FORMAT, formatVersion: Schema.SNAPSHOT_FORMAT_VERSION,
    createdAt: '2027-03-01T00:00:00.000Z', localDate: '2027-03-01', reason: 'daily', data: makeBudget()
  };
  assert.equal(Schema.parseSnapshot(JSON.stringify(snapshot)).data.schemaVersion, 3);
  assert.equal(Schema.buildSnapshot(makeBudget(), {
    createdAt: '2027-03-01T00:00:00.000Z', localDate: '2027-03-01', reason: 'daily'
  }).data.schemaVersion, 3);
  assert.equal(Schema.BACKUP_FORMAT_VERSION, 1);
  assert.equal(Schema.SNAPSHOT_FORMAT_VERSION, 1);
});

test('format-v1 backup and snapshot parsers migrate embedded v0 through v3 data', () => {
  const v1 = makeBudget();
  const v0 = structuredClone(v1); delete v0.schemaVersion;
  const v2 = Schema.migrateToV2(v1);
  const v3 = Schema.migrateToV3(v2);
  for (const embedded of [v0, v1, v2, v3]) {
    const backup = {
      format: Schema.BACKUP_FORMAT,
      formatVersion: 1,
      exportedAt: '2027-03-01T00:00:00.000Z',
      data: embedded
    };
    assert.equal(Schema.parseBackup(JSON.stringify(backup)).data.schemaVersion, 3);
    for (const reason of ['daily', 'pre-import', 'pre-sharding', 'pre-reset']) {
      const snapshot = {
        format: Schema.SNAPSHOT_FORMAT,
        formatVersion: 1,
        createdAt: '2027-03-01T00:00:00.000Z',
        localDate: '2027-03-01',
        reason,
        data: embedded
      };
      assert.equal(Schema.parseSnapshot(JSON.stringify(snapshot)).data.schemaVersion, 3);
    }
  }
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
