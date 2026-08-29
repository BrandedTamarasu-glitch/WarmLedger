'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const recurrence = require('../js/recurrence.js');

function template(recurrenceRule, overrides = {}) {
  return {
    enabled: true,
    archived: false,
    startDate: '2020-01-01',
    endDate: null,
    recurrence: recurrenceRule,
    ...overrides
  };
}

test('exports exactly the frozen pure API', () => {
  assert.deepEqual(Object.keys(recurrence).sort(), ['addCivilDays', 'compareCivilDates', 'daysInMonth', 'occurrencesForMonth']);
});

test('Gregorian arithmetic handles leap years, centuries, boundaries, and comparisons', () => {
  assert.equal(recurrence.daysInMonth(0, 2), 29);
  assert.equal(recurrence.daysInMonth(2000, 2), 29);
  assert.equal(recurrence.daysInMonth(1900, 2), 28);
  assert.equal(recurrence.daysInMonth(2024, 4), 30);
  assert.equal(recurrence.addCivilDays('1999-12-31', 1), '2000-01-01');
  assert.equal(recurrence.addCivilDays('2000-03-01', -1), '2000-02-29');
  assert.equal(recurrence.addCivilDays('1900-02-28', 1), '1900-03-01');
  assert.equal(recurrence.compareCivilDates('2027-01-01', '2027-01-01'), 0);
  assert.equal(recurrence.compareCivilDates('2026-12-31', '2027-01-01'), -1);
  assert.equal(recurrence.addCivilDays('0001-01-01', -1), '0000-12-31');
  assert.equal(recurrence.addCivilDays('0000-02-28', 1), '0000-02-29');
  assert.throws(() => recurrence.addCivilDays('0000-01-01', -1), RangeError);
  assert.throws(() => recurrence.addCivilDays('9999-12-31', 1), RangeError);
});

test('year 0000 schedules normally while reversed template ranges are rejected', () => {
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'monthly', day: 31 }, {
    startDate: '0000-01-01'
  }), '0000-02'), [
    { scheduledDate: '0000-02-29', ordinal: 1, occurrenceKey: '0000-02-29#0001' }
  ]);
  assert.throws(() => recurrence.occurrencesForMonth(template({ cadence: 'weekly', anchorDate: '2027-01-01' }, {
    startDate: '2027-02-01', endDate: '2027-01-31'
  }), '2027-01'), RangeError);
});

test('monthly clamping and inclusive template boundaries are deterministic', () => {
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'monthly', day: 31 }), '2027-02'), [
    { scheduledDate: '2027-02-28', ordinal: 1, occurrenceKey: '2027-02-28#0001' }
  ]);
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'monthly', day: 10 }, {
    startDate: '2027-02-10', endDate: '2027-02-10'
  }), '2027-02'), [
    { scheduledDate: '2027-02-10', ordinal: 1, occurrenceKey: '2027-02-10#0001' }
  ]);
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'monthly', day: 9 }, {
    startDate: '2027-02-10'
  }), '2027-02'), []);
});

test('twice-monthly clamps independently and preserves same-day collisions', () => {
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'twice-monthly', days: [30, 31] }), '2027-02'), [
    { scheduledDate: '2027-02-28', ordinal: 1, occurrenceKey: '2027-02-28#0001' },
    { scheduledDate: '2027-02-28', ordinal: 2, occurrenceKey: '2027-02-28#0002' }
  ]);
});

test('weekly and biweekly schedules use whole civil-day deltas in both anchor directions', () => {
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'weekly', anchorDate: '2027-01-03' }, {
    startDate: '2027-01-01'
  }), '2027-01').map(item => item.scheduledDate), ['2027-01-03', '2027-01-10', '2027-01-17', '2027-01-24', '2027-01-31']);
  assert.deepEqual(recurrence.occurrencesForMonth(template({ cadence: 'biweekly', anchorDate: '2027-02-12' }, {
    startDate: '2027-01-01', endDate: '2027-02-28'
  }), '2027-01').map(item => item.scheduledDate), ['2027-01-01', '2027-01-15', '2027-01-29']);
});

test('disabled and archived templates emit nothing and inputs/results are detached', () => {
  const rule = template({ cadence: 'monthly', day: 5 });
  const before = JSON.stringify(rule);
  const first = recurrence.occurrencesForMonth(rule, '2027-03');
  first[0].scheduledDate = 'changed';
  assert.equal(JSON.stringify(rule), before);
  assert.equal(recurrence.occurrencesForMonth(rule, '2027-03')[0].scheduledDate, '2027-03-05');
  assert.deepEqual(recurrence.occurrencesForMonth({ ...rule, enabled: false }, '2027-03'), []);
  assert.deepEqual(recurrence.occurrencesForMonth({ ...rule, archived: true }, '2027-03'), []);
});

test('source contains no forbidden environmental APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'recurrence.js'), 'utf8');
  for (const forbidden of ['new D' + 'ate', 'D' + 'ate.now', 'Intl.', 'localStorage', 'sessionStorage', 'document.', 'window.', 'Math.random']) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('CommonJS output is identical in two timezone environments', () => {
  const script = "const r=require('./js/recurrence.js');process.stdout.write(JSON.stringify(r.occurrencesForMonth({enabled:true,archived:false,startDate:'2027-01-01',endDate:null,recurrence:{cadence:'weekly',anchorDate:'2027-01-03'}},'2027-03')))";
  const outputs = ['Pacific/Kiritimati', 'America/Los_Angeles'].map(timezone => {
    const result = spawnSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: timezone }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  });
  assert.equal(outputs[0], outputs[1]);
});

test('classic browser-script API matches CommonJS', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'recurrence.js'), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source, context);
  const actual = context.ZeroBudgetRecurrence.occurrencesForMonth(template({ cadence: 'twice-monthly', days: [15, 31] }), '2028-02');
  const expected = recurrence.occurrencesForMonth(template({ cadence: 'twice-monthly', days: [15, 31] }), '2028-02');
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
});
