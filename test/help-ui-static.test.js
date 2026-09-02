'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('Help is a static native dialog with truthful getting-started terms', () => {
  const dialog = html.match(/<dialog id="help-dialog"[\s\S]*?<\/dialog>/)?.[0] || '';
  assert.ok(dialog); assert.match(dialog, /aria-labelledby="help-title"/);
  for (const text of ['Getting started', 'Planned', 'Actual', 'Not entered and entered zero', 'Saved date',
    'Planned paycheck funding', 'Manual clearing', 'Checklist complete', 'Local backups and snapshots']) {
    assert.match(dialog, new RegExp(text));
  }
  assert.match(dialog, /method="dialog"/); assert.match(dialog, /value="close">Close help/);
  assert.doesNotMatch(dialog, /script|aria-live|progress|recommend/i);
});

test('Help routes only through fixed existing views and restores focus without writes', () => {
  for (const view of ['budget', 'structure', 'templates', 'data-health']) assert.match(html, new RegExp(`data-help-view="${view}"`));
  assert.match(app, /document\.querySelectorAll\('\[data-help-view\]'\)/);
  assert.match(app, /Object\.hasOwn\(headings, target\)/);
  assert.match(app, /this\.switchView\(target\)/);
  assert.match(app, /document\.getElementById\(headings\[target\]\)\?\.focus/);
  const help = app.slice(app.indexOf('  openHelp('), app.indexOf('  openBudgetFunding('));
  assert.doesNotMatch(help, /Store\.|runMutation|localStorage|sessionStorage|announceStatus/);
  assert.doesNotMatch(help, /querySelector\s*\(\s*`[^`]*\$\{/);
});

test('Help reflows with accessible targets, forced colors, reduced motion, and print omission', () => {
  assert.match(css, /\.help-view-actions \.btn \{[^}]*min-height: 44px/s);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*\.help-view-actions \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*dialog, \.restore-dialog/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*\.help-dialog section/);
  assert.match(css, /@media print[\s\S]*\.help-dialog/);
});
