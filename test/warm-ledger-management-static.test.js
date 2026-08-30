'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const structureJs = fs.readFileSync(path.join(root, 'js', 'structure.js'), 'utf8');
const templatesJs = fs.readFileSync(path.join(root, 'js', 'templates.js'), 'utf8');

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

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return css.match(new RegExp(`(?:^|})[^{}]*${escaped}[^{}]*\\{([^}]*)\\}`, 'is'))?.[1] || '';
}

test('shipped Structure and Templates hooks remain available to the CSS grammar', () => {
  for (const hook of ['view-structure', 'view-templates', 'structure-categories-heading', 'structure-earners-heading',
    'templates-income-heading', 'templates-expenses-heading', 'btn-add-category', 'btn-add-earner',
    'btn-add-income-template', 'btn-add-expense-template']) assert.match(html, new RegExp(`id="${hook}"`));
  for (const selector of ['structure-list', 'structure-card', 'structure-subcard', 'structure-row', 'structure-identity',
    'structure-status', 'structure-actions', 'structure-subheader', 'structure-empty']) assert.match(structureJs, new RegExp(selector));
  for (const selector of ['template-list', 'template-card', 'template-name', 'template-status', 'template-details', 'template-actions']) {
    assert.match(templatesJs, new RegExp(selector));
  }
  for (const attribute of ['data-structure-type', 'data-structure-action']) assert.match(structureJs, new RegExp(attribute));
  for (const attribute of ['data-template-kind', 'data-template-action']) assert.match(templatesJs, new RegExp(attribute));
});

test('shared management layout is vertical, width-safe, and hierarchically differentiated', () => {
  assert.match(css, /\.structure-heading\s+h2[^{}]*\{[^}]*font-size\s*:\s*clamp\(26px\s*,\s*3vw\s*,\s*30px\)/is);
  assert.match(css, /\.structure-heading\s+p\s*\{[^}]*max-width\s*:\s*(?:6\d|70|7[0-2])ch/is);
  assert.match(css, /\.structure-list\s*\{[^}]*display\s*:\s*grid/is);
  assert.match(css, /\.structure-list\s*\{[^}]*gap\s*:\s*(?:1[2-6]px|var\(--space-[34]\))/is);
  for (const selector of ['.structure-list', '.structure-card', '.structure-subcard', '.structure-row',
    '.structure-identity', '.structure-actions', '.template-list', '.template-card', '.template-actions']) {
    assert.match(css, new RegExp(`[^{}]*${selector.replace('.', '\\.')}[^{}]*\\{[^}]*min-width\\s*:\\s*0`, 'is'));
  }
  const parent = ruleBody('.structure-card'); const child = ruleBody('.structure-subcard');
  assert.match(parent, /padding\s*:\s*(?:1[6-8]px|var\(--space-4\))/i);
  assert.match(child, /padding\s*:\s*(?:[89]|1[0-4])px|var\(--space-[23]\)/i);
  assert.notEqual(parent.match(/background\s*:\s*([^;]+)/i)?.[1], child.match(/background\s*:\s*([^;]+)/i)?.[1]);
  assert.doesNotMatch(parent + child, /box-shadow\s*:\s*var\(--shadow-elevated\)/i);
  assert.match(css, /\.structure-sublist\s*\{[^}]*(?:padding-left|margin-left)\s*:/is);
  assert.doesNotMatch(ruleBody('.structure-empty'), /(?:border|box-shadow)\s*:/i);
});

