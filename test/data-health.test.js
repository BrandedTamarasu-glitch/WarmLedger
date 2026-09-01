'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Health = require('../js/data-health.js');
const { makeV3Budget } = require('./helpers.js');

function month(paycheckId, expenseId, funded, planned = 100) {
  return {
    paychecks: [{ id: paycheckId, earnerId: 'earner-example-1', earner: 'Example Earner',
      plannedAmount: 500, actualAmount: null, date: '', sourceTemplateId: null, occurrenceKey: null }],
    expenses: [{ id: expenseId, categoryId: 'category-example-1', category: 'Home',
      categoryItemId: 'item-example-1', name: 'Rent', date: '', paycheckAmounts: { [paycheckId]: funded },
      plannedAmount: planned, actualAmount: 0, paymentMethod: 'bank', sourceTemplateId: null, occurrenceKey: null }],
    allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: []
  };
}

test('analysis is deterministic, detached, deeply frozen, and observes exact health boundaries', () => {
  const data = makeV3Budget();
  data.months = {
    '2026-01': month('p1', 'e1', 99.992),
    '2026-03': month('p3', 'e3', 99.99),
    '2026-04': month('p4', 'e4', 100)
  };
  const before = JSON.stringify(data);
  const first = Health.analyze(data);
  const second = Health.analyze(data);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(data), before);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.missingActuals), true);
  assert.equal(first.counts.missingActuals, 3);
  assert.equal(first.counts.missingDates, 6);
  assert.deepEqual(first.absentMonths, ['2026-02']);
  assert.equal(first.fundingMismatches.length, 1);
  assert.equal(first.fundingMismatches[0].monthKey, '2026-03');
  assert.equal(first.repeatedManualPatterns.length, 2);
  assert.ok(first.repeatedManualPatterns.every(pattern => pattern.monthKeys.length === 3));
});

test('empty month keys do not set gap endpoints and generated records do not form manual patterns', () => {
  const data = makeV3Budget();
  data.months = {
    '2026-01': { paychecks: [], expenses: [], allocations: { savings: 0, credit_card_debt: 0, investments: 0 }, suppressedOccurrences: [] },
    '2026-02': month('p2', 'e2', 100),
    '2026-04': month('p4', 'e4', 100)
  };
  data.months['2026-04'].expenses[0].sourceTemplateId = 'template';
  data.months['2026-04'].expenses[0].occurrenceKey = '2026-04-01#0001';
  const report = Health.analyze(data);
  assert.deepEqual(report.absentMonths, ['2026-03']);
  assert.equal(report.repeatedManualPatterns.length, 0);
});

test('funding mismatch threshold excludes exact 0.009 despite floating representation and includes just over', () => {
  const data = makeV3Budget();
  data.months = {
    '2026-01': month('p1', 'e1', 99.991),
    '2026-02': month('p2', 'e2', 99.9909)
  };
  const report = Health.analyze(data);
  assert.deepEqual(report.fundingMismatches.map(item => item.monthKey), ['2026-02']);
});

test('month-sharded migration summary helper preserves the brief copy for each state', () => {
  const available = Health.buildShardedPersistenceMigration({ state: 'available' });
  assert.deepEqual({
    state: available.state,
    title: available.title,
    buttonLabel: available.buttonLabel,
    canPreview: available.canPreview
  }, {
    state: 'available',
    title: 'Month-sharded local storage is ready',
    buttonLabel: 'Preview month-sharded storage',
    canPreview: true
  });
  assert.match(available.description, /one large local record to month-sharded local storage/);
  assert.match(available.description, /Older app versions may require restoring a backup made before this migration\./);

  const active = Health.buildShardedPersistenceMigration({ state: 'already-sharded' });
  assert.deepEqual({
    state: active.state,
    title: active.title,
    buttonLabel: active.buttonLabel,
    canPreview: active.canPreview
  }, {
    state: 'already-sharded',
    title: 'Month-sharded local storage is active',
    buttonLabel: null,
    canPreview: false
  });
  assert.equal(active.description, 'This ledger already saves active local data by month. No migration action is needed.');

  const empty = Health.buildShardedPersistenceMigration({ state: 'empty' });
  assert.deepEqual({
    state: empty.state,
    title: empty.title,
    buttonLabel: empty.buttonLabel,
    canPreview: empty.canPreview
  }, {
    state: 'empty',
    title: 'Month-sharded local storage is unavailable',
    buttonLabel: null,
    canPreview: false
  });
  assert.equal(empty.description, 'No saved local data is present yet. Month-sharded local storage becomes relevant after this ledger contains saved months.');
});
