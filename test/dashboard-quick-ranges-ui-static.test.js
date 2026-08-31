'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'js', 'dashboard.js'), 'utf8');

test('Dashboard exposes four labelled native quick-range commands after month inputs', () => {
  const inputs = html.indexOf('class="date-range"');
  const group = html.indexOf('class="dashboard-quick-ranges"');
  const help = html.indexOf('id="dashboard-range-help"');
  assert.ok(inputs >= 0 && inputs < group && group < help);
  assert.match(html, /class="dashboard-quick-ranges" role="group" aria-labelledby="dashboard-quick-ranges-label"/);
  assert.match(html, /id="dashboard-quick-ranges-label">Quick ranges/);
  const values = [...html.matchAll(/data-dashboard-quick-range="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(values, ['current', 'last-3', 'last-6', 'ytd']);
  for (const label of ['Current month', 'Last 3 months', 'Last 6 months', 'Year to date']) {
    assert.match(html, new RegExp(`<button class="btn" type="button" data-dashboard-quick-range="[^"]+">${label}<\\/button>`));
  }
  assert.match(dashboard, /querySelectorAll\('\[data-dashboard-quick-range\]'\)/);
  assert.match(dashboard, /dataset\.dashboardQuickRange/);
  assert.doesNotMatch(html, /data-dashboard-range=/);
  assert.doesNotMatch(html.slice(group, help), /aria-pressed|role="(?:switch|radio)"/);
  assert.match(html, /Choose a start and end month or use a quick range\./);
});

test('Quick-range commands are touch-sized, wrap-safe, and reflow at 320px', () => {
  assert.match(css, /\.dashboard-quick-range-actions\s*\{[^}]*flex-wrap:\s*wrap[^}]*min-width:\s*0/is);
  assert.match(css, /\.dashboard-quick-range-actions \.btn\s*\{[^}]*min-height:\s*44px[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/is);
  assert.match(css, /@media \(max-width:\s*360px\)[\s\S]*\.dashboard-quick-range-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test('Quick-range commands retain reduced-motion and forced-color support', () => {
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.btn[\s\S]*transition:\s*none !important/s);
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-quick-range-actions \.btn\s*\{[^}]*ButtonText[^}]*ButtonFace/s);
});