test('management statuses remain textual badges without dimming whole cards', () => {
  for (const word of ['Active', 'Archived']) assert.match(structureJs, new RegExp(`['\"]${word}['\"]`));
  for (const word of ['Enabled', 'Disabled', 'Archived']) assert.match(templatesJs, new RegExp(`['\"]${word}['\"]`));
  for (const selector of ['.structure-status', '.template-status']) {
    const body = ruleBody(selector);
    assert.match(body, /display\s*:\s*inline-flex/i);
    assert.match(body, /font-size\s*:\s*(?:12|13)px/i);
    assert.match(body, /border\s*:\s*1px/i);
    assert.match(body, /border-radius\s*:\s*(?:var\(--radius-control\)|999px)/i);
  }
  assert.match(css, /\.template-status\.state-disabled/);
  assert.match(css, /\.template-status\.state-archived/);
  assert.match(css, /\.structure-status\.is-archived/);
  assert.doesNotMatch(css, /(?:\.structure-card|\.structure-subcard|\.template-card)[^{]*(?:archived|disabled)[^{]*\{[^}]*opacity\s*:/is);
  assert.doesNotMatch(css, /(?:structure|template)[^,{]*::(?:before|after)[^{]*\{[^}]*content\s*:/is);
});

test('action priority preserves renderer order and disabled controls', () => {
  const structureActions = structureJs.slice(structureJs.indexOf('actions.append('), structureJs.indexOf('row.append('));
  const structureRename = structureActions.indexOf("this.actionButton('Rename'");
  const structureArchive = structureActions.indexOf('this.actionButton(record.archived');
  const structureMoveUp = structureActions.indexOf("this.moveButton('↑'");
  const structureMoveDown = structureActions.indexOf("this.moveButton('↓'");
  assert.ok(structureRename >= 0 && structureRename < structureArchive && structureArchive < structureMoveUp &&
    structureMoveUp < structureMoveDown, 'Structure action call order changed');
  assert.match(structureActions.slice(structureMoveUp, structureMoveDown), /categoryId\s*,\s*-1\s*,/);
  assert.match(structureActions.slice(structureMoveDown), /categoryId\s*,\s*1\s*,/);
  const templateActions = templatesJs.slice(templatesJs.indexOf('actions.append('), templatesJs.indexOf('item.append('));
  const templateEdit = templateActions.indexOf("this.actionButton('Edit'");
  const templateToggle = templateActions.indexOf("this.actionButton(record.enabled");
  const templateArchive = templateActions.indexOf('this.actionButton(record.archived');
  const templateMoveUp = templateActions.indexOf("this.moveButton('↑'");
  const templateMoveDown = templateActions.indexOf("this.moveButton('↓'");
  assert.ok(templateEdit >= 0 && templateEdit < templateToggle && templateToggle < templateArchive &&
    templateArchive < templateMoveUp && templateMoveUp < templateMoveDown, 'Template action call order changed');
  assert.match(templateActions.slice(templateMoveUp, templateMoveDown), /record\s*,\s*-1\s*,/);
  assert.match(templateActions.slice(templateMoveDown), /record\s*,\s*1\s*,/);
  assert.doesNotMatch(css, /(?:\.structure-actions|\.template-actions|\[data-(?:structure|template)-action)[^{]*\{[^}]*\border\s*:/is);
  for (const action of ['archive', 'restore']) {
    assert.match(css, new RegExp(`\\[data-(?:structure|template)-action=(?:["'])?${action}(?:["'])?\\]`));
  }
  assert.match(css, /\[data-(?:structure|template)-action\^=["']move-["']\]/);
  const disabled = css.match(/(?:\.structure-actions|\.template-actions)[^{]*:disabled\s*\{([^}]*)\}/is)?.[1] || '';
  assert.ok(disabled, 'missing management disabled-state treatment');
  assert.doesNotMatch(disabled, /display\s*:\s*none|pointer-events\s*:\s*none/i);
  const opacity = Number(disabled.match(/opacity\s*:\s*([\d.]+)/i)?.[1] ?? 1);
  assert.ok(opacity >= 0.45, 'disabled movement is too faint');
});

test('template definitions and forms retain semantic, readable groups', () => {
  assert.match(css, /\.template-name\s*\{[^}]*overflow-wrap\s*:\s*anywhere/is);
  assert.match(css, /\.template-details\s*\{[^}]*grid-template-columns\s*:\s*max-content\s+minmax\(0\s*,\s*1fr\)/is);
  assert.match(css, /\.template-details\s+dd\s*\{[^}]*min-width\s*:\s*0/is);
  assert.match(css, /\.template-details\s+(?:dd|dt)[^{]*\{[^}]*font-variant-numeric\s*:\s*tabular-nums/is);
  const narrow = responsiveAt(768);
  assert.match(narrow, /\.template-details\s*\{[^}]*grid-template-columns\s*:\s*(?:1fr|minmax\(0\s*,\s*1fr\))/is);
  for (const group of ['template-monthly-fields', 'template-twice-fields', 'template-anchor-fields']) {
    assert.match(css, new RegExp(`#${group}`));
  }
  assert.match(css, /#template-(?:monthly|twice|anchor)-fields[^{]*\{[^}]*(?:border|background|padding)\s*:/is);
  assert.match(css, /\.field-help\s*\{[^}]*overflow-wrap\s*:\s*anywhere/is);
  assert.doesNotMatch(ruleBody('.field-help'), /display\s*:\s*none/i);
  assert.match(css, /(?:label:has\(#field-template-enabled\)|#field-template-enabled[^,{]*\+[^,{]*label|#field-template-enabled)[^{]*\{[^}]*min-height\s*:\s*44px/is);
});

test('narrow management remains visible, wrap-safe, and touch-sized', () => {
  const tablet = responsiveAt(768); const phone = responsiveAt(480);
  assert.match(tablet, /\.structure-row[^{}]*\{[^}]*flex-direction\s*:\s*column/is);
  assert.match(tablet, /\.structure-subheader[^{}]*\{[^}]*flex-direction\s*:\s*column/is);
  assert.match(tablet, /(?:\.structure-actions|\.template-actions)\s+\.btn[^{}]*\{[^}]*min-height\s*:\s*44px/is);
  assert.match(phone, /(?:\.structure-card|\.structure-subcard|\.template-card)[^{}]*\{[^}]*padding\s*:/is);
  assert.match(phone, /(?:\.structure-actions|\.template-actions)\s*\{[^}]*grid-template-columns\s*:[^;]*minmax\(0\s*,\s*1fr\)/is);
  assert.doesNotMatch(phone, /(?:\.structure-actions|\.template-actions)[^{]*\{[^}]*\border\s*:/is);
  assert.doesNotMatch(css, /(?:html|body|html\s*,\s*body)\s*\{[^}]*overflow-x\s*:\s*hidden/is);
});

test('management forced-colors and reduced-motion coverage is explicit', () => {
  const forced = blocksContaining(css, '@media (forced-colors: active)').join('\n');
  for (const selector of ['.structure-card', '.structure-subcard', '.template-card', '.structure-status',
    '.template-status', '.structure-actions', '.template-actions', '.template-details', '.field-help',
    '#template-monthly-fields', '#field-template-enabled', ':disabled', ':focus-visible']) {
    assert.match(forced, new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(forced, /(?:\.structure-status|\.template-status)[^{]*\{[^}]*border\s*:/is);
  const reduced = blocksContaining(css, '@media (prefers-reduced-motion: reduce)').join('\n');
  for (const selector of ['.structure-card', '.structure-actions', '.template-card', '.template-actions']) {
    assert.match(reduced, new RegExp(selector.replace('.', '\\.')));
  }
  assert.match(reduced, /(?:transition|animation)\s*:\s*none/i);
});
