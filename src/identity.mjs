// deps: src/actions.mjs, src/config.mjs, src/snapshot.mjs
//
// Identities are the harness's answer to a trap that catches most multi-user browser
// testing: cookies are scoped by host, NOT by port. Pointing two logins at :3000 and :3001
// on the same host puts them in one cookie jar, and the second login silently evicts the
// first. So each identity gets its own browser context — a genuinely separate jar — and a
// dedicated page inside it. Switching identity is then free and cannot leak state.

import { click, fill, goto } from './actions.mjs';
import { credentialsFor, urlFor } from './config.mjs';
import { findNode, snapshot } from './snapshot.mjs';

export class IdentityError extends Error {}

/**
 * Get (creating if needed) the context and page belonging to an identity. Contexts are
 * found by the id recorded in the session file, which survives reconnects.
 */
export async function ensureIdentity(browser, session, name, target) {
  if (!target.identities[name]) {
    const known = Object.keys(target.identities);
    throw new IdentityError(
      `unknown identity "${name}". Declared identities: ${known.length ? known.join(', ') : '(none)'}`
    );
  }
  session.identities ??= {};
  const record = session.identities[name];

  let context = null;
  if (record?.contextId) {
    context = browser.browserContexts().find((c) => c.id === record.contextId) ?? null;
  }
  if (!context) {
    context = await browser.createBrowserContext();
    session.identities[name] = { contextId: context.id, loggedIn: false };
  }

  const pages = await context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  if (target.viewport) await page.setViewport(target.viewport).catch(() => {});
  return { context, page, record: session.identities[name] };
}

/**
 * Drive the target's login form as a user would: open the login page, fill each declared
 * field, submit, then verify. Verification matters — a form that silently rejects
 * credentials otherwise looks exactly like success to an agent.
 */
export async function login(page, target, identityName, runDir) {
  const identity = credentialsFor(target, identityName);
  if (!target.login) {
    throw new IdentityError('target config has no "login" block, so `login` cannot run. Add one, or navigate manually.');
  }
  const { path = '/login', fields = [], submit, successUrlNot, successText } = target.login;

  await goto(page, urlFor(target, path), runDir);

  let snap = await snapshot(page);
  for (const field of fields) {
    const node = resolveField(snap, field);
    const value = interpolate(field.value, identity);
    if (value === undefined || value === '') {
      throw new IdentityError(
        `login field ${JSON.stringify(field.field)} for identity "${identityName}" resolved to an empty value.\n` +
          '  Check the identity\'s usernameEnv/passwordEnv are exported.'
      );
    }
    await fill(page, node, value, runDir);
    snap = await snapshot(page);
  }

  if (submit) {
    await click(page, findNode(snap, submit), runDir);
  }

  await settleAfterLogin(page);
  const finalUrl = page.url();
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? '');

  if (successUrlNot && finalUrl.includes(successUrlNot)) {
    throw new IdentityError(
      `login as "${identityName}" appears to have failed — still on ${finalUrl}.\n` +
        `  Page said: ${firstMeaningfulLine(bodyText)}`
    );
  }
  if (successText && !bodyText.includes(successText)) {
    throw new IdentityError(
      `login as "${identityName}" did not reach a page containing ${JSON.stringify(successText)} (at ${finalUrl}).`
    );
  }
  return { url: finalUrl };
}

/** Sign out through the UI control so the app clears its own session properly. */
export async function signout(page, target, runDir) {
  if (!target.signout?.control) {
    throw new IdentityError('target config has no "signout.control", so `signout` cannot run.');
  }
  const snap = await snapshot(page);
  await click(page, findNode(snap, target.signout.control), runDir);
  await settleAfterLogin(page);
  return { url: page.url() };
}

/**
 * Match a declared login field to a real element. Tries the accessible name first, then
 * falls back to input type — "password" should work without the form labelling it.
 */
function resolveField(snap, field) {
  const query = field.field ?? field.name;
  if (!query) throw new IdentityError('each login field needs a "field" naming the input');
  try {
    return findNode(snap, query);
  } catch (err) {
    const lowered = String(query).toLowerCase();
    const byType = snap.nodes.find(
      (n) => n.tag === 'input' && (lowered.includes('password') ? n.value?.startsWith('•') || n.role === 'textbox' : false)
    );
    if (lowered.includes('password')) {
      const pw = snap.nodes.find((n) => n.tag === 'input' && String(n.name).toLowerCase().includes('password'));
      if (pw) return pw;
    }
    if (byType) return byType;
    throw err;
  }
}

function interpolate(template, identity) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => identity[key] ?? '');
}

async function settleAfterLogin(page) {
  await new Promise((r) => setTimeout(r, 250));
  await page.waitForNetworkIdle({ idleTime: 400, timeout: 5000 }).catch(() => {});
}

function firstMeaningfulLine(text) {
  const line = String(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join(' | ');
  return line ? line.slice(0, 200) : '(no visible text)';
}
