'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');

test('Dashboard exposes a deterministic heading and accessible reporting-range group', () => {
  assert.match(html, /<h2 id="dashboard-heading" tabindex="-1">Dashboard<\/h2>/);
  assert.match(html, /<fieldset class="dashboard-controls" aria-describedby="dashboard-range-help dashboard-state">/);
  assert.match(html, /<legend>Reporting range<\/legend>/);
  assert.match(html, /<label for="dash-from"><span>From month<\/span><input type="month" id="dash-from"><\/label>/);
  assert.match(html, /<label for="dash-to"><span>To month<\/span><input type="month" id="dash-to"><\/label>/);
  assert.match(html, /id="dashboard-range-help"[^>]*>Choose a start and end month\. The range can include up to 600 months\./);
});

test('Dashboard has explicit live state, empty-state surface, and results/overview containers', () => {
  assert.match(html, /id="dashboard-state" class="dashboard-range-status dashboard-empty"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*tabindex="-1" hidden/);
  assert.match(html, /id="dashboard-results" hidden/);
  assert.match(html, /<section id="dashboard-overview" class="dashboard-overview" aria-label="Selected range overview"><\/section>/);
});

test('default report order is primary-first and secondary analysis is in closed native details', () => {
  assert.match(html, /<details id="dashboard-report-details" class="dashboard-report-details">\s*<summary>Report details<\/summary>/s);
  assert.doesNotMatch(html, /<details id="dashboard-report-details"[^>]*\sopen(?:\s|>|=)/);
  const ids = ['chart-category-trend', 'chart-proj-vs-actual', 'chart-payment-method', 'chart-income-pct',
    'chart-savings-rate', 'chart-yoy', 'summary-table-container'];
  const positions = ids.map(id => html.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  const detailsStart = html.indexOf('id="dashboard-report-details"'); const detailsEnd = html.indexOf('</details>', detailsStart);
  for (const id of ['chart-income-pct', 'chart-savings-rate', 'chart-yoy', 'summary-table-container']) {
    const position = html.indexOf(`id="${id}"`); assert.ok(position > detailsStart && position < detailsEnd);
  }
  assert.match(html, /<h3>Planned spending and allocations<\/h3>/);
  assert.match(html, /id="dashboard-composition-context"/);
  assert.match(html, /<h3>Planned savings &amp; investment allocation rate<\/h3>/);
  assert.match(html, /<h3>Planned bills by payment method<\/h3>/);
});

test('Dashboard shell is compact, responsive, focus-visible, and system-mode safe', () => {
  assert.match(css, /\.dashboard-overview\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.dashboard-range-status[^{}]*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.dashboard-range-status \.btn[^{}]*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.date-range input:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.dashboard-overview\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-overview-card[\s\S]*border-color:\s*CanvasText/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.dashboard-overview-card[\s\S]*transition:\s*none !important/s);
  assert.match(css, /\.dashboard-report-details > summary\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.dashboard-report-details > summary:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-report-details[\s\S]*border-color:\s*CanvasText/s);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
});
