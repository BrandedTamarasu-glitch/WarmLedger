'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Schema = require('../js/data-schema.js');
const {
  SAMPLE_IDS, MemoryStorage, makeBudget, makeV1Budget, makeV2Budget, makeV3Budget,
  makeClock, makeUuid
} = require('./helpers.js');

test('budget fixtures expose explicit canonical schema generations', () => {
  const v1 = makeV1Budget();
  const compatibilityV1 = makeBudget();
  const v2 = makeV2Budget();
  const v3 = makeV3Budget();

  assert.deepEqual(compatibilityV1, v1);
  assert.notEqual(compatibilityV1, v1);
  assert.equal(v1.schemaVersion, 1);
  assert.equal(v2.schemaVersion, 2);
  assert.equal(v3.schemaVersion, 3);
  Schema.validateV2(v2);
  Schema.validateV3(v3);
  assert.deepEqual(v3.months['2026-01'].paychecks[0], {
    id: SAMPLE_IDS.paycheck, earnerId: 'earner-example-1', earner: 'Example Earner',
    plannedAmount: 2500, actualAmount: 2500, date: '2026-01-15',
    sourceTemplateId: null, occurrenceKey: null
  });
  assert.equal(v3.months['2026-01'].expenses[0].date, '');
  assert.deepEqual(v3.templates, { income: [], expenses: [] });
  assert.deepEqual(v3.months['2026-01'].suppressedOccurrences, []);
});

test('MemoryStorage follows string Web Storage semantics and logs no values', () => {
  const storage = new MemoryStorage({ initial: 1 });
  assert.equal(storage.length, 1);
  assert.equal(storage.key(0), 'initial');
  assert.equal(storage.getItem('initial'), '1');
  storage.setItem(2, 3);
  assert.equal(storage.getItem('2'), '3');
  assert.deepEqual(Object.keys(storage.operations.at(-1)).sort(), ['key', 'op']);
  storage.removeItem(2);
  assert.equal(storage.getItem('2'), null);
});

test('MemoryStorage supports one-shot and persistent key/prefix faults', () => {
  const storage = new MemoryStorage();
  storage.fail({ op: 'setItem', key: 'once', name: 'QuotaExceededError', once: true });
  assert.throws(() => storage.setItem('once', 'value'), error => error.name === 'QuotaExceededError');
  storage.setItem('once', 'value');
  storage.fail({ op: 'removeItem', prefix: 'snap:', name: 'SecurityError' });
  assert.throws(() => storage.removeItem('snap:1'), error => error.name === 'SecurityError');
  assert.throws(() => storage.removeItem('snap:2'), error => error.name === 'SecurityError');
});

test('deterministic clock can set and advance without leaking its Date object', () => {
  const clock = makeClock();
  const first = clock(); first.setUTCFullYear(2000);
  assert.equal(clock().toISOString(), '2026-01-15T12:00:00.000Z');
  clock.advance(1000);
  assert.equal(clock().toISOString(), '2026-01-15T12:00:01.000Z');
  clock.set('2027-02-01T00:00:00.000Z');
  assert.equal(clock().toISOString(), '2027-02-01T00:00:00.000Z');
});

test('deterministic UUID source returns queued IDs and fails when exhausted', () => {
  const uuid = makeUuid('one', 'two');
  assert.equal(uuid(), 'one');
  assert.equal(uuid(), 'two');
  assert.throws(() => uuid(), /queue exhausted/);
});
