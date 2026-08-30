'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const transfersJs = fs.readFileSync(path.join(root, 'js', 'transfers.js'), 'utf8');
const dashboardJs = fs.readFileSync(path.join(root, 'js', 'dashboard.js'), 'utf8');

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

function responsiveAt(width) {
  return blocksContaining(css, '@media (max-width:')
    .filter(block => Number(block.match(/max-width:\s*(\d+)px/i)?.[1]) >= width).join('\n');
}

function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function rulesFor(selector, source = css) {
  const escaped = escapeRegex(selector);
  return [...source.matchAll(new RegExp(`(?:^|})[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`, 'gis'))]
    .map(match => match[1]).join('\n');
}

test('Transfers use width-safe cards, local table scrolling, and readable financial text', () => {
  assert.match(css, /\.transfers-grid\s*\{[^}]*minmax\(min\(360px\s*,\s*100%\)\s*,\s*1fr\)/is);
  for (const selector of ['#transfers-content', '.transfers-grid', '.transfer-card', '.transfer-card-header',
    '.transfer-action', '.transfer-action-header']) {
    assert.match(css, new RegExp(`${escapeRegex(selector)}\\s*\\{[^}]*min-width\\s*:\\s*0`, 'is'));
  }
  assert.match(rulesFor('.transfer-card-header') + rulesFor('.transfer-action-header'), /(?:flex-wrap\s*:\s*wrap|display\s*:\s*grid)/i);
  for (const selector of ['.transfer-earner', '.transfer-action-label', '.transfer-detail-table .td-name',
    '.transfer-detail-table .td-cat']) {
    assert.match(css, new RegExp(`${escapeRegex(selector)}[^{}]*\\{[^}]*(?:overflow-wrap\\s*:\\s*anywhere|word-break\\s*:\\s*break-word)`, 'is'));
  }
  const detail = rulesFor('.transfer-detail-table');
  assert.match(detail, /min-width\s*:\s*0/i);
  assert.match(detail, /table-layout\s*:\s*fixed/i);
  assert.match(rulesFor('.transfer-summary'), /max-width\s*:\s*100%/i);
  assert.match(rulesFor('.transfer-summary'), /overflow-x\s*:\s*auto/i);
  assert.match(rulesFor('.transfer-summary-table'), /min-width\s*:\s*(?:min\(|\d+px|max-content)/i);
  assert.match(css, /(?:\.transfer-date|\.transfer-amount|\.transfer-action-amount|\.td-amt)[^{]*\{[^}]*font-variant-numeric\s*:\s*tabular-nums/is);
  assert.doesNotMatch(css, /\.transfer-(?:detail|summary)-table[^{}]*(?:th|td|tr)[^{]*\{[^}]*display\s*:\s*none/is);
});

test('Dashboard preserves its two-column hierarchy and reflows controls and wide cards', () => {
  assert.match(rulesFor('.dashboard-grid'), /grid-template-columns\s*:\s*(?:repeat\(2\s*,\s*minmax\(0\s*,\s*1fr\)\)|minmax\(0\s*,\s*1fr\)\s+minmax\(0\s*,\s*1fr\))/i);
  assert.match(rulesFor('.dash-card'), /min-width\s*:\s*0/i);
  assert.match(rulesFor('.dash-card.wide'), /grid-column\s*:\s*span\s+2/i);
  assert.match(rulesFor('.date-range'), /flex-wrap\s*:\s*wrap/i);
  assert.match(rulesFor('.date-range label'), /min-width\s*:\s*0/i);
  assert.match(rulesFor('.date-range input'), /min-height\s*:\s*44px/i);
  assert.match(rulesFor('.date-range input:focus-visible') + rulesFor(':focus-visible'), /outline\s*:/i);
  const tablet = responsiveAt(768);
  assert.match(tablet, /\.dashboard-grid\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|minmax\(0\s*,\s*1fr\))/is);
  assert.match(tablet, /\.dash-card\.wide\s*\{[^}]*grid-column\s*:\s*(?:auto|span\s+1|1\s*\/\s*-1)/is);
});

test('Dashboard charts and summary tables stay inside bounded local containers', () => {
  assert.match(rulesFor('.dash-card canvas'), /max-width\s*:\s*100%/i);
  assert.match(rulesFor('.dash-card canvas'), /display\s*:\s*block/i);
  assert.doesNotMatch(rulesFor('.dash-card canvas'), /(?:min-)?height\s*:\s*\d+px/i);
  assert.doesNotMatch(rulesFor('.dash-card'), /overflow\s*:\s*hidden/i);
  assert.match(rulesFor('.table-scroll'), /min-width\s*:\s*0/i);
  assert.match(rulesFor('.table-scroll'), /max-width\s*:\s*100%/i);
  assert.match(rulesFor('.table-scroll'), /overflow-x\s*:\s*auto/i);
  assert.match(rulesFor('.table-scroll table'), /min-width\s*:\s*(?:max-content|\d+px|min\()/i);
  assert.doesNotMatch(css, /\.table-scroll[^{}]*(?:th|td|tr)[^{]*\{[^}]*display\s*:\s*none/is);
});

test('Recovery remains gated by hidden and reflows snapshots, actions, and its storage note', () => {
  assert.match(html, /id="recovery-panel"[^>]*\shidden(?:\s|>)/i);
  assert.doesNotMatch(rulesFor('.recovery-panel'), /display\s*:\s*(?:block|grid|flex)\s*!important/i);
  const hiddenRule = rulesFor('[hidden]');
  if (hiddenRule) assert.match(hiddenRule, /display\s*:\s*none\s*!important/i);
  assert.match(css, /\.recovery-snapshots\s+li\s*\{[^}]*min-width\s*:\s*0/is);
  assert.match(css, /\.recovery-snapshots\s+li\s*(?:>\s*)?span\s*\{[^}]*overflow-wrap\s*:\s*anywhere/is);
  assert.match(rulesFor('.storage-note') + rulesFor('.recovery-panel p'), /overflow-wrap\s*:\s*anywhere/i);
  const tablet = responsiveAt(768);
  assert.match(tablet, /\.recovery-snapshots\s+li\s*\{[^}]*flex-direction\s*:\s*column/is);
  assert.match(tablet, /\.recovery-actions\s*\{[^}]*flex-direction\s*:\s*column/is);
  assert.match(tablet, /\.recovery-actions\s+\.btn\s*\{[^}]*min-height\s*:\s*44px/is);
});

test('Feedback becomes in-flow before narrow layouts and cannot obscure final content', () => {
  const narrow = responsiveAt(1200);
  assert.match(narrow, /\.feedback-center\s*\{[^}]*position\s*:\s*static/is);
  assert.match(narrow, /\.feedback-center\s*\{[^}]*transform\s*:\s*none/is);
  assert.match(rulesFor('.live-message'), /overflow-wrap\s*:\s*anywhere/i);
  assert.doesNotMatch(rulesFor('.feedback-center', narrow), /position\s*:\s*(?:fixed|sticky)/i);
});

test('native and custom dialogs preserve action order, bounded scrolling, and narrow targets', () => {
  for (const [cancel, confirm] of [['restore-cancel', 'restore-confirm'], ['recurring-preview-cancel', 'recurring-preview-apply'],
    ['unsuppress-cancel', 'unsuppress-confirm'], ['modal-cancel', 'modal-save']]) {
    assert.ok(html.indexOf(`id="${cancel}"`) < html.indexOf(`id="${confirm}"`), `${cancel} must precede ${confirm}`);
  }
  const actionRules = rulesFor('.dialog-actions') + rulesFor('.modal-footer');
  assert.doesNotMatch(actionRules, /flex-direction\s*:\s*(?:row|column)-reverse|\border\s*:/i);
  assert.match(css, /\.restore-dialog\s*\{[^}]*max-height\s*:\s*calc\(100dvh\s*-\s*2rem\)/is);
  assert.match(css, /\.restore-dialog\s*\{[^}]*overflow(?:-y)?\s*:\s*auto/is);
  assert.match(css, /\.modal\s*\{[^}]*max-height\s*:\s*calc\(100dvh\s*-\s*2rem\)/is);
  assert.match(css, /\.modal-body\s*\{[^}]*overflow-y\s*:\s*auto/is);
  const tablet = responsiveAt(768); const phone = responsiveAt(360);
  assert.match(rulesFor('.dialog-actions .btn', tablet), /min-height\s*:\s*44px/i);
  assert.match(rulesFor('.modal-footer .btn', tablet), /min-height\s*:\s*44px/i);
  assert.match(phone, /(?:\.restore-dialog|\.modal)[^{]*\{[^}]*(?:width|max-width)\s*:\s*(?:calc\([^;]*100%|min\([^;]*100%)/is);
});

test('supporting surfaces cover forced colors and reduced motion without masking or content sinks', () => {
  const forced = blocksContaining(css, '@media (forced-colors: active)').join('\n');
  for (const selector of ['.transfer-card', '.transfer-detail-table', '.transfer-summary-table', '.dashboard-controls',
    '.dash-card', '.table-scroll', '.recovery-panel', '.recovery-snapshots',
    '.live-message', '.error-message', '.restore-dialog', '.modal', '.dialog-actions',
    '.modal-footer', ':disabled', ':focus-visible']) {
    assert.match(forced, new RegExp(escapeRegex(selector)));
  }
  assert.match(forced, /(?:\.date-range\s+input|(?:^|[,\s])input(?:[,\s{]))/i);
  const reduced = blocksContaining(css, '@media (prefers-reduced-motion: reduce)').join('\n');
  for (const selector of ['.transfer-card', '.dash-card', '.feedback-center', '.live-message', '.restore-dialog',
    '.modal', '.modal-overlay']) assert.match(reduced, new RegExp(escapeRegex(selector)));
  assert.match(reduced, /(?:transition|animation)\s*:\s*none\s*!important/i);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
  assert.doesNotMatch(css, /(?:transfer|dash|recovery|snapshot|feedback|live-message|table-scroll)[^,{]*::(?:before|after)[^{]*\{[^}]*content\s*:/is);
  assert.doesNotMatch(transfersJs + dashboardJs, /\.innerHTML\s*=|insertAdjacentHTML\s*\(/i);
});
