// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: node:test, node:assert, node:child_process, bin/uiharness.mjs, examples/demo-app/server.mjs
//
// The proof that the thing works: a real browser, a real login form, a real form submission,
// and the two claims the harness makes about itself — that identities do not evict each other,
// and that `audit` tells the truth about how the traffic was produced.
//
// Skipped when no Chromium-family browser is installed, so the unit tests still run in a bare
// container.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { findExecutable } from '../src/browser.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'bin', 'uiharness.mjs');
const PORT = 4390 + (process.pid % 200);

let browserMissing = false;
try {
  findExecutable();
} catch {
  browserMissing = true;
}

const env = {
  ...process.env,
  UIHARNESS_HOME: mkdtempSync(join(tmpdir(), 'uiharness-e2e-')),
  DEMO_BUYER_PASSWORD: 'buyer-pw',
  DEMO_OPERATOR_PASSWORD: 'operator-pw',
};

let app;

function cli(...args) {
  return execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });
}

/** Run the CLI expecting a non-zero exit, returning stdout anyway. */
function cliExpectFail(...args) {
  try {
    execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60000 });
    return null;
  } catch (err) {
    return err.stdout ?? '';
  }
}

/** Copy the demo target config, pointing it at this test run's port. */
function writeTarget(name = 'target.json', mutate = (c) => c) {
  const path = join(env.UIHARNESS_HOME, name);
  const cfg = mutate(JSON.parse(readFileSync(join(ROOT, 'examples/demo-app/target.json'), 'utf8')));
  cfg.baseUrl = `http://localhost:${PORT}`;
  writeFileSync(path, JSON.stringify(cfg));
  return path;
}

before(async () => {
  if (browserMissing) return;
  app = spawn(process.execPath, [join(ROOT, 'examples/demo-app/server.mjs'), String(PORT)], {
    env,
    stdio: 'ignore',
  });
  // Wait for the demo app to accept connections.
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://localhost:${PORT}/login`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('demo app did not start');
});

after(() => {
  if (browserMissing) return;
  try {
    cli('stop', '--force');
  } catch {
    /* session may already be gone */
  }
  app?.kill();
});

test('drives a real app through the UI', { skip: browserMissing && 'no Chromium-family browser installed' }, async (t) => {
  const target = writeTarget();

  await t.test('starts a session', () => {
    const out = cli('start', '--target', target);
    assert.match(out, /started {2}demo-app/);
  });

  await t.test('logs in through the real form', () => {
    const out = cli('login', '--as', 'buyer');
    assert.match(out, /signed in as buyer/);
  });

  await t.test('snapshot lists the page by accessible name', () => {
    const out = cli('snapshot');
    assert.match(out, /link\s+"Orders"/);
    assert.match(out, /link\s+"New order"/);
  });

  await t.test('places an order using only the UI', () => {
    cli('click', 'New order');
    cli('fill', 'Item', 'Flywheel');
    cli('fill', 'Quantity', '25');
    cli('select', 'Priority', 'Rush');
    const out = cli('click', 'Place order');
    assert.match(out, /\/orders/, 'submitting should land on the orders list');

    const orders = cli('snapshot', '--json');
    assert.match(orders, /Flywheel/, 'the new order should be visible on the page');
  });

  await t.test('two identities stay signed in simultaneously', () => {
    cli('login', '--as', 'operator');
    // If cookie jars leaked, buyer would have been evicted by operator's login.
    const asBuyer = cli('goto', '/', '--as', 'buyer');
    assert.doesNotMatch(asBuyer, /Sign in/, 'buyer was signed out when operator logged in');
    assert.match(asBuyer, /Sign out/);
  });

  await t.test('an honest run audits clean', () => {
    const out = cli('audit');
    assert.match(out, /UI-only: no unattributed API traffic/);
  });

  await t.test('navigating to an API path is caught', () => {
    cli('goto', '/api/orders', '--as', 'buyer');
    const out = cliExpectFail('audit');
    assert.ok(out !== null, 'audit should exit non-zero after an API shortcut');
    assert.match(out, /navigated-to-api/);
  });

  await t.test('a rejected login is reported as failure, not success', () => {
    // A silently-failing login is the worst outcome: the agent proceeds believing it is
    // signed in. Point an identity at a wrong password and require a loud error.
    cli('stop', '--force');
    const badTarget = writeTarget('bad.json', (cfg) => {
      cfg.identities.buyer.passwordEnv = 'DEMO_WRONG_PASSWORD';
      return cfg;
    });
    env.DEMO_WRONG_PASSWORD = 'definitely-not-the-password';
    cli('start', '--target', badTarget);
    const out = cliExpectFail('login', '--as', 'buyer');
    assert.ok(out !== null, 'login with a wrong password must exit non-zero');
  });
});
