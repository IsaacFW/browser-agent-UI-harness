// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: (browser-injected; no imports)
//
// Turning a live page into something an agent can reason about and act on. Two hard
// requirements shape this file:
//
//   1. Refs must survive the CLI process exiting. So each element is captured together
//      with a selector that can re-find it in a later invocation. Nothing is stored as a
//      live handle, and the page's DOM is never tagged or mutated — the app under test
//      must behave exactly as it does for a human.
//   2. Output must stay small. A full accessibility dump of a real app buries the agent,
//      so only interactive and structural elements are listed, capped and summarised.

/** Elements worth showing an agent: things you can operate, plus the structure around them. */
const WALKER = function walk(maxNodes) {
  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="switch"],[role="combobox"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  // Table cells and list items are included because most applications present their actual
  // content that way; a snapshot that lists only headers tells an agent the shape of a table
  // but not what is in it. Interactive elements are collected first, so a huge table
  // truncates its own rows rather than hiding the buttons.
  const STRUCTURAL =
    'h1,h2,h3,h4,h5,h6,[role="heading"],label,legend,caption,th,td,li,dt,dd,[role="alert"],[role="status"],[role="cell"],[role="row"],[aria-live]';

  const seen = new Set();
  const out = [];
  let truncated = false;

  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"],[hidden]')) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    // Zero-size elements are real for <input type=hidden>-alikes and offscreen a11y text.
    return rect.width > 0 || rect.height > 0 || el.tagName === 'OPTION';
  };

  const text = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map(text);
      if (parts.length) return parts.join(' ');
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      if (el.labels && el.labels.length) {
        const fromLabel = Array.from(el.labels).map(text).filter(Boolean).join(' ');
        if (fromLabel) return fromLabel;
      }
      const ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
      const title = el.getAttribute('title');
      if (title && title.trim()) return title.trim();
      if (el.type === 'submit' || el.type === 'button') return el.value || '';
      const name = el.getAttribute('name');
      if (name) return name;
      return '';
    }
    if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
    const own = text(el);
    if (own) return own.slice(0, 120);
    const title = el.getAttribute('title');
    return title ? title.trim() : '';
  };

  const role = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    switch (el.tagName) {
      case 'A':
        return el.hasAttribute('href') ? 'link' : 'generic';
      case 'BUTTON':
        return 'button';
      case 'SELECT':
        return 'combobox';
      case 'TEXTAREA':
        return 'textbox';
      case 'SUMMARY':
        return 'summary';
      case 'LABEL':
        return 'label';
      case 'INPUT': {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox' || t === 'radio') return t;
        if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
        return 'textbox';
      }
      default:
        if (/^H[1-6]$/.test(el.tagName)) return 'heading';
        return el.tagName.toLowerCase();
    }
  };

  // A selector stable enough to re-find this element in a later CLI invocation.
  const selectorFor = (el) => {
    const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
    if (el.id && document.querySelectorAll(`#${esc(el.id)}`).length === 1) return `#${esc(el.id)}`;

    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && document.querySelectorAll(`#${esc(node.id)}`).length === 1) {
        parts.unshift(`#${esc(node.id)}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`);
      node = parent;
    }
    return parts.join(' > ');
  };

  const collect = (el, kind) => {
    if (seen.has(el) || !visible(el)) return;
    // A structural element that wraps something operable adds nothing: the control itself is
    // already listed, and echoing its label as a separate row is noise. Plain-text cells and
    // list items — the ones actually carrying content — have no such child and are kept.
    if (kind === 'structural' && el.querySelector(INTERACTIVE)) return;
    if (kind === 'structural' && !text(el)) return;
    if (out.length >= maxNodes) {
      truncated = true;
      return;
    }
    seen.add(el);
    const entry = {
      role: role(el),
      name: accessibleName(el),
      kind,
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
    };
    if (el.tagName === 'A' && el.getAttribute('href')) entry.href = el.getAttribute('href');
    if ('value' in el && el.type !== 'password' && typeof el.value === 'string' && el.value) {
      entry.value = el.value.slice(0, 80);
    }
    if (el.type === 'password' && el.value) entry.value = '•'.repeat(Math.min(el.value.length, 8));
    if (el.disabled) entry.disabled = true;
    if (typeof el.checked === 'boolean' && (el.type === 'checkbox' || el.type === 'radio')) entry.checked = el.checked;
    if (el.tagName === 'SELECT') {
      entry.options = Array.from(el.options)
        .slice(0, 25)
        .map((o) => o.textContent.replace(/\s+/g, ' ').trim());
    }
    out.push(entry);
  };

  document.querySelectorAll(INTERACTIVE).forEach((el) => collect(el, 'interactive'));
  document.querySelectorAll(STRUCTURAL).forEach((el) => collect(el, 'structural'));

  // Document order makes the listing read like the page rather than like two lists.
  out.sort((a, b) => {
    const ea = document.querySelector(a.selector);
    const eb = document.querySelector(b.selector);
    if (!ea || !eb) return 0;
    const rel = ea.compareDocumentPosition(eb);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return {
    url: location.href,
    title: document.title,
    truncated,
    nodes: out.map((n, i) => ({ ref: i + 1, ...n })),
  };
};

/** Run the walker in the page and return refs plus the selectors that back them. */
export async function snapshot(page, { maxNodes = 300 } = {}) {
  return page.evaluate(WALKER, maxNodes);
}

/** Render a snapshot as the compact listing an agent reads. */
export function formatSnapshot(snap, { showStructural = true } = {}) {
  const lines = [`# ${snap.title || '(untitled)'}`, `  ${snap.url}`, ''];
  for (const n of snap.nodes) {
    if (!showStructural && n.kind === 'structural') continue;
    const bits = [`[${n.ref}]`.padStart(6), n.role.padEnd(10), n.name ? JSON.stringify(n.name) : '(no name)'];
    const extra = [];
    if (n.href) extra.push(`-> ${n.href}`);
    if (n.value !== undefined) extra.push(`value=${JSON.stringify(n.value)}`);
    if (n.checked !== undefined) extra.push(n.checked ? 'checked' : 'unchecked');
    if (n.disabled) extra.push('DISABLED');
    if (n.options) extra.push(`options=[${n.options.map((o) => JSON.stringify(o)).join(', ')}]`);
    lines.push(`${bits.join(' ')}${extra.length ? `  ${extra.join('  ')}` : ''}`);
  }
  if (snap.truncated) {
    lines.push('', '  … truncated. Narrow the page or raise --max-nodes to see the rest.');
  }
  return lines.join('\n');
}

/**
 * Find a node by ref number, or by a case-insensitive accessible-name match. Name lookup
 * is what makes configs portable — a login step can say "Sign in" instead of a brittle ref.
 */
export function findNode(snap, query) {
  if (/^\d+$/.test(String(query))) {
    const byRef = snap.nodes.find((n) => n.ref === Number(query));
    if (byRef) return byRef;
    throw new Error(`no element with ref ${query} in the current snapshot (it has ${snap.nodes.length} elements)`);
  }
  const needle = String(query).toLowerCase();
  const interactive = snap.nodes.filter((n) => n.kind === 'interactive');
  const exact = interactive.filter((n) => n.name.toLowerCase() === needle);
  if (exact.length) return exact[0];
  const partial = interactive.filter((n) => n.name.toLowerCase().includes(needle));
  if (partial.length) return partial[0];
  const anyMatch = snap.nodes.filter((n) => n.name.toLowerCase().includes(needle));
  if (anyMatch.length) return anyMatch[0];
  throw new Error(`no element matching ${JSON.stringify(query)} on ${snap.url}`);
}
