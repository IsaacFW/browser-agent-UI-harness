#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: src/actions.mjs, src/audit.mjs, src/browser.mjs, src/config.mjs, src/evidence.mjs,
//       src/identity.mjs, src/session.mjs, src/snapshot.mjs
//
// Command dispatch. Every command is a fresh process that reconnects to a browser started
// earlier by `start`, does one thing, records it, and disconnects — leaving the browser and
// all identity sessions exactly as they were.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as actions from '../src/actions.mjs';
import { audit, formatAudit } from '../src/audit.mjs';
import { connect, findExecutable, freePort, launch } from '../src/browser.mjs';
import { isApiPath, loadTarget, urlFor } from '../src/config.mjs';
import { FILES, createRunDir, markGesture, readJsonl, screenshotPath } from '../src/evidence.mjs';
import { ensureIdentity, login, signout } from '../src/identity.mjs';
import { clearSession, harnessDir, processAlive, readSession, runsDir, trySession, writeSession } from '../src/session.mjs';
import { findNode, formatSnapshot, snapshot } from '../src/snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDER = resolve(HERE, '../src/recorder.mjs');

const USAGE = `uiharness — drive a website as a user, so an agent's findings are about the UI

  Session
    start --target <config.json> [--headed] [--label <name>]
    status
    stop [--force]

  Identity                      each identity gets its own cookie jar
    identities
    login  --as <identity>
    signout [--as <identity>]
    use <identity>              make an identity the default for later commands

  Look
    snapshot [--interactive] [--max-nodes <n>]
    text [--max <chars>]        the page as a person reads it
    wait --gone "Loading…"      block until the page is actually ready
         --text "<expected>"    …or until expected content appears
         --ms <n> | --idle      …or a fixed pause / network quiet
    screenshot [--full] [--label <name>]
    console                     console errors and warnings since the run began
    network [--api]             requests the page made
    audit                       report API traffic with no user gesture behind it

  Act                           <target> is a ref number from snapshot, or an element name
    goto <path>
    click <target> [--double]
    fill <target> <value>
    select <target> <value>
    hover <target>
    press <key>
    back | forward | reload

  Global
    --as <identity>   act as this identity for one command
    --json            machine-readable output
`;

main().catch((err) => {
  const wantsJson = process.argv.includes('--json');
  if (wantsJson) {
    console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  } else {
    console.error(`error: ${err.message}`);
  }
  process.exit(1);
});

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flags = parseFlags(argv);
  const positional = argv.slice(1).filter((a) => !a.startsWith('--') && !isFlagValue(argv, a));

  if (!cmd || cmd === 'help' || flags.help) {
    console.log(USAGE);
    return;
  }

  switch (cmd) {
    case 'start':
      return cmdStart(flags);
    case 'status':
      return cmdStatus(flags);
    case 'stop':
      return cmdStop(flags);
    case 'identities':
      return cmdIdentities(flags);
    case 'use':
      return cmdUse(positional[0], flags);
    case 'login':
      return cmdLogin(flags);
    case 'signout':
      return cmdSignout(flags);
    case 'snapshot':
      return cmdSnapshot(flags);
    case 'text':
      return cmdText(flags);
    case 'wait':
      return cmdWait(flags);
    case 'screenshot':
      return cmdScreenshot(flags);
    case 'console':
      return cmdConsole(flags);
    case 'network':
      return cmdNetwork(flags);
    case 'audit':
      return cmdAudit(flags);
    case 'goto':
      return cmdGoto(positional[0], flags);
    case 'click':
    case 'hover':
      return cmdSimpleAction(cmd, positional[0], flags);
    case 'fill':
    case 'select':
      return cmdValueAction(cmd, positional[0], positional.slice(1).join(' '), flags);
    case 'press':
      return cmdPress(positional[0], flags);
    case 'back':
    case 'forward':
    case 'reload':
      return cmdHistory(cmd, flags);
    default:
      throw new Error(`unknown command "${cmd}". Run \`uiharness help\`.`);
  }
}

