// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: node:test, node:assert, src/audit.mjs, src/config.mjs, src/evidence.mjs
//
// Classification is the whole value of `audit`: calling background polling a violation would
// make it useless on any real app, and missing an injected call would make it dishonest.

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { audit } from '../src/audit.mjs';
import { loadTarget } from '../src/config.mjs';
import { FILES } from '../src/evidence.mjs';

function fixture({ gestures = [], network = [], console: consoleMsgs = [] }) {
  const dir = mkdtempSync(join(tmpdir(), 'uiharness-run-'));
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  const write = (file, rows) => writeFileSync(join(dir, file), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  write(FILES.gestures, gestures);
  write(FILES.network, network);
  write(FILES.console, consoleMsgs);

  const cfgPath = join(dir, 'target.json');
  writeFileSync(cfgPath, JSON.stringify({ name: 't', baseUrl: 'http://app.test', apiPathPrefixes: ['/api'] }));
  return { dir, target: loadTarget(cfgPath) };
}

test('a gestured API call is clean', () => {
  const { dir, target } = fixture({
    gestures: [{ ts: 1000, kind: 'click' }],
    network: [{ ts: 1200, url: 'http://app.test/api/orders', method: 'GET', initiatorType: 'script', initiatorUrl: 'http://app.test/app.js' }],
  });
  const result = audit(dir, target);
  assert.equal(result.clean, true);
  assert.equal(result.counts.violations, 0);
});

test('an inline app script with no URL is still treated as the page acting', () => {
  const { dir, target } = fixture({
    gestures: [{ ts: 1000, kind: 'goto' }],
    network: [{ ts: 1100, url: 'http://app.test/api/stats', initiatorType: 'script', initiatorUrl: '' }],
  });
  assert.equal(audit(dir, target).clean, true);
});

test('background polling is an observation, not a violation', () => {
  const { dir, target } = fixture({
    gestures: [{ ts: 1000, kind: 'click' }],
    // 60s after the last gesture: a timer, not a user.
    network: [{ ts: 61000, url: 'http://app.test/api/stats', initiatorType: 'script', initiatorUrl: 'http://app.test/poll.js' }],
  });
  const result = audit(dir, target);
  assert.equal(result.clean, true, 'polling must not fail an honest run');
  assert.equal(result.counts.backgroundCalls, 1);
});

test('an injected API call is a violation regardless of timing', () => {
  const { dir, target } = fixture({
    gestures: [{ ts: 1000, kind: 'click' }],
    network: [{ ts: 1050, url: 'http://app.test/api/orders', method: 'POST', initiatorType: 'script', initiatorUrl: 'pptr:evaluate;foo' }],
  });
  const result = audit(dir, target);
  assert.equal(result.clean, false);
  assert.equal(result.violations[0].kind, 'injected-api-call');
  assert.equal(result.violations[0].severity, 'high');
});

test('navigating straight to an API path is a violation', () => {
  const { dir, target } = fixture({
    gestures: [{ ts: 1000, kind: 'goto', url: 'http://app.test/api/orders' }],
  });
  const result = audit(dir, target);
  assert.equal(result.clean, false);
  assert.equal(result.violations[0].kind, 'navigated-to-api');
});

test('navigating to a normal page is not a violation', () => {
  const { dir, target } = fixture({ gestures: [{ ts: 1, kind: 'goto', url: 'http://app.test/orders' }] });
  assert.equal(audit(dir, target).clean, true);
});

test('document loads (parser-initiated) are never violations', () => {
  const { dir, target } = fixture({
    network: [{ ts: 5000, url: 'http://app.test/api/embedded', initiatorType: 'parser', initiatorUrl: null }],
  });
  const result = audit(dir, target);
  assert.equal(result.clean, true);
  assert.equal(result.counts.backgroundCalls, 0);
});

test('failed requests and console errors are surfaced without failing the run', () => {
  const { dir, target } = fixture({
    gestures: [{ ts: 1000, kind: 'click' }],
    network: [{ ts: 1100, url: 'http://app.test/api/x', status: 500, response: true }],
    console: [{ ts: 1100, type: 'pageerror', text: 'TypeError: x is undefined' }],
  });
  const result = audit(dir, target);
  assert.equal(result.clean, true);
  assert.equal(result.counts.failedRequests, 1);
  assert.equal(result.counts.consoleErrors, 1);
});

test('an empty run audits clean rather than throwing', () => {
  const { dir, target } = fixture({});
  assert.equal(audit(dir, target).clean, true);
});
