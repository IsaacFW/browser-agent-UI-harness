// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: src/evidence.mjs, src/snapshot.mjs
//
// The verbs. Every one of these goes through the browser's real input path — a click is a
// dispatched mouse event at the element's coordinates, typing is real keystrokes — because
// the entire point of the harness is that the app cannot tell an agent from a person.
//
// Each verb records a gesture marker before it acts. `audit` later reads those markers to
// decide whether the traffic a page produced was actually user-driven.

import { FILES, append, markGesture } from './evidence.mjs';
import { snapshot } from './snapshot.mjs';

/** How long to wait for a page to settle after an action before giving up on it. */
const SETTLE_MS = 2500;

export class ActionError extends Error {}

/** Re-find an element captured in an earlier snapshot. */
async function locate(page, node) {
  const handle = await page.$(node.selector);
  if (!handle) {
    throw new ActionError(
      `element [${node.ref}] ${node.role} ${JSON.stringify(node.name)} is no longer on the page.\n` +
        '  The page changed since the last snapshot. Run `uiharness snapshot` again for fresh refs.'
    );
  }
  return handle;
}

/**
 * Wait for the page to stop changing. Resolves on navigation when one happens, otherwise
 * after a quiet period — an SPA route change produces no navigation event at all.
 */
async function settle(page) {
  const before = page.url();
  await new Promise((res) => setTimeout(res, 120));
  try {
    await page.waitForNetworkIdle({ idleTime: 350, timeout: SETTLE_MS });
  } catch {
    // Busy page (polling, animations). Not an error — just stop waiting.
  }
  return { navigated: page.url() !== before, url: page.url() };
}

export async function click(page, node, runDir, { dblClick = false } = {}) {
  markGesture(runDir, dblClick ? 'dblclick' : 'click', { ref: node.ref, name: node.name, role: node.role });
  const handle = await locate(page, node);
  await handle.scrollIntoView().catch(() => {});
  if (node.disabled) {
    throw new ActionError(`[${node.ref}] ${JSON.stringify(node.name)} is disabled — a user could not click it either.`);
  }
  await handle.click({ count: dblClick ? 2 : 1 });
  const result = await settle(page);
  append(runDir, FILES.actions, { action: 'click', ref: node.ref, name: node.name, ...result });
  return result;
}

export async function fill(page, node, value, runDir) {
  // Never log the value itself: fill is how passwords get entered.
  const secret = node.tag === 'input' && node.role === 'textbox' && String(node.name).toLowerCase().includes('password');
  markGesture(runDir, 'fill', { ref: node.ref, name: node.name });
  const handle = await locate(page, node);
  await handle.scrollIntoView().catch(() => {});
  await handle.click({ clickCount: 3 }).catch(() => {});
  await handle.evaluate((el) => {
    if ('value' in el) el.value = '';
  });
  await handle.type(String(value), { delay: 12 });
  const result = await settle(page);
  append(runDir, FILES.actions, {
    action: 'fill',
    ref: node.ref,
    name: node.name,
    value: secret ? '(redacted)' : String(value).slice(0, 120),
    ...result,
  });
  return result;
}

export async function select(page, node, value, runDir) {
  markGesture(runDir, 'select', { ref: node.ref, name: node.name });
  const handle = await locate(page, node);
  // Accept either the visible option label or the underlying value.
  const chosen = await handle.evaluate((el, wanted) => {
    const match =
      Array.from(el.options).find((o) => o.textContent.trim() === wanted) ??
      Array.from(el.options).find((o) => o.value === wanted) ??
      Array.from(el.options).find((o) => o.textContent.trim().toLowerCase().includes(String(wanted).toLowerCase()));
    if (!match) return null;
    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return match.textContent.trim();
  }, String(value));
  if (chosen === null) {
    throw new ActionError(`"${value}" is not an option of [${node.ref}] ${JSON.stringify(node.name)}. Options: ${(node.options ?? []).join(', ')}`);
  }
  const result = await settle(page);
  append(runDir, FILES.actions, { action: 'select', ref: node.ref, value: chosen, ...result });
  return { ...result, chosen };
}

export async function hover(page, node, runDir) {
  markGesture(runDir, 'hover', { ref: node.ref, name: node.name });
  const handle = await locate(page, node);
  await handle.hover();
  const result = await settle(page);
  append(runDir, FILES.actions, { action: 'hover', ref: node.ref, name: node.name, ...result });
  return result;
}

export async function pressKey(page, key, runDir) {
  markGesture(runDir, 'press', { key });
  await page.keyboard.press(key);
  const result = await settle(page);
  append(runDir, FILES.actions, { action: 'press', key, ...result });
  return result;
}

/**
 * Navigate. This is the one verb a real user cannot always perform (they follow links),
 * so it is recorded distinctly and `audit` flags navigations straight into API paths.
 */
export async function goto(page, url, runDir) {
  markGesture(runDir, 'goto', { url });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const result = await settle(page);
  append(runDir, FILES.actions, { action: 'goto', url, ...result });
  return result;
}

export async function screenshot(page, path, { fullPage = false } = {}) {
  await page.screenshot({ path, fullPage });
  return path;
}

/** Take a snapshot and stash its nodes so later commands can resolve refs by number. */
export async function refresh(page, maxNodes) {
  return snapshot(page, { maxNodes });
}
