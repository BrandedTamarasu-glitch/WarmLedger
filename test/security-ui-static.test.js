'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const app = read('js/app.js');
const modal = read('js/modal-view.js');
const health = read('js/data-health-view.js');
const readme = read('README.md');

test('static shell ships exact file-compatible CSP and dependency order', () => {
  const policy = "default-src 'self' data: blob:; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; media-src 'self' data: blob:; base-uri 'none'; form-action 'self'";
  assert.match(html, new RegExp(`<meta http-equiv="Content-Security-Policy" content="${policy}">`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
  assert.ok(html.indexOf('js/storage-engine.js') < html.indexOf('js/data.js'));
  assert.ok(html.indexOf('js/dashboard-models.js') < html.indexOf('js/dashboard.js'));
  assert.ok(html.indexOf('js/modal-view.js') < html.indexOf('js/app.js'));
  assert.doesNotMatch(html, /\sstyle=/i);
});

test('shared modal accepts only node builders and uses inert DOM replacement', () => {
  assert.match(app, /showModal\(options\)/);
  assert.match(modal, /buildBody\(\)/);
  assert.match(modal, /instanceof Node/);
  assert.match(modal, /replaceChildren\(body\)/);
  assert.match(modal, /removeEventListener\('click', this\.saveHandler\)/);
  assert.match(modal, /initialFocus/);
  assert.match(modal, /this\.trigger/);
  for (const file of ['js/app.js', 'js/budget.js', 'js/structure.js', 'js/templates.js', 'js/data-health-view.js']) {
    assert.doesNotMatch(read(file), /innerHTML|outerHTML|insertAdjacentHTML/);
  }
});

test('Data Health exposes explicit plaintext disclosure and previewed purge', () => {
  assert.match(health, /Local storage & privacy/);
  assert.match(health, /readable local browser data/);
  assert.match(health, /Downloaded JSON backups and browser-evidence files are also readable unless manually deleted/);
  assert.match(health, /Store\.previewLocalDataPurge\(\)/);
  assert.match(health, /Store\.commitLocalDataPurge\(preview\)/);
  assert.match(health, /initialFocus: \(\) => document\.getElementById\('modal-cancel'\)/);
  assert.match(health, /Local Warm Ledger data was removed from this browser\. Restore a backup or start fresh to continue\./);
  assert.match(readme, /Local storage & privacy/);
  assert.match(readme, /Downloaded JSON backups and browser-evidence files are also readable unless manually deleted/);
  assert.match(readme, /Local Warm Ledger data was removed from this browser\. Restore a backup or start fresh to continue\./);
});

test('multi-tab changes reload and stale or busy writes fail closed with exact messages', () => {
  assert.match(app, /window\.addEventListener\('storage'/);
  assert.match(app, /Store\.reload\(\)/);
  assert.match(app, /This budget changed in another tab\. Review the latest saved data and try again\. Nothing was overwritten\./);
  assert.match(app, /Warm Ledger is saving in another tab\. Wait a moment and try again\. Nothing was overwritten\./);
});
