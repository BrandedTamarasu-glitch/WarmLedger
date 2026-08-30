'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function blocksContaining(source, marker) {
  const blocks = []; let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const open = source.indexOf('{', cursor); if (open < 0) break;
    let depth = 1; let end = open + 1;
    while (end < source.length && depth) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    if (!depth) blocks.push(source.slice(cursor, end));
    cursor = end;
  }
  return blocks;
}

function responsiveAt(maximum) {
  return blocksContaining(css, '@media (max-width:')
    .filter(block => Number(block.match(/max-width:\s*(\d+)px/i)?.[1]) >= maximum).join('\n');
}

test('Budget summary is a stable numeric grid with narrow fallbacks', () => {
  assert.match(css, /\.budget-summary-bar\s*\{[^}]*display\s*:\s*grid/is);
  assert.match(css, /\.budget-summary-bar\s*\{[^}]*grid-template-columns\s*:\s*repeat\(3\s*,\s*minmax\(0\s*,\s*1fr\)\)/is);
  assert.match(css, /\.summary-item\s*\{[^}]*min-width\s*:\s*0/is);
  assert.match(css, /\.summary-value[^{]*\{[^}]*font-variant-numeric\s*:\s*tabular-nums/is);
  const compact = responsiveAt(640); const phone = responsiveAt(480);
  assert.match(compact, /\.budget-summary-bar\s*\{/);
  assert.match(phone, /\.budget-summary-bar\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|minmax\(0\s*,\s*1fr\))/is);
});

test('Monthly Review uses a compact metric dashboard with wrap-safe drilldowns', () => {
  for (const selector of ['.monthly-review-grid', '.monthly-review-group', '.monthly-review-metrics',
    '.monthly-review-metric-value', '.monthly-review-drilldown', '.monthly-review-list', '.monthly-review-action']) {
    assert.match(css, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(css, /\.monthly-review-grid\s*\{[^}]*repeat\(auto-fit/is);
  const group = css.match(/\.monthly-review-group\s*\{([^}]*)\}/is)?.[1] || '';
  assert.match(group, /min-width\s*:\s*0/i);
  assert.doesNotMatch(group, /box-shadow\s*:/i);
  assert.match(group, /border\s*:\s*1px/i);
  assert.match(css, /(?:\.monthly-review-item[^,{]*|\.monthly-review-list\s+li)[^{]*\{[^}]*overflow-wrap\s*:\s*anywhere/is);
  assert.match(css, /\.monthly-review-action\s*\{[^}]*min-height\s*:\s*44px/is);
  assert.match(css, /\.monthly-review-action:focus-visible\s*\{[^}]*outline\s*:/is);
});

test('paycheck cards fit long content and preserve action hierarchy', () => {
  assert.match(css, /\.paychecks-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\(auto-fill\s*,\s*minmax\(min\(280px\s*,\s*100%\)\s*,\s*1fr\)\)/is);
  assert.match(css, /\.paycheck-card\s*\{[^}]*min-width\s*:\s*0/is);
  assert.match(css, /\.paycheck-card\s+\.paycheck-header\s*\{[^}]*(?:flex-wrap\s*:\s*wrap|display\s*:\s*grid)/is);
  assert.match(css, /\.paycheck-actions\s*\{[^}]*min-width\s*:\s*0/is);
  assert.match(css, /\.paycheck-actions\s*\{[^}]*flex-wrap\s*:\s*wrap/is);
  assert.match(css, /\.paycheck-card\s+\.paycheck-earner\s*\{[^}]*(?:overflow-wrap\s*:\s*anywhere|word-break\s*:\s*break-word)/is);
  assert.match(css, /\.paycheck-(?:amount|remaining-value)[^{]*\{[^}]*font-variant-numeric\s*:\s*tabular-nums/is);
  const narrow = responsiveAt(640);
  assert.match(narrow, /\.paychecks-grid\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|minmax\(0\s*,\s*1fr\))/is);
  assert.match(narrow, /(?:\.btn-edit|\.btn-move|\.btn-delete)[^{]*\{[^}]*min-(?:height|width)\s*:\s*44px/is);
});

test('expense ledger scrolls locally without hiding columns or labels', () => {
  assert.match(css, /\.category-items\s*\{[^}]*overflow-x\s*:\s*auto/is);
  assert.match(css, /[^{}]*\.category-items[^{}]*\{[^}]*min-width\s*:\s*0/is);
  assert.match(css, /\.expense-table\s*\{[^}]*min-width\s*:\s*(?:\d+px|max-content|min\()/is);
  assert.match(css, /\.expense-table\s+td\.col-name\s*\{[^}]*white-space\s*:\s*normal/is);
  assert.match(css, /\.expense-table\s+td\.col-name\s*\{[^}]*overflow-wrap\s*:\s*anywhere/is);
  assert.doesNotMatch(css, /\.expense-table[^{}]*(?:\.col-name|\.col-pc|\.col-total|\.col-actual|\.col-method|\.col-actions)[^{]*\{[^}]*display\s*:\s*none/is);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
  assert.match(css, /\.expense-table\s+tbody\s+td\s*\{[^}]*padding\s*:\s*(?:[89]|1\d)px/is);
  assert.match(css, /\.expense-table\s+(?:input|select)[^{]*\{[^}]*(?:min-height\s*:\s*(?:3[6-9]|[4-9]\d)px|padding\s*:\s*(?:[89]|1\d)px)/is);
  assert.match(css, /\.expense-table\s+(?:input|td\.col-total)[^{]*\{[^}]*font-variant-numeric\s*:\s*tabular-nums/is);
});

test('allocation reflow and warning surface remain intact', () => {
  assert.match(css, /\.allocation-section\s*\{[^}]*(?:border-color|background)\s*:\s*var\(--(?:color-)?warning|--yellow\)/is);
  assert.match(css, /\.allocation-grid\s*\{[^}]*minmax\(min\(250px\s*,\s*100%\)\s*,\s*1fr\)/is);
  assert.match(css, /\.allocation-item\s*\{[^}]*min-width\s*:\s*0/is);
  const tiny = responsiveAt(360);
  assert.match(tiny, /\.allocation-item\s*\{[^}]*flex-direction\s*:\s*column/is);
  assert.match(tiny, /\.allocation-item\s+input\s*\{[^}]*width\s*:\s*100%/is);
});

test('bottom Budget actions retain DOM order and responsive hierarchy', () => {
  const preview = html.indexOf('id="btn-preview-recurring"');
  const copy = html.indexOf('id="btn-copy-prev"'); const clear = html.indexOf('id="btn-clear-month"');
  assert.ok(preview >= 0 && preview < copy && copy < clear, 'Budget action DOM order changed');
  const actions = css.match(/\.budget-actions\s*\{([^}]*)\}/is)?.[1] || '';
  assert.doesNotMatch(actions, /\border\s*:/i);
  assert.match(css, /\.budget-actions\s+(?:#btn-clear-month|\.btn-danger)\s*\{[^}]*margin-left\s*:\s*auto/is);
  const phone = responsiveAt(480);
  assert.match(phone, /\.budget-actions\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|minmax\(0\s*,\s*1fr\))/is);
  assert.match(phone, /\.budget-actions\s+\.btn\s*\{[^}]*width\s*:\s*100%/is);
  assert.match(phone, /\.budget-actions\s+(?:#btn-clear-month|\.btn-danger)\s*\{[^}]*margin-left\s*:\s*(?:0|unset)/is);
  assert.doesNotMatch(css, /\.budget-actions[^{}]*(?:#btn-|\.btn)[^{]*\{[^}]*\border\s*:/is);
});

test('Budget accessibility refinements extend forced colors and reduced motion', () => {
  const forced = blocksContaining(css, '@media (forced-colors: active)').join('\n');
  for (const selector of ['.budget-summary-bar', '.summary-value', '.monthly-review-group', '.monthly-review-states',
    '.paycheck-card', '.paycheck-remaining', '.category-header', '.expense-table', '.allocation-section', '.budget-actions']) {
    assert.match(forced, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(forced, /(?:#btn-clear-month|\.btn-danger)[^{]*\{[^}]*(?:border|outline)[^}]*CanvasText/is);
  const reduced = blocksContaining(css, '@media (prefers-reduced-motion: reduce)').join('\n');
  for (const selector of ['.btn', '.category-header', '.category-toggle']) {
    assert.match(reduced, new RegExp(selector.replace('.', '\\.')));
  }
  assert.doesNotMatch(css, /(?:monthly-review|paycheck|expense|category|summary)[^,{]*::(?:before|after)[^{]*\{[^}]*content\s*:/is);
});
