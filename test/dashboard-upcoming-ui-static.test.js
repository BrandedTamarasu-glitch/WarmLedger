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
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const roadmap = fs.readFileSync(path.join(root, 'ROADMAP.md'), 'utf8');

test('Upcoming bills and paydays is closed near the Dashboard top with native day controls', () => {
  const dashboard = html.indexOf('id="view-dashboard"');
  const upcoming = html.indexOf('id="dashboard-upcoming"');
  const reporting = html.indexOf('class="dashboard-controls"');
  assert.ok(dashboard < upcoming && upcoming < reporting);
  const disclosure = html.slice(upcoming, html.indexOf('</details>', upcoming));
  assert.doesNotMatch(disclosure.slice(0, disclosure.indexOf('>')), /\bopen\b/);
  assert.match(disclosure, /<summary>Upcoming bills &amp; paydays<\/summary>/);
  const values = [...disclosure.matchAll(/name="dashboard-upcoming-days" value="(30|60|90)"/g)].map(match => match[1]);
  assert.deepEqual(values, ['30', '60', '90']);
  assert.match(disclosure, /value="30" checked/);
  assert.doesNotMatch(disclosure, /button|aria-live|role="status"/);
});

test('Dashboard passes an explicit local civil anchor and renders projection fields with inert DOM', () => {
  assert.match(source, /Store\.getUpcomingBillsAndPaydays\(\{ anchorDate: this\.localCivilDate\(\), dayCount: this\.upcomingDayCount \}\)/);
  assert.match(source, /today\.getFullYear\(\)[\s\S]*today\.getMonth\(\) \+ 1[\s\S]*today\.getDate\(\)/);
  for (const text of ['Saved plan', 'No saved plan', 'Scheduled records', 'Date needed', 'Payday', 'Bill',
    'Actual: Not entered', 'Actual: Entered', 'Funding: Unfunded', 'Funding: Partially funded', 'Funding: Fully funded']) {
    assert.match(source, new RegExp(text));
  }
  assert.match(source, /this\.upcomingNode\('time'/);
  assert.doesNotMatch(source, /dashboard-upcoming[^\n]*(?:innerHTML|insertAdjacentHTML)/);
  assert.doesNotMatch(source, /getIncomeTemplates|getExpenseTemplates|previewRecurring|generate|reminder|Notification/);
  const upcomingMethods = source.slice(source.indexOf('upcomingPayday('), source.indexOf('fullDate('));
  assert.doesNotMatch(upcomingMethods, /item\.(?:paycheckId|expenseId)|fundingSources/);
});

test('hostile identifiers stay inert and bill null remains distinct from entered zero', () => {
  class Node {
    constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; this.className = ''; }
    append(...children) { this.children.push(...children); }
  }
  const context = vm.createContext({
    document: { createElement: tag => new Node(tag) },
    BudgetView: { fmt: value => `$${Number(value).toFixed(2)}` },
    Store: {}, App: {}, Chart: function () {}, console
  });
  vm.runInContext(`${source}\n;globalThis.__dashboard = DashboardView;`, context);
  const view = context.__dashboard;
  const base = { expenseId: '"><script>id</script>', name: '<strong>Hostile bill</strong>', category: 'Category & name',
    plannedAmount: 10, fundedAcrossPaychecks: 0, remainingToFund: 10, fundedPaycheckCount: 0,
    splitAcrossPaychecks: false, fundingState: 'unfunded' };
  const flatten = node => [node.textContent, ...node.children.flatMap(child => child instanceof Node ? flatten(child) : [String(child)])].join(' ');
  const missing = flatten(view.upcomingBill({ ...base, actualAmount: null, actualState: 'not-entered' }));
  const zero = flatten(view.upcomingBill({ ...base, actualAmount: 0, actualState: 'entered' }));
  assert.match(missing, /Actual: Not entered/); assert.doesNotMatch(missing, /\$0\.00/);
  assert.match(zero, /Actual: Entered \$0\.00/);
  assert.match(zero, /<strong>Hostile bill<\/strong>/);
  assert.doesNotMatch(zero, /<script>id<\/script>/);
});

test('Upcoming presentation reflows, preserves forced colors and prints content without controls', () => {
  assert.match(css, /\.dashboard-upcoming > summary\s*\{[^}]*min-height:\s*44px[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /\.dashboard-upcoming-controls label\s*\{[^}]*min-height:\s*44px/is);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.dashboard-upcoming-item\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-upcoming-controls input/s);
  const print = css.slice(css.indexOf('@media print'));
  assert.match(print, /\.dashboard-upcoming-controls[\s\S]*display:\s*none !important/);
  assert.match(print, /\.dashboard-upcoming-body, #dashboard-upcoming-content\s*\{[^}]*display:\s*block !important/s);
  assert.match(print, /\.dashboard-upcoming-disclaimer/);
});

test('documentation states saved-only truth and deferred boundaries', () => {
  for (const phrase of ['initially closed **Upcoming bills & paydays**', '30-, 60-, or 90-day window',
    '**No saved plan**', '**Date needed**', 'entered zero', 'saved paycheck assignments',
    'does not inspect templates', 'send reminders', 'Print includes the currently selected range']) assert.match(readme, new RegExp(phrase.replaceAll('*', '\\*')));
  assert.match(roadmap, /closed Upcoming bills & paydays projection/);
  assert.match(roadmap, /reminders, calendar integration, inference, and account claims remain deferred/);
});
