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

test('existing chart and summary order remains unchanged', () => {
  const ids = ['chart-category-trend', 'chart-income-pct', 'chart-proj-vs-actual', 'chart-savings-rate',
    'chart-payment-method', 'chart-yoy', 'summary-table-container'];
  const positions = ids.map(id => html.indexOf(`id="${id}"`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('Dashboard shell is compact, responsive, focus-visible, and system-mode safe', () => {
  assert.match(css, /\.dashboard-overview\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.dashboard-range-status[^{}]*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.dashboard-range-status \.btn[^{}]*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.date-range input:focus-visible\s*\{[^}]*outline:/s);
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*\.dashboard-overview\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-overview-card[\s\S]*border-color:\s*CanvasText/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.dashboard-overview-card[\s\S]*transition:\s*none !important/s);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
});
