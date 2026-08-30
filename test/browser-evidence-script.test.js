'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs, locateChromium, helpText, removeDisposableProfile } = require('../scripts/browser-evidence.js');
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
  assert.match(source, /await removeDisposableProfile\(profile\)/);
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

test('profile cleanup retries transient failures with bounded backoff and eventually succeeds', async () => {
  const calls = []; const waits = [];
  const failures = ['ENOTEMPTY', 'EBUSY'].map(code => Object.assign(new Error(code), { code }));
  const fileSystem = {
    rmSync(profile, options) {
      calls.push({ profile, options });
      const error = failures.shift(); if (error) throw error;
    },
    existsSync() { return false; }
  };
  await removeDisposableProfile('/tmp/exact-profile', {
    fileSystem, attempts: 4, initialDelayMs: 5, wait: delay => { waits.push(delay); }
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.profile === '/tmp/exact-profile'));
  assert.ok(calls.every(call => call.options.recursive === true && call.options.force === true));
  assert.deepEqual(waits, [5, 10]);
});

test('profile cleanup retries a still-present directory and proves eventual absence', async () => {
  let removals = 0; let existenceChecks = 0;
  await removeDisposableProfile('/tmp/exact-profile', {
    attempts: 3, initialDelayMs: 1, wait() {},
    fileSystem: {
      rmSync() { removals += 1; },
      existsSync() { existenceChecks += 1; return existenceChecks === 1; }
    }
  });
  assert.equal(removals, 2);
  assert.equal(existenceChecks, 2);
});

test('profile cleanup preserves terminal failures and never silently swallows them', async () => {
  const terminal = Object.assign(new Error('still busy'), { code: 'EPERM' });
  let removals = 0; const waits = [];
  await assert.rejects(removeDisposableProfile('/tmp/exact-profile', {
    attempts: 3, initialDelayMs: 2, wait: delay => { waits.push(delay); },
    fileSystem: { rmSync() { removals += 1; throw terminal; }, existsSync() { return true; } }
  }), error => error === terminal);
  assert.equal(removals, 3); assert.deepEqual(waits, [2, 4]);

  const nonTransient = Object.assign(new Error('denied'), { code: 'EACCES' });
  removals = 0;
  await assert.rejects(removeDisposableProfile('/tmp/exact-profile', {
    attempts: 6, wait() {},
    fileSystem: { rmSync() { removals += 1; throw nonTransient; }, existsSync() { return true; } }
  }), error => error === nonTransient);
  assert.equal(removals, 1);
});
