'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'budget.js'), 'utf8');

test('paychecks expose native named move controls with list boundaries', () => {
  assert.match(source, /this\.moveButton\('paycheck', 'move-up', p, index === 0/);
  assert.match(source, /this\.moveButton\('paycheck', 'move-down', p, index === month\.paychecks\.length - 1/);
  assert.match(source, /Store\.reorderPaychecks\(this\.currentMonth, ids\)/);
  assert.match(source, /paycheck moved to position \$\{to \+ 1\} of \$\{paychecks\.length\}/);
});

test('expenses move only inside their historical-label group using a full-month permutation', () => {
  assert.match(source, /const expenses = Store\.getMonth\(this\.currentMonth\)\.expenses/);
  assert.match(source, /const group = expenses\.filter\(record => record\.category === expense\.category\)/);
  assert.match(source, /const ids = expenses\.map\(record => record\.id\)/);
  assert.match(source, /\[ids\[from\], ids\[to\]\] = \[ids\[to\], ids\[from\]\]/);
  assert.match(source, /Store\.reorderExpenses\(this\.currentMonth, ids\)/);
  assert.match(source, /groupIndex === 0/);
  assert.match(source, /groupIndex === groupSize - 1/);
});

test('movement focus excludes disabled controls and has deterministic heading fallback', () => {
  assert.match(source, /const sameRecord = control => !control\.disabled/);
  assert.match(source, /const requested = controls\.find\(control => sameRecord\(control\) && control\.dataset\.moveAction === action\)/);
  assert.match(source, /const fallback = controls\.find\(sameRecord\)/);
  assert.match(source, /type === 'paycheck' \? 'paychecks-heading' : 'expenses-heading'/);
  assert.doesNotMatch(source, /querySelector(?:All)?\s*\(\s*`[^`]*\$\{/);
});

test('record labels and identifiers use inert DOM APIs', () => {
  assert.match(source, /button\.dataset\.recordId = record\.id/);
  assert.match(source, /button\.setAttribute\('aria-label', `Move \$\{record\.earner \|\| record\.name\} \$\{direction\}`\)/);
  assert.doesNotMatch(source, /\b(?:onclick|onchange)\s*=/i);
});
