'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');

test('activation controls and dialog are touch-sized, bounded, and label-safe', () => {
  assert.match(css, /#template-activation-controls\s*\{[^}]*min-width:\s*0[^}]*border:/is);
  assert.match(css, /#template-activation-month\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /#template-activation-preview\s*\{[^}]*min-height:\s*44px[^}]*white-space:\s*normal/is);
  assert.match(css, /\.template-activation-choice\s*\{[^}]*min-height:\s*44px[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /#template-activation-dialog\s*\{[^}]*max-height:[^;}]*100dvh[^}]*overflow-y:\s*auto/is);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*#template-activation-preview\s*\{[^}]*width:\s*100%/s);
});

test('activation presentation covers reduced motion and forced colors', () => {
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*#template-activation-dialog[\s\S]*transition:\s*none !important/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*#template-activation-controls[\s\S]*\.template-activation-choice input/s);
});

test('activation documentation preserves enable-only and generator boundaries', () => {
  for (const phrase of ['existing saved disabled templates', 'Unsaved suggestions cannot be selected',
    'temporary target month', 'defaults to the next local calendar month', 'Conflicts block confirmation',
    'changes only those templates to enabled', 'does not create a month', 'Activation preview is enable-only',
    'Preview recurring items', 'Apply']) assert.match(readme, new RegExp(phrase));
  assert.match(roadmap, /selected enable-only activation published/);
  assert.match(roadmap, /suggestions remain Review-only/);
  assert.match(roadmap, /conflicts block confirmation and no Budget records are generated/);
  assert.match(roadmap, /activation coupled to generation/);
});
