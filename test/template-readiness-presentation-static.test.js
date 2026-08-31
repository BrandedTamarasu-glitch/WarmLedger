'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');

test('Template readiness has compact, wrap-safe, touch-friendly presentation', () => {
  for (const selector of ['#template-readiness', '.template-readiness-list', '.template-readiness-card',
    '.template-readiness-name', '.template-readiness-action']) assert.match(css, new RegExp(selector.replace('.', '\\.')));
  assert.match(css, /\.template-readiness-name[^{}]*\{[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /\.template-readiness-action[^{}]*\{[^}]*min-height:\s*44px[^}]*white-space:\s*normal/is);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*\.template-readiness-action\s*\{[^}]*width:\s*100%/s);
});

test('Template readiness explicitly supports motion and forced-color preferences', () => {
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.template-readiness-card[\s\S]*transition:\s*none !important/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*#template-readiness[\s\S]*\.template-readiness-action/s);
});

test('documentation states the shipped passive contract and remaining boundary', () => {
  for (const phrase of ['read-only Template readiness queue', 'Disabled template', 'Suggestion — not saved',
    "device's explicit local civil date", 'next two calendar months', 'at most its next three',
    'exact same-kind semantic duplicate', 'blank dates have an unknown schedule',
    'Preview recurring items', 'Apply']) assert.match(readme, new RegExp(phrase));
  assert.match(roadmap, /readiness and selected enable-only activation published/);
  assert.match(roadmap, /three-calendar-month horizon/);
  assert.match(roadmap, /exact same-kind semantic duplicates/);
  assert.match(roadmap, /saved disabled templates to be selected for an explicit target-month activation preview/);
});
