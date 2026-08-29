'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, locateChromium, helpText } = require('../scripts/browser-evidence.js');
const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'browser-evidence.js'), 'utf8');

test('browser evidence options are deterministic and reject ambiguity', () => {
  assert.equal(parseArgs([]).output, path.join(require('node:os').tmpdir(), 'zerobudget-browser-evidence.json'));
  assert.equal(parseArgs(['--output', './evidence.json']).output, path.resolve('evidence.json'));
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs(['--unknown']), /Unknown or incomplete option/);
  assert.equal(locateChromium({ CHROMIUM_BIN: '/definitely/missing/chromium' }), null);
});

test('browser evidence help describes its isolated optional execution', () => {
  assert.match(helpText(), /disposable Chromium profile/);
  assert.match(helpText(), /OS temp directory/);
});

test('browser evidence owns a disposable, collision-free CDP endpoint and cleans it up', () => {
  assert.match(source, /--remote-debugging-port=0/);
  assert.match(source, /DevToolsActivePort/);
  assert.match(source, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\), 'zerobudget-browser-'\)\)/);
  assert.match(source, /fs\.rmSync\(profile, \{ recursive: true, force: true \}\)/);
  assert.doesNotMatch(source, /9300 \+ Math\.floor/);
  assert.doesNotMatch(source, /--no-sandbox/);
  assert.match(source, /waitForExit\(child, 2000\)/);
  assert.match(source, /child\.kill\('SIGKILL'\)/);
  assert.match(source, /!fs\.existsSync\(profile\)/);
  assert.match(source, /evidence\.profileCleanup = true/);
  assert.match(source, /const CDP_STARTUP_ATTEMPTS = 600/);
  assert.match(source, /const CDP_POLL_MS = 50/);
  assert.match(source, /width: 640, height: 450/);
  assert.doesNotMatch(source, /setPageScaleFactor/);
});
