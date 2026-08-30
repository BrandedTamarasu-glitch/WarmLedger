'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'css', 'styles.css'), 'utf8');

function blocksContaining(source, marker) {
  const blocks = [];
  let cursor = 0;
  while ((cursor = source.indexOf(marker, cursor)) !== -1) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;
    let depth = 1; let end = open + 1;
    while (end < source.length && depth) {
      if (source[end] === '{') depth += 1;
      else if (source[end] === '}') depth -= 1;
      end += 1;
    }
    if (depth === 0) blocks.push(source.slice(cursor, end));
    cursor = end;
  }
  return blocks;
}

function declaration(source, property, value) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wanted = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
  assert.match(source, new RegExp(`${escaped}\\s*:\\s*${wanted}\\s*;`, 'i'));
}

function firstRuleBody(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'is'));
  assert.ok(match, `missing ${selector} rule`);
  return match[1];
}

test('Warm Ledger defines the frozen semantic tokens and legacy aliases', () => {
  const tokens = {
    '--color-canvas': '#15130f', '--color-surface': '#1d1a16', '--color-surface-raised': '#27221c',
    '--color-divider': '#40382d', '--color-border-interactive': '#756957', '--color-text': '#f7f0e6',
    '--color-text-muted': '#b7aa9a', '--color-accent': '#e09a72', '--color-on-accent': '#24140d',
    '--color-positive': '#8fc89a', '--color-warning': '#e7bd75', '--color-danger': '#f08a80',
    '--color-info': '#8eb7c7', '--color-focus': '#f2bd91', '--space-1': '4px', '--space-2': '8px',
    '--space-3': '12px', '--space-4': '16px', '--space-5': '20px', '--space-6': '24px',
    '--space-8': '32px', '--radius-control': '10px', '--radius-card': '14px', '--radius-panel': '16px',
    '--shadow-shell': '0 8px 24px rgba(0, 0, 0, .22)',
    '--shadow-elevated': '0 18px 48px rgba(0, 0, 0, .34)'
  };
  for (const [name, value] of Object.entries(tokens)) declaration(css, name, value);

  const aliases = {
    '--bg': 'var(--color-canvas)', '--surface': 'var(--color-surface)',
    '--surface-2': 'var(--color-surface-raised)', '--border': 'var(--color-divider)',
    '--text': 'var(--color-text)', '--text-muted': 'var(--color-text-muted)',
    '--primary': 'var(--color-accent)', '--green': 'var(--color-positive)',
    '--red': 'var(--color-danger)', '--yellow': 'var(--color-warning)', '--blue': 'var(--color-info)'
  };
  for (const [name, value] of Object.entries(aliases)) declaration(css, name, value);
});

