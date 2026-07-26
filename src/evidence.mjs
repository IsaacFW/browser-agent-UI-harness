// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: node:fs, node:path
//
// The run log. Everything an agent later claims about a site should be citable, so each
// action, console message, network request and screenshot lands in an append-only run
// directory. JSONL because two processes write concurrently — the CLI appends actions and
// gestures, the recorder daemon appends console and network — and line-appends do not
// interleave badly at these sizes.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const FILES = {
  actions: 'actions.jsonl',
  gestures: 'gestures.jsonl',
  console: 'console.jsonl',
  network: 'network.jsonl',
  navigations: 'navigations.jsonl',
};

/** Create a fresh run directory: runs/<iso-ish timestamp>-<label>. */
export function createRunDir(root, label = 'run') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const dir = join(root, 'runs', `${stamp}-${sanitize(label)}`);
  mkdirSync(join(dir, 'screenshots'), { recursive: true });
  return dir;
}

export function append(runDir, file, record) {
  if (!runDir) return;
  try {
    appendFileSync(join(runDir, file), `${JSON.stringify({ ts: Date.now(), ...record })}\n`);
  } catch {
    // Evidence capture must never break the run it is observing.
  }
}

export function readJsonl(runDir, file) {
  const path = join(runDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

/**
 * Record that a real user gesture happened. `audit` correlates network traffic against
 * these markers: a request with no gesture behind it did not come from the UI.
 */
export function markGesture(runDir, kind, detail) {
  append(runDir, FILES.gestures, { kind, ...detail });
}

export function screenshotPath(runDir, step, label) {
  return join(runDir, 'screenshots', `${String(step).padStart(4, '0')}-${sanitize(label)}.png`);
}

function sanitize(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'x';
}