// --- session lifecycle -------------------------------------------------------

async function cmdStart(flags) {
  const existing = trySession();
  if (existing && processAlive(existing.browserPid)) {
    throw new Error(
      `a session is already running (browser pid ${existing.browserPid}).\n` +
        '  Run `uiharness stop` to end it. Do NOT delete .uiharness by hand.'
    );
  }
  if (existing) {
    // A leftover file from a browser that already died. Clear it rather than making the
    // user reach for `rm -rf`, which is how run evidence gets destroyed.
    if (existing.recorderPid) safeKill(existing.recorderPid);
    clearSession();
  }
  if (!flags.target) throw new Error('start requires --target <config.json>');

  const target = loadTarget(flags.target);
  const root = harnessDir();
  mkdirSync(root, { recursive: true });

  const executablePath = findExecutable();
  const port = await freePort();
  const userDataDir = join(root, 'profile');
  mkdirSync(userDataDir, { recursive: true });

  const { browserURL, pid } = await launch({
    executablePath,
    port,
    headless: !flags.headed,
    userDataDir,
    viewport: target.viewport,
  });

  const runDir = createRunDir(runsDir(), flags.label ?? target.name);

  // Detached so the recorder outlives this process and keeps watching between commands.
  const recorder = spawn(process.execPath, [RECORDER, browserURL, runDir], {
    detached: true,
    stdio: 'ignore',
  });
  recorder.unref();

  const session = writeSession({
    targetPath: target.configPath,
    browserURL,
    browserPid: pid,
    recorderPid: recorder.pid,
    executablePath,
    headless: !flags.headed,
    runDir,
    identities: {},
    snapshots: {},
    current: Object.keys(target.identities)[0] ?? null,
    startedAt: Date.now(),
  });

  out(flags, { ok: true, browserURL, runDir, executablePath, identities: Object.keys(target.identities) }, () => {
    console.log(`started  ${target.name}  (${target.baseUrl})`);
    console.log(`  browser   ${executablePath}${flags.headed ? ' [headed]' : ' [headless]'}`);
    console.log(`  run log   ${runDir}`);
    const ids = Object.keys(target.identities);
    console.log(`  identities ${ids.length ? ids.join(', ') : '(none declared)'}`);
    if (session.current) console.log(`\nNext: uiharness login --as ${session.current}`);
  });
}

async function cmdStatus(flags) {
  const session = trySession();
  if (!session) {
    out(flags, { ok: true, running: false }, () => console.log('no active session'));
    return;
  }
  const alive = processAlive(session.browserPid);
  const target = loadTarget(session.targetPath);
  const loggedIn = Object.entries(session.identities ?? {})
    .filter(([, v]) => v.loggedIn)
    .map(([k]) => k);
  out(flags, { ok: true, running: alive, ...session, loggedIn }, () => {
    console.log(`session   ${alive ? 'running' : 'STALE (browser is gone — run `uiharness stop --force`)'}`);
    console.log(`  target    ${target.name} ${target.baseUrl}`);
    console.log(`  run log   ${session.runDir}`);
    console.log(`  current   ${session.current ?? '(none)'}`);
    console.log(`  logged in ${loggedIn.length ? loggedIn.join(', ') : '(none)'}`);
  });
}

async function cmdStop(flags) {
  const session = trySession();
  if (!session) {
    out(flags, { ok: true, stopped: false }, () => console.log('no active session'));
    return;
  }
  if (session.recorderPid) safeKill(session.recorderPid);
  if (!flags.force) {
    try {
      const browser = await connect(session.browserURL);
      await browser.close();
    } catch {
      if (session.browserPid) safeKill(session.browserPid);
    }
  } else if (session.browserPid) {
    safeKill(session.browserPid);
  }
  clearSession();
  out(flags, { ok: true, stopped: true, runDir: session.runDir }, () => {
    console.log(`stopped. run log kept at ${session.runDir}`);
  });
}

