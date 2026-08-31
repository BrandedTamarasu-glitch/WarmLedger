'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'js', 'templates.js'), 'utf8');

test('saved disabled selection uses native ephemeral controls without select-all', () => {
  assert.match(html, /<fieldset id="template-activation-controls">/);
  assert.match(html, /id="template-activation-month" type="month" required/);
  assert.match(html, /id="template-activation-preview"[^>]*type="button"/);
  assert.ok(html.indexOf('id="template-activation-preview"') < html.indexOf('id="template-readiness-disabled"'));
  assert.doesNotMatch(html + source, /select all/i);
  assert.match(source, /checkbox\.dataset\.activationKind = entry\.kind/);
  assert.match(source, /checkbox\.dataset\.activationTemplateId = entry\.id/);
  const suggestion = source.slice(source.indexOf('suggestionReadinessItem'), source.indexOf('readinessStructure'));
  assert.doesNotMatch(suggestion, /checkbox|activationTemplateId/);
  assert.match(source, /new Date\(today\.getFullYear\(\), today\.getMonth\(\) \+ 1, 1\)/);
});

test('preview delegates exact selection and renders persisted labels with safe DOM', () => {
  assert.match(source, /Store\.previewTemplateActivation\(\{ targetMonth: month\.value, selections \}\)/);
  assert.match(source, /document\.querySelectorAll\('\[data-activation-kind\]\[data-activation-template-id\]'\)/);
  assert.match(source, /buildActivationPreview\(preview\)/);
  for (const heading of ['Selected templates', 'Possible income additions', 'Possible expense additions',
    'Skipped occurrences', 'Conflicts', 'No occurrence in the preview month']) assert.match(source, new RegExp(heading));
  assert.doesNotMatch(source, /template-activation-content[^\n]*(?:innerHTML|insertAdjacentHTML)/);
});

test('activation dialog is native, Cancel-first, enable-only, and focus-safe', () => {
  const dialog = html.slice(html.indexOf('id="template-activation-dialog"'), html.indexOf('</dialog>', html.indexOf('id="template-activation-dialog"')));
  assert.match(dialog, /<form method="dialog">/);
  assert.ok(dialog.indexOf('id="template-activation-cancel"') < dialog.indexOf('id="template-activation-confirm"'));
  assert.match(dialog, /No budget records will be added/);
  assert.match(dialog, /Enable selected templates/);
  assert.match(source, /Store\.applyTemplateActivationPreview\(preview\)/);
  assert.match(source, /App\.runMutation/);
  assert.match(source, /Templates enabled\. No budget records were added\./);
  assert.match(source, /template-readiness-heading'\)\.focus/);
  assert.match(source, /dialog\.returnValue !== 'confirm'/);
});
