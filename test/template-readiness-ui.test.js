'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js', 'templates.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function loadView(Store = {}) {
  const context = vm.createContext({ Store, document: {}, App: {}, requestAnimationFrame: callback => callback(), console, Date });
  vm.runInContext(`${source}\n;globalThis.__view = TemplatesView;`, context); return context.__view;
}

test('Template readiness precedes canonical template management with exact passive copy', () => {
  const readiness = html.indexOf('id="template-readiness"');
  assert.ok(readiness >= 0 && readiness < html.indexOf('id="templates-income-heading"'));
  assert.match(html, /id="template-readiness-heading" tabindex="-1">Template readiness/);
  assert.match(html, /Review disabled templates and repeated manual patterns\. Nothing here is enabled, saved, or generated automatically\./);
  assert.match(html, /id="template-readiness-disabled-heading"[^>]*>Disabled templates/);
  assert.match(html, /id="template-readiness-suggestions-heading"[^>]*>Suggestions from repeated records/);
});

test('readiness renderer uses one explicit local civil date and exact report fields', () => {
  assert.match(source, /Store\.getTemplateReadiness\(\{ referenceDate \}\)/);
  assert.match(source, /getFullYear\(\).+getMonth\(\).+getDate\(\)/s);
  for (const label of ['Disabled template', 'Suggestion — not saved', 'Upcoming while disabled',
    'Possible upcoming dates', 'Evidence', 'Schedule', 'Active dates', 'Planned amount', 'Structure']) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /Schedule unknown — choose a schedule before saving/);
  assert.match(source, /Review disabled template/); assert.match(source, /Review suggestion/);
  assert.doesNotMatch(source, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML/);
});

test('review actions revalidate original date, identity, and fingerprint before existing forms', () => {
  const original = { kind: 'income', id: 'disabled-id', fingerprint: 'same', draft: null };
  const template = { id: 'disabled-id' };
  const Store = {
    getTemplateReadiness({ referenceDate }) {
      assert.equal(referenceDate, '2026-04-05'); return { disabledTemplates: [{ ...original }], suggestions: [] };
    },
    getIncomeTemplates() { return [template]; }, getExpenseTemplates() { return []; }
  };
  const view = loadView(Store); let opened = null; view.showTemplateModal = (...args) => { opened = args; };
  const trigger = {};
  view.reviewReadiness('disabled', original, '2026-04-05', trigger);
  assert.equal(opened[0], 'income'); assert.equal(opened[1], template); assert.equal(opened[2], trigger);

  let stale = 0; view.handleStaleReadiness = () => { stale += 1; };
  Store.getTemplateReadiness = () => ({ disabledTemplates: [{ ...original, fingerprint: 'changed' }], suggestions: [] });
  opened = null; view.reviewReadiness('disabled', original, '2026-04-05', trigger);
  assert.equal(opened, null); assert.equal(stale, 1);
});

test('suggestion review passes only a freshly revalidated disabled draft', () => {
  const original = { kind: 'expense', key: 'suggestion-key', fingerprint: 'fingerprint',
    draft: { name: 'Draft', enabled: false, recurrence: null } };
  const view = loadView({ getTemplateReadiness: () => ({ disabledTemplates: [], suggestions: [{ ...original }] }) });
  let opened; view.showTemplateModal = (...args) => { opened = args; };
  const trigger = {}; view.reviewReadiness('suggestion', original, '2026-04-05', trigger);
  assert.equal(opened[0], 'expense'); assert.equal(opened[1], null); assert.equal(opened[2], trigger);
  assert.equal(opened[3].enabled, false); assert.equal(opened[3].recurrence, null);
});

test('unknown-schedule drafts require a neutral choice while ordinary Add stays monthly', () => {
  assert.match(source, /ModalView\.select\('field-template-cadence',[\s\S]*\['', 'Choose a schedule'\],[\s\S]*\['monthly', 'Monthly'\]/);
  assert.match(source, /const recurrence = existing \? existing\.recurrence : \{ cadence: 'monthly', day: 1 \}/);
  assert.match(source, /value = recurrence \? recurrence\.cadence : ''/);
  assert.match(source, /if \(!cadence\) return null/);
  assert.match(source, /controls\.some\(control => !control\.reportValidity\(\)\)/);
});

test('stale readiness focus uses fixed enumeration and safe dataset equality', () => {
  assert.match(source, /querySelectorAll\('\[data-readiness-type\]\[data-readiness-key\]'\)/);
  assert.match(source, /control\.dataset\.readinessType === type/);
  assert.match(source, /control\.dataset\.templateKind === original\.kind/);
  assert.match(source, /control\.dataset\.readinessKey === key/);
  assert.doesNotMatch(source, /querySelector(?:All)?\s*\(\s*`[^`]*\$\{/);
  assert.match(source, /Template readiness changed\. Review the refreshed list\./);
});