// --- identity ----------------------------------------------------------------

async function cmdIdentities(flags) {
  const session = trySession();
  const target = loadTarget(session ? session.targetPath : requireFlag(flags, 'target'));
  const rows = Object.entries(target.identities).map(([name, spec]) => ({
    name,
    username: spec.username ?? null,
    description: spec.description ?? null,
    loggedIn: Boolean(session?.identities?.[name]?.loggedIn),
    current: session?.current === name,
  }));
  out(flags, { ok: true, identities: rows }, () => {
    if (!rows.length) return console.log('no identities declared in the target config');
    for (const r of rows) {
      const marks = [r.current ? 'current' : null, r.loggedIn ? 'logged in' : null].filter(Boolean);
      console.log(`  ${r.name.padEnd(16)} ${(r.username ?? '').padEnd(24)} ${marks.join(', ')}`);
      if (r.description) console.log(`  ${' '.repeat(16)} ${r.description}`);
    }
  });
}

async function cmdUse(name, flags) {
  if (!name) throw new Error('use requires an identity name');
  const { session, target } = context();
  if (!target.identities[name]) throw new Error(`unknown identity "${name}"`);
  session.current = name;
  writeSession(session);
  out(flags, { ok: true, current: name }, () => console.log(`current identity: ${name}`));
}

async function cmdLogin(flags) {
  await withPage(flags, async ({ page, target, identity, session, runDir }) => {
    const result = await login(page, target, identity, runDir);
    session.identities[identity].loggedIn = true;
    session.current = identity;
    await storeSnapshot(page, session, identity);
    writeSession(session);
    out(flags, { ok: true, identity, url: result.url }, () => {
      console.log(`✓ signed in as ${identity}  (isolated context)`);
      console.log(`  now at ${result.url}`);
    });
  });
}

async function cmdSignout(flags) {
  await withPage(flags, async ({ page, target, identity, session, runDir }) => {
    const result = await signout(page, target, runDir);
    session.identities[identity].loggedIn = false;
    writeSession(session);
    out(flags, { ok: true, identity, url: result.url }, () => console.log(`signed out ${identity} → ${result.url}`));
  });
}

// --- looking -----------------------------------------------------------------

async function cmdSnapshot(flags) {
  await withPage(flags, async ({ page, session, identity }) => {
    const snap = await storeSnapshot(page, session, identity, flags['max-nodes'] ? Number(flags['max-nodes']) : undefined);
    writeSession(session);
    out(flags, { ok: true, ...snap }, () => {
      console.log(formatSnapshot(snap, { showStructural: !flags.interactive }));
      if (snap.busy) console.log(BUSY_HINT);
    });
  });
}

async function cmdWait(flags) {
  await withPage(flags, async ({ page, session, identity, runDir }) => {
    const result = await actions.waitFor(
      page,
      {
        text: flags.text,
        gone: flags.gone,
        ms: flags.ms,
        idle: flags.idle,
        timeout: flags.timeout ? Number(flags.timeout) : undefined,
      },
      runDir
    );
    const fresh = await storeSnapshot(page, session, identity);
    writeSession(session);
    out(flags, { ok: true, ...result, snapshot: fresh }, () => {
      console.log(`waited ${result.waited}ms — ${result.reason}`);
      console.log(formatSnapshot(fresh, { showStructural: !flags.interactive }));
    });
  });
}

/** The page as prose — what a person reads, rather than what they can operate. */
async function cmdText(flags) {
  await withPage(flags, async ({ page }) => {
    const body = await page.evaluate(() => document.body?.innerText ?? '');
    const trimmed = body
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l, i, arr) => l.trim() || arr[i - 1]?.trim())
      .join('\n')
      .slice(0, Number(flags.max ?? 8000));
    out(flags, { ok: true, url: page.url(), text: trimmed }, () => console.log(trimmed));
  });
}

