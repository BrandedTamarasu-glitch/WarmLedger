'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'js', 'dashboard.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('finder is an initially closed native disclosure near Upcoming with a labelled submit-only form', () => {
  const upcoming = html.indexOf('id="dashboard-upcoming"');
  const finder = html.indexOf('id="dashboard-record-finder"');
  const reporting = html.indexOf('class="dashboard-controls"');
  assert.ok(upcoming < finder && finder < reporting);
  const disclosure = html.slice(finder, html.indexOf('</details>', finder));
  assert.doesNotMatch(disclosure.slice(0, disclosure.indexOf('>')), /\bopen\b/);
  assert.match(disclosure, /<summary>Find a saved record<\/summary>/);
  assert.match(disclosure, /<form id="dashboard-record-finder-form" autocomplete="off">/);
  assert.match(disclosure, /id="dashboard-record-query"[^>]*autocomplete="off"/);
  for (const id of ['dashboard-record-query', 'dashboard-record-kind', 'dashboard-record-from', 'dashboard-record-to']) {
    assert.match(disclosure, new RegExp(`for="${id}"`)); assert.match(disclosure, new RegExp(`id="${id}"`));
  }
  assert.match(disclosure, /type="submit">Search/);
  assert.match(disclosure, /id="dashboard-record-clear"[^>]*type="button" hidden>Clear search/);
  assert.doesNotMatch(source, /dashboard-record-(?:query|kind|from|to)'\)\.addEventListener\(['"](?:input|change|keyup)/);
});

test('finder sends the exact bounded Store request and holds it only in transient view memory', () => {
  assert.match(source, /Store\.findSavedRecords\(request\)/);
  for (const field of ['query', 'kind', 'fromMonth', 'toMonth', 'limit']) assert.match(source, new RegExp(`${field}:`));
  assert.match(source, /limit: 200/);
  assert.match(source, /savedRecordSearchRequest: null/);
  const finder = source.slice(source.indexOf('savedRecordRequestFromForm('), source.indexOf('upcomingNode('));
  assert.doesNotMatch(finder, /localStorage|sessionStorage|history|location|console|log|export|download|URL/);
  assert.doesNotMatch(finder, /RegExp|\.match\(|fuzzy|score|rank/);
});

test('results render literal safe nodes with clear, empty, truncation and delegated actions', () => {
  for (const copy of ['No saved records matched this search.', 'matching saved', 'Results are limited to',
    'Date needed', 'Actual: Not entered']) assert.match(source, new RegExp(copy));
  const result = source.slice(source.indexOf('  savedRecordResultItem('), source.indexOf('  upcomingNode('));
  assert.match(result, /button\.addEventListener\('click', \(\) => App\.openSavedRecordResult\(result\)\)/);
  assert.equal((result.match(/addEventListener/g) || []).length, 1);
  assert.doesNotMatch(source, /dashboard-record-results[^\n]*(?:innerHTML|insertAdjacentHTML)/);
  assert.match(source, /container\.replaceChildren\(\)/);
  assert.match(source, /dashboard-record-finder-form'\)\.reset\(\)/);
});

test('hostile labels stay literal, null differs from entered zero, and action delegates the exact result', () => {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.className = ''; this.dataset = {}; this.listeners = {}; }
    append(...children) { this.children.push(...children); }
    addEventListener(type, listener) { this.listeners[type] = listener; }
  }
  const opened = [];
  const context = vm.createContext({
    document: { createElement: tag => new Node(tag) },
    BudgetView: { fmt: value => `$${Number(value).toFixed(2)}` },
    App: { formatMonth: value => `Month ${value}`, openSavedRecordResult: result => opened.push(result) },
    Store: {}, Chart: function () {}, console, ALLOCATION_TYPES: []
  });
  vm.runInContext(`${source}\n;globalThis.__dashboard = DashboardView;`, context);
  const base = { kind: 'expense', monthKey: '2026-01', recordId: '"><script>id</script>',
    primaryLabel: '<img src=x onerror=alert(1)>', secondaryLabel: 'Category & literal', date: '',
    plannedAmount: 12, matchedFields: ['name'] };
  const flatten = node => [node.textContent, ...node.children.flatMap(child => child instanceof Node ? flatten(child) : [String(child)])].join(' ');
  const missingResult = { ...base, actualAmount: null };
  const missing = context.__dashboard.savedRecordResultItem(missingResult);
  const zero = context.__dashboard.savedRecordResultItem({ ...base, actualAmount: 0 });
  assert.match(flatten(missing), /<img src=x onerror=alert\(1\)>/);
  assert.match(flatten(missing), /Actual: Not entered/);
  assert.match(flatten(zero), /Actual: \$0\.00/);
  assert.doesNotMatch(flatten(zero), /<script>id<\/script>/);
  missing.children.at(-1).listeners.click(); assert.strictEqual(opened[0], missingResult);
});

test('finder has 44px controls, 320px reflow, forced colors, reduced motion and is print-hidden', () => {
  assert.match(css, /\.dashboard-record-finder > summary\s*\{[^}]*min-height:\s*44px[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /\.dashboard-record-finder-fields input, \.dashboard-record-finder-fields select\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.dashboard-record-finder-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-record-finder-fields input/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.dashboard-record-finder/s);
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.dashboard-record-finder[\s\S]*display:\s*none !important/);
});
