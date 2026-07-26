// deps: node:fs, node:path, src/browser.mjs
//
// Session state that spans CLI invocations. Each `uiharness` command is a short-lived
// process, so everything that must persist — which browser, which identity is current,
// what the last snapshot's refs pointed at — lives in .uiharness/session.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class SessionError extends Error {}

/** Root for all harness state. Overridable so several sessions can coexist on one machine. */
export function harnessDir(env = process.env) {
  return env.UIHARNESS_HOME ? resolve(env.UIHARNESS_HOME) : resolve(process.cwd(), '.uiharness');
}

export function sessionPath(env = process.env) {
  return join(harnessDir(env), 'session.json');
}

export function readSession(env = process.env) {
  const path = sessionPath(env);
  if (!existsSync(path)) {
    throw new SessionError('no active session. Run `uiharness start --target <config.json>` first.');
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SessionError(`session file is corrupt (${path}): ${err.message}. Run \`uiharness stop --force\`.`);
  }
}

export function trySession(env = process.env) {
  try {
    return readSession(env);
  } catch {
    return null;
  }
}

/** Write atomically — a half-written session file would strand the browser. */
export function writeSession(session, env = process.env) {
  const dir = harnessDir(env);
  mkdirSync(dir, { recursive: true });
  const path = sessionPath(env);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(session, null, 2)}\n`);
  renameSync(tmp, path);
  return session;
}

export function clearSession(env = process.env) {
  const path = sessionPath(env);
  if (existsSync(path)) {
    writeFileSync(path, '');
    renameSync(path, `${path}.last`);
  }
}

/** Apply a mutation to the stored session and persist it in one step. */
export function updateSession(mutate, env = process.env) {
  const session = readSession(env);
  mutate(session);
  return writeSession(session, env);
}

/** True when the process is still alive; used to detect a browser that died out from under us. */
export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