async function cmdScreenshot(flags) {
  await withPage(flags, async ({ page, session, identity, runDir }) => {
    session.step = (session.step ?? 0) + 1;
    const path = screenshotPath(runDir, session.step, flags.label ?? identity);
    await actions.screenshot(page, path, { fullPage: Boolean(flags.full) });
    writeSession(session);
    out(flags, { ok: true, path }, () => console.log(path));
  });
}

async function cmdConsole(flags) {
  const { session } = context();
  const rows = readJsonl(session.runDir, FILES.console).filter((r) => r.type !== 'recorder');
  out(flags, { ok: true, messages: rows }, () => {
    if (!rows.length) return console.log('no console errors or warnings recorded');
    for (const r of rows.slice(-40)) console.log(`  ${r.type.padEnd(9)} ${String(r.text).slice(0, 200)}`);
  });
}

async function cmdNetwork(flags) {
  const { session, target } = context();
  let rows = readJsonl(session.runDir, FILES.network);
  if (flags.api) rows = rows.filter((r) => r.url && isApiPath(target, r.url));
  out(flags, { ok: true, requests: rows }, () => {
    if (!rows.length) return console.log('no requests recorded');
    for (const r of rows.slice(-60)) {
      if (r.response) console.log(`  ${r.status} ${r.url}`);
      else if (r.failed) console.log(`  FAILED ${r.errorText ?? ''} ${r.resourceType ?? ''}`);
      else console.log(`  ${(r.method ?? 'GET').padEnd(6)} ${r.url}  [${r.initiatorType}]`);
    }
  });
}

async function cmdAudit(flags) {
  const { session, target } = context();
  const result = audit(session.runDir, target);
  out(flags, { ok: true, ...result }, () => console.log(formatAudit(result)));
  if (!result.clean) process.exitCode = 2;
}

// --- acting ------------------------------------------------------------------

async function cmdGoto(path, flags) {
  if (!path) throw new Error('goto requires a path or URL');
  await withPage(flags, async ({ page, session, identity, target, runDir }) => {
    const url = urlFor(target, path);
    if (isApiPath(target, url)) {
      // Not blocked — an agent may have a reason — but it is recorded and audit will say so.
      process.stderr.write(`warning: ${url} looks like an API path, not a page. This will be reported by \`audit\`.\n`);
    }
    const result = await actions.goto(page, url, runDir);
    const snap = await storeSnapshot(page, session, identity);
    writeSession(session);
    out(flags, { ok: true, ...result, title: snap.title }, () => {
      console.log(`→ ${result.url}`);
      console.log(formatSnapshot(snap, { showStructural: !flags.interactive }));
      if (result.settled === false || snap.busy) console.log(BUSY_HINT);
    });
  });
}

async function cmdSimpleAction(kind, targetRef, flags) {
  if (!targetRef) throw new Error(`${kind} requires a ref number or element name`);
  await withPage(flags, async ({ page, session, identity, runDir }) => {
    const snap = currentSnapshot(session, identity);
    const node = findNode(snap, targetRef);
    const result =
      kind === 'click'
        ? await actions.click(page, node, runDir, { dblClick: Boolean(flags.double) })
        : await actions.hover(page, node, runDir);
    const fresh = await storeSnapshot(page, session, identity);
    writeSession(session);
    reportAction(flags, kind, node, result, fresh);
  });
}

async function cmdValueAction(kind, targetRef, value, flags) {
  if (!targetRef) throw new Error(`${kind} requires a ref number or element name`);
  if (value === undefined || value === '') throw new Error(`${kind} requires a value`);
  await withPage(flags, async ({ page, session, identity, runDir }) => {
    const snap = currentSnapshot(session, identity);
    const node = findNode(snap, targetRef);
    const result =
      kind === 'fill' ? await actions.fill(page, node, value, runDir) : await actions.select(page, node, value, runDir);
    const fresh = await storeSnapshot(page, session, identity);
    writeSession(session);
    reportAction(flags, kind, node, result, fresh);
  });
}

