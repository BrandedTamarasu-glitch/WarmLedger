'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'js', 'structure.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');

test('Structure is a top-level view initialized by the application', () => {
  assert.match(html, /data-view="structure">Structure</);
  assert.match(html, /id="view-structure"/);
  assert.match(html, /id="structure-categories-heading" tabindex="-1"/);
  assert.match(html, /id="structure-earners-heading" tabindex="-1"/);
  assert.match(html, /<script src="js\/structure\.js"><\/script>/);
  assert.match(app, /StructureView\.init\(\)/);
  assert.match(app, /else if \(view === 'structure'\) StructureView\.render\(\)/);
});

test('all catalog operations use the frozen Store APIs', () => {
  [
    'addCategory', 'renameCategory', 'setCategoryArchived', 'reorderCategories',
    'addCategoryItem', 'renameCategoryItem', 'setCategoryItemArchived', 'reorderCategoryItems',
    'addEarner', 'renameEarner', 'setEarnerArchived', 'reorderEarners', 'getStructureUsage'
  ].forEach(method => assert.match(source, new RegExp(`Store\\.${method}\\(`)));
  assert.doesNotMatch(source, /Store\.getData\(\)/);
});

test('rows expose textual status, keyboard-native movement, and boundary disabling', () => {
  assert.match(source, /record\.archived \? 'Archived' : 'Active'/);
  assert.match(source, /this\.moveButton\('↑', 'Move up'/);
  assert.match(source, /this\.moveButton\('↓', 'Move down'/);
  assert.match(source, /button\.disabled = disabled/);
  assert.match(source, /moved to position \$\{to \+ 1\} of \$\{records\.length\}/);
});

test('archive confirmation reports usage and promises historical preservation', () => {
  assert.match(source, /usage === 1 \? '1 historical record uses'/);
  assert.match(source, /History will remain visible/);
  assert.match(source, /will no longer appear for new records/);
  assert.match(source, /save\.textContent = 'Archive'/);
});

test('persisted values use inert DOM sinks and focus lookup avoids selector interpolation', () => {
  assert.match(source, /node\.textContent = text/);
  assert.match(source, /message\.textContent =/);
  assert.match(source, /control\.dataset\.recordId === id/);
  assert.match(source, /belongsToRecord\(control\) && !control\.disabled/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\b(?:onclick|onchange)\s*=/i);
  assert.doesNotMatch(source, /querySelector(?:All)?\s*\(\s*`[^`]*\$\{/);
});

test('actionable Structure failures have stable user messages', () => {
  ['CATEGORY_NOT_FOUND', 'CATEGORY_ITEM_NOT_FOUND', 'EARNER_NOT_FOUND', 'DUPLICATE_CATEGORY_NAME',
    'DUPLICATE_EARNER_NAME', 'LAST_ACTIVE_CATEGORY', 'LAST_ACTIVE_EARNER', 'INVALID_PERMUTATION']
    .forEach(code => assert.match(app, new RegExp(`${code}:`)));
});

test('shared modal controls reset after an archive confirmation', () => {
  assert.match(app, /replacement\.textContent = 'Save'/);
  assert.match(app, /replacement\.className = 'btn btn-primary'/);
  assert.match(app, /replacement\.disabled = false/);
});
