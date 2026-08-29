'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'js', 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('recurrence and template scripts and required view controls are integrated in order', () => {
  const recurrence = html.indexOf('src="js/recurrence.js"');
  const data = html.indexOf('src="js/data.js"');
  const appScript = html.indexOf('src="js/app.js"');
  const templates = html.indexOf('src="js/templates.js"');
  assert.ok(recurrence > 0 && recurrence < data);
  assert.ok(templates > appScript);
  for (const id of [
    'nav-templates', 'view-templates', 'btn-add-income-template', 'btn-add-expense-template',
    'templates-income', 'templates-expenses', 'templates-income-heading', 'templates-expenses-heading',
    'btn-preview-recurring', 'recurring-preview-dialog', 'recurring-preview-content',
    'recurring-preview-cancel', 'recurring-preview-apply'
  ]) assert.match(html, new RegExp(`id="${id}"`));
});

test('active v3 application reveals and initializes recurring features after recovery gating', () => {
  assert.match(app, /nav-templates'\)\.hidden = false/);
  assert.match(app, /btn-preview-recurring'\)\.hidden = false/);
  assert.match(app, /view-templates'\)\.hidden = false/);
  assert.match(app, /if \(!this\.templatesInitialized\) \{ TemplatesView\.init\(\)/);
  assert.doesNotMatch(app, /schemaVersion|isV3|SCHEMA_V3_REQUIRED/);
});

test('recurring generation is explicit preview-first with a Cancel-first dialog', () => {
  assert.match(app, /Store\.previewRecurringMonth\(BudgetView\.currentMonth\)/);
  assert.match(app, /TemplatesView\.buildPreview\(preview\)/);
  assert.match(app, /preview\.counts\.conflicts > 0 \|\| preview\.counts\.additions === 0/);
  assert.match(app, /Store\.applyRecurringPreview\(preview\)/);
  assert.ok(html.indexOf('id="recurring-preview-cancel"') < html.indexOf('id="recurring-preview-apply"'));
  assert.match(html, /id="recurring-preview-cancel"[^>]*autofocus/);
  assert.doesNotMatch(app, /recurring-preview-content[^\n]*innerHTML/);
});

test('shared integration includes actionable errors and responsive accessibility rules', () => {
  const templateCodes = [
    'RECORD_MONTH_MISMATCH', 'GENERATED_DATE_MISMATCH', 'ALLOCATION_EXCEEDS_PLANNED',
    'INVALID_DATE', 'INVALID_DATE_RANGE', 'INVALID_RECURRENCE_DAY', 'INVALID_RECURRENCE_DAYS',
    'INVALID_RECURRING_PREVIEW', 'STALE_RECURRING_PREVIEW', 'RECURRING_CONFLICT',
    'INCOME_TEMPLATE_NOT_FOUND', 'EXPENSE_TEMPLATE_NOT_FOUND', 'EARNER_ARCHIVED',
    'CATEGORY_ARCHIVED', 'CATEGORY_ITEM_ARCHIVED'
  ];
  for (const code of templateCodes) {
    assert.match(app, new RegExp(`${code}:`));
    const line = app.split('\n').find(candidate => candidate.includes(`${code}:`));
    assert.match(line, /^\s+[A-Z_]+: '[^']+',?$/);
    assert.doesNotMatch(line, /\$\{|error\.|path|payload/i);
  }
  assert.match(styles, /@media \(max-width: 360px\)/);
  assert.match(styles, /min-height: 44px/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /max-height: calc\(100dvh - 2rem\)/);
});
