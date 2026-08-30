'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const budget = fs.readFileSync(path.join(root, 'js', 'budget.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'js', 'data-health-view.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('Data Health scripts and sixth view load in dependency order', () => {
  assert.ok(html.indexOf('js/data-health.js') < html.indexOf('js/data.js'));
  assert.ok(html.indexOf('js/data-health-view.js') < html.indexOf('js/app.js'));
  assert.match(html, /data-view="data-health"/);
  assert.match(html, /id="view-data-health"/);
  assert.match(app, /DataHealthView\.init\(\)/);
});

test('health workflows use frozen Store APIs without unsafe persisted-content sinks', () => {
  for (const api of ['getDataHealth', 'previewActualResolutions', 'applyActualResolutions', 'previewDefaultDateResolutions', 'applyDefaultDateResolutions', 'compareAdditiveBackup']) {
    assert.match(view, new RegExp(`Store\\.${api}\\(`));
  }
  assert.doesNotMatch(view, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/);
  assert.match(view, /file\.size\s*>\s*App\.MAX_IMPORT_BYTES/);
  assert.match(view, /Nothing was imported/);
  assert.match(view, /type\s*=\s*'checkbox'/);
  assert.match(view, /dialog\.returnValue\s*!==\s*'confirm'/);
  assert.match(view, /More checks and tools/);
  assert.match(view, /review-default-dates/);
  assert.match(view, /Create template/);
  assert.match(view, /openPatternTemplate\(pattern, trigger\)/);
  assert.match(view, /Store\.getDataHealth\(\)\.repeatedManualPatterns\.find/);
  assert.match(view, /TemplatesView\.showTemplateModal/);
});

test('expense deletion is Cancel-first and offers receipt-based session Undo', () => {
  const cancel = html.indexOf('id="expense-delete-cancel"');
  const confirm = html.indexOf('id="expense-delete-confirm"');
  assert.ok(cancel >= 0 && cancel < confirm);
  assert.match(budget, /App\.confirmExpenseDelete\(/);
  assert.match(app, /Store\.deleteExpense\([^)]*\)/);
  assert.match(app, /Store\.undoDeleteExpense\(context\.receipt\)/);
  assert.match(app, /expenseUndo:\s*null/);
  for (const mutation of ['Store.restoreSnapshot(id)', 'Store.startFresh()', 'Store.commitImport(preview)']) {
    const start = app.indexOf(mutation); assert.ok(start >= 0, `${mutation} path is missing`);
    assert.match(app.slice(start, start + 180), /clearExpenseUndo\(\)/, `${mutation} must invalidate Undo`);
  }
});

test('actual-resolution failures leave the application alert in control of focus', () => {
  const apply = view.slice(view.indexOf('Store.applyActualResolutions'));
  const failure = apply.slice(apply.indexOf('onFailure:'), apply.indexOf('onFailure:') + 140);
  assert.doesNotMatch(failure, /\.focus\s*\(/);
  assert.match(failure, /this\.render\(\)/);
});

test('new surfaces reflow with reachable controls and system accessibility modes', () => {
  assert.match(css, /\.actual-resolution-row\s*\{/);
  assert.match(css, /\.undo-notice\s*\{/);
  assert.match(css, /@media \(max-width:\s*360px\)[\s\S]*\.undo-actions[\s\S]*min-height:\s*44px/);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.data-health-section[\s\S]*\.undo-notice/);
  assert.match(css, /\.nav-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(3,/);
});
