// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: puppeteer-core, node:child_process, node:fs, node:net
//
// Finding and launching a Chromium-family browser. Deliberately does NOT download one:
// the harness drives whatever the machine already has, because the browser under test
// should be the browser the humans use. Detection order is explicit so a wrong pick is
// diagnosable rather than mysterious.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import puppeteer from 'puppeteer-core';

/**
 * Candidate executables, most-specific first. The single most common setup failure is a
 * tool hardcoding Google Chrome's path on a machine that only has Chromium, so every
 * common packaging of both is listed.
 */
const CANDIDATES = [
  '/opt/google/chrome/chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const ON_PATH = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome'];

export class BrowserError extends Error {}

/**
 * Resolve a browser executable. UIHARNESS_BROWSER wins outright so a user can always
 * override a bad guess.
 */
export function findExecutable(env = process.env) {
  if (env.UIHARNESS_BROWSER) {
    if (!existsSync(env.UIHARNESS_BROWSER)) {
      throw new BrowserError(`UIHARNESS_BROWSER points at a file that does not exist: ${env.UIHARNESS_BROWSER}`);
    }
    return env.UIHARNESS_BROWSER;
  }
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  for (const name of ON_PATH) {
    try {
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split('\n')[0]
        .trim();
      if (found && existsSync(found)) return found;
    } catch {
      // not on PATH; keep looking
    }
  }
  throw new BrowserError(
    'no Chromium-family browser found.\n' +
      '  Install Chrome or Chromium, or set UIHARNESS_BROWSER=/path/to/browser.\n' +
      `  Looked at: ${CANDIDATES.slice(0, 5).join(', ')} and PATH (${ON_PATH.join(', ')}).`
  );
}

/** Ask the OS for a free TCP port by binding to 0 and reading back what we got. */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * Launch a browser with remote debugging on.
 *
 * Spawned directly rather than through puppeteer.launch: puppeteer keeps the browser as a
 * piped child of the launching process, which would stop this short-lived CLI command from
 * ever exiting. The browser has to outlive the command that started it, so it gets its own
 * process group and no inherited stdio.
 */
export async function launch({ executablePath, port, headless, userDataDir, viewport, extraArgs = [] }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${viewport.width},${viewport.height}`,
    ...(headless ? ['--headless', '--disable-gpu'] : []),
    ...extraArgs,
    'about:blank',
  ];

  const child = spawn(executablePath, args, { detached: true, stdio: 'ignore' });
  child.unref();

  await waitForEndpoint(`http://127.0.0.1:${port}/json/version`, 20000);
  return { browserURL: `http://127.0.0.1:${port}`, pid: child.pid };
}

/** Poll the CDP version endpoint until the browser is actually accepting connections. */
async function waitForEndpoint(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new BrowserError(
    `browser did not open a debugging port within ${timeoutMs}ms (${url}). Last error: ${lastErr?.message ?? 'none'}`
  );
}

/** Reconnect to a browser started by an earlier command. */
export async function connect(browserURL, viewport) {
  try {
    return await puppeteer.connect({ browserURL, defaultViewport: viewport ?? null });
  } catch (err) {
    throw new BrowserError(
      `could not reach the browser at ${browserURL}: ${err.message}\n` + '  Run `uiharness start` first (or `uiharness status` to check).'
    );
  }
}
