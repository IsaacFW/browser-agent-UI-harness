// deps: puppeteer-core, src/evidence.mjs
//
// A detached daemon that stays attached to the browser for the whole session.
//
// Why a daemon at all: each `uiharness` command is a separate short-lived process. If
// console and network capture lived in those, everything a page did between commands —
// which is most of what an SPA does — would go unobserved, and `audit` could be trivially
// evaded by waiting. So one long-lived listener owns observation.
//
// Run as: node src/recorder.mjs <browserURL> <runDir>

import puppeteer from 'puppeteer-core';
import { FILES, append } from './evidence.mjs';

const [, , browserURL, runDir] = process.argv;

if (!browserURL || !runDir) {
  console.error('usage: node src/recorder.mjs <browserURL> <runDir>');
  process.exit(2);
}

const attached = new WeakSet();

async function attach(page) {
  if (!page || attached.has(page)) return;
  attached.add(page);

  page.on('console', (msg) => {
    const type = msg.type();
    if (type !== 'error' && type !== 'warning' && type !== 'assert') return;
    append(runDir, FILES.console, {
      type,
      text: msg.text().slice(0, 2000),
      url: page.url(),
      location: msg.location?.() ?? null,
    });
  });

  page.on('pageerror', (err) => {
    append(runDir, FILES.console, { type: 'pageerror', text: String(err?.message ?? err).slice(0, 2000), url: page.url() });
  });

  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) append(runDir, FILES.navigations, { url: frame.url() });
  });

  // Raw CDP, because the initiator of a request — parser vs script — is not exposed on
  // puppeteer's request object and is exactly what tells a link click from a fetch().
  try {
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    cdp.on('Network.requestWillBeSent', (e) => {
      append(runDir, FILES.network, {
        url: e.request.url,
        method: e.request.method,
        resourceType: e.type,
        initiatorType: e.initiator?.type ?? 'unknown',
        initiatorUrl: e.initiator?.url ?? e.initiator?.stack?.callFrames?.[0]?.url ?? null,
        documentUrl: e.documentURL,
      });
    });
    cdp.on('Network.loadingFailed', (e) => {
      append(runDir, FILES.network, { failed: true, errorText: e.errorText, resourceType: e.type });
    });
    cdp.on('Network.responseReceived', (e) => {
      if (e.response.status >= 400) {
        append(runDir, FILES.network, {
          url: e.response.url,
          status: e.response.status,
          resourceType: e.type,
          response: true,
        });
      }
    });
  } catch {
    // Page may have closed mid-attach; nothing to record.
  }
}

const browser = await puppeteer.connect({ browserURL, defaultViewport: null });

for (const page of await browser.pages()) await attach(page);

browser.on('targetcreated', async (target) => {
  if (target.type() === 'page') {
    await attach(await target.page().catch(() => null));
  }
});

browser.on('disconnected', () => {
  append(runDir, FILES.console, { type: 'recorder', text: 'browser disconnected; recorder exiting' });
  process.exit(0);
});

append(runDir, FILES.console, { type: 'recorder', text: 'recorder attached' });