async function cmdPress(key, flags) {
  if (!key) throw new Error('press requires a key name, e.g. Enter');
  await withPage(flags, async ({ page, session, identity, runDir }) => {
    const result = await actions.pressKey(page, key, runDir);
    const fresh = await storeSnapshot(page, session, identity);
    writeSession(session);
    out(flags, { ok: true, ...result }, () => {
      console.log(`pressed ${key}${result.navigated ? ` → ${result.url}` : ''}`);
      console.log(formatSnapshot(fresh, { showStructural: !flags.interactive }));
    });
  });
}

async function cmdHistory(kind, flags) {
  await withPage(flags, async ({ page, session, identity, runDir }) => {
    markGesture(runDir, kind, {});
    if (kind === 'back') await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    else if (kind === 'forward') await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {});
    else await page.reload({ waitUntil: 'domcontentloaded' });
    const fresh = await storeSnapshot(page, session, identity);
    writeSession(session);
    out(flags, { ok: true, url: page.url() }, () => {
      console.log(`→ ${page.url()}`);
      console.log(formatSnapshot(fresh, { showStructural: !flags.interactive }));
    });
  });
}

// --- plumbing ----------------------------------------------------------------

function context() {
  const session = readSession();
  const target = loadTarget(session.targetPath);
  return { session, target };
}

/** Connect, resolve the identity's page, run body, always disconnect (never close). */
async function withPage(flags, body) {
  const { session, target } = context();
  const identity = flags.as ?? session.current ?? Object.keys(target.identities)[0];
  if (!identity) throw new Error('no identity to act as. Declare identities in the target config, or pass --as.');

  const browser = await connect(session.browserURL, target.viewport);
  try {
    const { page } = await ensureIdentity(browser, session, identity, target);
    writeSession(session);
    await body({ browser, page, session, target, identity, runDir: session.runDir });
  } finally {
    browser.disconnect();
  }
}

async function storeSnapshot(page, session, identity, maxNodes) {
  const snap = await snapshot(page, maxNodes ? { maxNodes } : {});
  session.snapshots ??= {};
  session.snapshots[identity] = snap;
  return snap;
}

function currentSnapshot(session, identity) {
  const snap = session.snapshots?.[identity];
  if (!snap) throw new Error('no snapshot yet for this identity. Run `uiharness snapshot` first.');
  return snap;
}

function reportAction(flags, kind, node, result, fresh) {
  out(flags, { ok: true, action: kind, ref: node.ref, name: node.name, ...result, snapshot: fresh }, () => {
    const where = result.navigated ? ` → ${result.url}` : '';
    console.log(`${kind} [${node.ref}] ${JSON.stringify(node.name)}${where}`);
    console.log(formatSnapshot(fresh, { showStructural: !flags.interactive }));
    if (result.settled === false || fresh.busy) console.log(BUSY_HINT);
  });
}

/**
 * Shown when the page was still fetching at the settle deadline. A snapshot taken then is
 * accurate but not final — the difference between "this page is empty" and "this page had
 * not finished loading", which is exactly the sort of thing a UI test gets wrong.
 */
const BUSY_HINT =
  '\n  ⏳ still loading — the page was fetching when this snapshot was taken.\n' +
  '     Wait for the real content before drawing conclusions, e.g.\n' +
  '       uiharness wait --gone "Loading…"      (or --text "<what you expect>")';

function out(flags, payload, human) {
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else human();
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

/** True when `value` is consumed as a flag's argument rather than being positional. */
function isFlagValue(argv, value) {
  const idx = argv.indexOf(value);
  return idx > 0 && argv[idx - 1].startsWith('--');
}

function requireFlag(flags, name) {
  if (!flags[name]) throw new Error(`--${name} is required here (no active session to read it from)`);
  return flags[name];
}

function safeKill(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}
