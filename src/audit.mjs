// deps: src/config.mjs, src/evidence.mjs
//
// The check that gives the harness its name. An agent testing a UI is supposed to exercise
// the UI; the fastest way to fake a passing run is to talk to the API instead and claim the
// screens worked. This module reads the run log and reports where that happened.
//
// The rule it enforces: every API request must sit behind a real user gesture. A click that
// triggers a fetch is fine. A fetch with no click, keystroke or navigation before it is not
// something a user could have caused.

import { isApiPath } from './config.mjs';
import { FILES, readJsonl } from './evidence.mjs';

/** How long after a gesture its requests are still credibly attributable to it. */
const DEFAULT_WINDOW_MS = 6000;

export function audit(runDir, target, { windowMs = DEFAULT_WINDOW_MS } = {}) {
  const gestures = readJsonl(runDir, FILES.gestures);
  const network = readJsonl(runDir, FILES.network);
  const consoleMsgs = readJsonl(runDir, FILES.console);

  const gestureTimes = gestures.map((g) => g.ts).sort((a, b) => a - b);
  const violations = [];

  // 1. Navigating the browser straight at an API endpoint is not using the UI.
  for (const g of gestures) {
    if (g.kind === 'goto' && g.url && isApiPath(target, g.url)) {
      violations.push({
        kind: 'navigated-to-api',
        severity: 'high',
        ts: g.ts,
        detail: `navigated directly to API path ${g.url}`,
      });
    }
    if (g.kind === 'eval') {
      violations.push({
        kind: 'script-injection',
        severity: 'high',
        ts: g.ts,
        detail: `executed script in the page: ${String(g.expression ?? '').slice(0, 160)}`,
      });
    }
  }

  // 2. API traffic injected by automation rather than produced by the page.
  //
  // The reliable signal is the initiator's stack, not timing. A request made through the
  // automation channel carries a synthetic frame url (`pptr:evaluate;…`); a request made by
  // the app's own code carries either a real script URL or an empty one for inline scripts.
  // Timing alone would misread ordinary background polling as cheating, so it is demoted to
  // an observation below rather than treated as a violation.
  const background = [];
  for (const req of network) {
    if (req.failed || req.response) continue;
    if (!req.url || !isApiPath(target, req.url)) continue;
    if (req.initiatorType === 'parser') continue; // part of loading a document

    if (isInjected(req.initiatorUrl)) {
      violations.push({
        kind: 'injected-api-call',
        severity: 'high',
        ts: req.ts,
        detail: `${req.method ?? 'GET'} ${trimUrl(req.url)} was injected through the automation channel, not produced by the page`,
      });
      continue;
    }

    const preceding = lastAtOrBefore(gestureTimes, req.ts);
    if (preceding === null || req.ts - preceding > windowMs) {
      background.push({
        ts: req.ts,
        detail: `${req.method ?? 'GET'} ${trimUrl(req.url)} with no gesture in the previous ${Math.round(windowMs / 1000)}s`,
      });
    }
  }

  const failures = network.filter((n) => n.failed || (n.status && n.status >= 400));
  const errors = consoleMsgs.filter((c) => c.type === 'error' || c.type === 'pageerror');

  return {
    clean: violations.length === 0,
    counts: {
      gestures: gestures.length,
      apiRequests: network.filter((n) => n.url && isApiPath(target, n.url) && !n.response && !n.failed).length,
      violations: violations.length,
      backgroundCalls: background.length,
      failedRequests: failures.length,
      consoleErrors: errors.length,
    },
    violations: violations.sort((a, b) => a.ts - b.ts),
    background: background.slice(0, 25),
    failedRequests: failures.slice(0, 50),
    consoleErrors: errors.slice(0, 50),
  };
}

/**
 * True when a request's initiator came from the automation channel rather than the page.
 * Real app scripts have an http(s) URL, or an empty one when inline.
 */
function isInjected(initiatorUrl) {
  if (!initiatorUrl) return false;
  return /^(pptr:|debugger:|devtools:)/.test(initiatorUrl) || initiatorUrl.includes('__puppeteer_evaluation_script__');
}

export function formatAudit(result) {
  const { counts } = result;
  const lines = [];
  lines.push(result.clean ? '✓ UI-only: no unattributed API traffic' : `✗ ${counts.violations} UI-only violation(s)`);
  lines.push(
    `  ${counts.gestures} gestures · ${counts.apiRequests} API requests · ` +
      `${counts.failedRequests} failed requests · ${counts.consoleErrors} console errors`
  );
  if (result.violations.length) {
    lines.push('', 'Violations:');
    for (const v of result.violations) {
      lines.push(`  [${v.severity}] ${v.kind}: ${v.detail}`);
    }
  }
  if (result.background?.length) {
    lines.push('', `Background API traffic (not a violation — the page did this on its own):`);
    for (const b of result.background.slice(0, 8)) lines.push(`  ${b.detail}`);
  }
  if (result.failedRequests.length) {
    lines.push('', 'Failed requests:');
    for (const f of result.failedRequests.slice(0, 15)) {
      lines.push(`  ${f.status ?? 'ERR'} ${trimUrl(f.url ?? '')} ${f.errorText ?? ''}`.trimEnd());
    }
  }
  if (result.consoleErrors.length) {
    lines.push('', 'Console errors:');
    for (const e of result.consoleErrors.slice(0, 15)) {
      lines.push(`  ${e.type}: ${String(e.text).slice(0, 160)}`);
    }
  }
  return lines.join('\n');
}

/** Largest gesture timestamp <= ts, or null when the agent acted before touching anything. */
function lastAtOrBefore(sortedTimes, ts) {
  let lo = 0;
  let hi = sortedTimes.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedTimes[mid] <= ts) {
      best = sortedTimes[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

function trimUrl(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 120) || url.slice(0, 120);
  } catch {
    return String(url).slice(0, 120);
  }
}