test('motion is property-targeted and reduced-motion coverage is component-scoped', () => {
  assert.doesNotMatch(css, /transition\s*:\s*all\b/i);
  const reduced = blocksContaining(css, '@media (prefers-reduced-motion: reduce)').join('\n');
  assert.ok(reduced, 'missing reduced-motion media query');
  for (const selector of ['.nav-tab', '.btn', '.category-toggle', 'dialog', '.modal', '.feedback-center']) {
    assert.match(reduced, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(reduced, /transition(?:-duration)?\s*:\s*(?:none|0(?:\.0+)?m?s|0\.01ms)/i);
  assert.doesNotMatch(reduced, /\*\s*,\s*\*::before/);
});

test('narrow shell exposes every navigation action without horizontal scrolling', () => {
  const narrow = blocksContaining(css, '@media (max-width:').join('\n');
  assert.ok(narrow, 'missing narrow-shell media query');
  assert.match(narrow, /\.nav-tabs\s*\{[^}]*(?:display\s*:\s*grid|flex-wrap\s*:\s*wrap)/is);
  assert.match(narrow, /\.nav-tabs\s*\{[^}]*(?:grid-template-columns\s*:[^;]*minmax\(0\s*,\s*1fr\)|flex-wrap\s*:\s*wrap)/is);
  assert.doesNotMatch(narrow, /\.nav-tabs[^{}]*\{[^}]*overflow-x\s*:\s*(?:auto|scroll)/is);
  assert.match(narrow, /\.nav-actions\s*\{[^}]*grid-template-columns\s*:\s*repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)/is);
  assert.doesNotMatch(narrow, /(?:\.nav-tab|\.nav-actions|\.nav-tabs)[^{]*\{[^}]*\border\s*:/is);
  assert.match(narrow, /(?:\.nav-tab|\.nav-actions\s+\.btn)[^{]*\{[^}]*min-height\s*:\s*44px/is);
});

test('feedback and focus remain reachable beneath the sticky shell', () => {
  const phone = blocksContaining(css, '@media (max-width:').join('\n');
  assert.match(phone, /\.feedback-center\s*\{[^}]*position\s*:\s*static/is);
  assert.match(phone, /\.feedback-center\s*\{[^}]*transform\s*:\s*none/is);
  assert.match(css, /#application-shell\s*\{[^}]*padding-bottom\s*:\s*(?:9[6-9]|[1-9]\d{2,})px/is);
  assert.match(css, /(?:#current-month-label|\.focus-heading)[^{]*\{[^}]*scroll-margin-top\s*:/is);
  assert.match(css, /:focus-visible\s*\{[^}]*outline\s*:\s*3px\s+solid\s+var\(--color-focus\)/is);
  assert.match(css, /:focus-visible\s*\{[^}]*outline-offset\s*:\s*(?:2|3|4)px/is);
});

test('feedback is compact at wide widths and enters flow by tablet width', () => {
  const wide = firstRuleBody(css, '.feedback-center');
  assert.match(wide, /position\s*:\s*fixed/i);
  assert.match(wide, /right\s*:\s*(?:var\([^)]*\)|\d+(?:\.\d+)?(?:px|rem))/i);
  assert.match(wide, /bottom\s*:\s*(?:var\([^)]*\)|\d+(?:\.\d+)?(?:px|rem))/i);
  assert.match(wide, /width\s*:\s*min\(\s*4(?:[01]\d|20)px\s*,/i);
  const left = wide.match(/left\s*:\s*([^;]+)/i);
  const transform = wide.match(/transform\s*:\s*([^;]+)/i);
  if (left) assert.equal(left[1].trim().toLowerCase(), 'auto');
  if (transform) assert.equal(transform[1].trim().toLowerCase(), 'none');

  const tablet = blocksContaining(css, '@media (max-width: 1200px)').join('\n');
  assert.ok(tablet, 'missing <=1200px feedback handoff');
  assert.match(tablet, /\.feedback-center\s*\{[^}]*position\s*:\s*static/is);
  assert.match(tablet, /\.feedback-center\s*\{[^}]*transform\s*:\s*none/is);
  assert.match(tablet, /#application-shell\s*\{[^}]*padding-bottom\s*:\s*0(?:px)?/is);
});

test('responsive allocation rules are retained without masking page overflow', () => {
  assert.match(css, /\.allocation-grid\s*\{[^}]*grid-template-columns\s*:\s*repeat\([^;]*minmax\(min\(250px\s*,\s*100%\)\s*,\s*1fr\)/is);
  assert.match(css, /\.allocation-item\s*\{[^}]*min-width\s*:\s*0/is);
  const tiny = blocksContaining(css, '@media (max-width: 360px)').join('\n');
  assert.match(tiny, /\.allocation-item\s*\{[^}]*flex-direction\s*:\s*column/is);
  assert.match(tiny, /\.allocation-item\s+label\s*\{[^}]*min-width\s*:\s*0/is);
  assert.match(tiny, /\.allocation-item\s+input\s*\{[^}]*width\s*:\s*100%/is);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
});

test('forced colors broadly preserves state with system colors', () => {
  const forced = blocksContaining(css, '@media (forced-colors: active)').join('\n');
  assert.ok(forced, 'missing forced-colors media query');
  for (const color of ['Canvas', 'CanvasText', 'ButtonFace', 'ButtonText', 'Highlight', 'HighlightText', 'GrayText']) {
    assert.match(forced, new RegExp(`\\b${color}\\b`, 'i'));
  }
  for (const selector of ['body', '.topnav', '.nav-tab', '.btn', 'input', 'select', '.budget-section', 'table',
    '.category-header', '.recovery-panel', 'dialog', '.modal', '.live-message', '.btn-danger', ':focus-visible']) {
    assert.match(forced, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(forced, /\.nav-tab\.active[^{]*\{[^}]*(?:Highlight|outline|border)/is);
  assert.match(forced, /:disabled[^{]*\{[^}]*GrayText/is);
});
