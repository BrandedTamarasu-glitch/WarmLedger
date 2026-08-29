'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStorage, makeClock, makeUuid } = require('./helpers.js');

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
