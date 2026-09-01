'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync(require.resolve('../index.html'), 'utf8');
const css = fs.readFileSync(require.resolve('../css/styles.css'), 'utf8');
const source = fs.readFileSync(require.resolve('../js/dashboard.js'), 'utf8');

test('saved month comparison is an initially closed, local, accessible disclosure', () => {
  assert.match(html, /<details id="dashboard-saved-month-comparison" class="dashboard-saved-month-comparison dash-card">\s*<summary>Compare saved months<\/summary>/);
  assert.doesNotMatch(html, /id="dashboard-saved-month-comparison"[^>]*\sopen/);
  assert.match(html, /id="dashboard-comparison-baseline"[^>]*required/);
  assert.match(html, /id="dashboard-comparison-month"[^>]*required/);
  assert.match(html, /id="dashboard-comparison-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/);
  assert.match(html, /id="dashboard-comparison-output"[^>]*hidden/);
  assert.match(html, /Results are read-only, stay on this device/);
});

test('comparison controls are touch-sized and contain their table at narrow widths', () => {
  assert.match(css, /\.dashboard-saved-month-comparison > summary\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.dashboard-comparison-fields select\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.dashboard-comparison-actions \.btn\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width:\s*640px\)[\s\S]*\.dashboard-comparison-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /\.dashboard-comparison-table\s*\{[^}]*overflow-x:\s*auto/);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
});

test('forced colors preserve comparison boundaries and print hides controls but shows output', () => {
  assert.match(css, /@media \(forced-colors:\s*active\)[\s\S]*\.dashboard-saved-month-comparison[\s\S]*border-color:\s*CanvasText/);
  const printCss = css.slice(css.indexOf('@media print'));
  assert.match(printCss, /#dashboard-saved-month-comparison-form[\s\S]*display:\s*none !important/);
  assert.match(printCss, /\.dashboard-comparison-output\s*\{[^}]*display:\s*block !important/);
  assert.match(printCss, /\.dashboard-comparison-context\s*\{[^}]*color:\s*#000/);
});

test('comparison rendering is text-safe, chart-free, and delegates all financial math to Store', () => {
  assert.match(source, /Store\.compareSavedMonths\(/);
  assert.match(source, /cell\.textContent\s*=/);
  assert.doesNotMatch(source, /dashboard-comparison[\s\S]{0,80}innerHTML/);
  assert.doesNotMatch(html, /chart-dashboard-comparison|canvas[^>]*comparison/);
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|sendBeacon/);
});
