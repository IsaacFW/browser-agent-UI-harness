// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Isaac Williams
// deps: node:http
//
// A deliberately small web app so the harness can be exercised without pointing it at
// anything real. It has the pieces that make UI testing interesting: a login form, a
// session cookie, a couple of authenticated pages, a form that mutates state, and a page
// that fetches from /api after load — which is what gives `audit` something to reason
// about.
//
// Run: node examples/demo-app/server.mjs [port]

import { createServer } from 'node:http';

const PORT = Number(process.argv[2] ?? 4173);

const USERS = {
  buyer: { password: process.env.DEMO_BUYER_PASSWORD ?? 'buyer-pw', display: 'Bailey Buyer', role: 'buyer' },
  operator: { password: process.env.DEMO_OPERATOR_PASSWORD ?? 'operator-pw', display: 'Ola Operator', role: 'operator' },
};

const sessions = new Map();
const orders = [
  { id: 1, item: 'Widget', qty: 12, status: 'open', by: 'buyer' },
  { id: 2, item: 'Sprocket', qty: 4, status: 'shipped', by: 'buyer' },
];
let nextId = 3;

const page = (title, body, user) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} · Demo</title>
<style>
 body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#faf9f7;color:#1a1a1a}
 header{display:flex;gap:1.5rem;align-items:center;padding:.9rem 1.5rem;background:#1f2933;color:#fff}
 header a{color:#cbd5e1;text-decoration:none}
 header a:hover{color:#fff}
 main{max-width:52rem;margin:2rem auto;padding:0 1.5rem}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #e2e0dc}
 label{display:block;margin:.75rem 0 .25rem;font-size:.8rem;letter-spacing:.06em;text-transform:uppercase;color:#556}
 input,select{padding:.5rem;border:1px solid #cfcdc8;border-radius:4px;font:inherit;min-width:16rem}
 button{margin-top:1rem;padding:.55rem 1.1rem;border:0;border-radius:4px;background:#2f6f4e;color:#fff;font:inherit;cursor:pointer}
 .muted{color:#667}
</style></head><body>
${user ? `<header><strong>Demo</strong><nav><a href="/">Dashboard</a> <a href="/orders">Orders</a> <a href="/orders/new">New order</a></nav><span style="margin-left:auto">${user.display}</span><a href="/logout">Sign out</a></header>` : ''}
<main>${body}</main></body></html>`;

function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .filter((p) => p[0])
  );
}

function userFor(req) {
  const { sid } = parseCookies(req);
  const username = sid && sessions.get(sid);
  return username ? { username, ...USERS[username] } : null;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
    });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const user = userFor(req);

  if (url.pathname === '/api/orders') {
    if (!user) return json(res, 401, { error: 'not signed in' });
    return json(res, 200, orders);
  }
  if (url.pathname === '/api/stats') {
    if (!user) return json(res, 401, { error: 'not signed in' });
    return json(res, 200, { open: orders.filter((o) => o.status === 'open').length, total: orders.length });
  }

  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      const { username, password } = await readBody(req);
      const record = USERS[username];
      if (!record || record.password !== password) {
        return send(res, 401, page('Sign in', loginForm('Wrong username or password.')));
      }
      const sid = `s${Math.random().toString(36).slice(2)}`;
      sessions.set(sid, username);
      return send(res, 302, '', { location: '/', 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
    }
    return send(res, 200, page('Sign in', loginForm()));
  }

  if (url.pathname === '/logout') {
    const { sid } = parseCookies(req);
    sessions.delete(sid);
    return send(res, 302, '', { location: '/login', 'set-cookie': 'sid=; Path=/; Max-Age=0' });
  }

  if (!user) return send(res, 302, '', { location: '/login' });

  if (url.pathname === '/') {
    // Fetches after load — exercises the gesture-correlation logic in `audit`.
    return send(
      res,
      200,
      page(
        'Dashboard',
        `<h1>Dashboard</h1><p class=muted>Signed in as ${user.display} (${user.role}).</p>
         <p>Open orders: <strong id=open>…</strong> of <strong id=total>…</strong></p>
         <script>
           fetch('/api/stats').then(r=>r.json()).then(d=>{
             document.getElementById('open').textContent=d.open;
             document.getElementById('total').textContent=d.total;
           });
         </script>`,
        user
      )
    );
  }

  // A page that is slow the way real ones are: a spinner held up by a data layer retrying a
  // failing request. A snapshot taken during this window is accurate but not final, which is
  // how "this page is empty" gets reported instead of "this page had not loaded yet".
  if (url.pathname === '/api/slow-data') {
    await new Promise((r) => setTimeout(r, 900));
    return json(res, 500, { error: 'flaky' });
  }
  if (url.pathname === '/slow') {
    return send(
      res,
      200,
      page(
        'Slow',
        `<h1>Slow page</h1><div id=out role=status>Loading…</div>
         <script>
           let tries = 0;
           (function attempt() {
             fetch('/api/slow-data')
               .then(r => { if (!r.ok) throw new Error('retry'); })
               .catch(() => {
                 if (++tries < 3) return setTimeout(attempt, 400);
                 document.getElementById('out').textContent = 'Bench 4 needs water';
               });
           })();
         </script>`,
        user
      )
    );
  }

  if (url.pathname === '/orders') {
    const rows = orders
      .map((o) => `<tr><td>${o.id}</td><td>${o.item}</td><td>${o.qty}</td><td>${o.status}</td></tr>`)
      .join('');
    return send(
      res,
      200,
      page('Orders', `<h1>Orders</h1><table><tr><th>ID</th><th>Item</th><th>Qty</th><th>Status</th></tr>${rows}</table>`, user)
    );
  }

  if (url.pathname === '/orders/new') {
    if (req.method === 'POST') {
      const { item, qty } = await readBody(req);
      orders.push({ id: nextId++, item, qty: Number(qty), status: 'open', by: user.username });
      return send(res, 302, '', { location: '/orders' });
    }
    return send(
      res,
      200,
      page(
        'New order',
        `<h1>New order</h1><form method=post>
           <label for=item>Item</label><input id=item name=item required>
           <label for=qty>Quantity</label><input id=qty name=qty type=number value=1 min=1>
           <label for=prio>Priority</label>
           <select id=prio name=prio><option>Normal</option><option>Rush</option></select>
           <button type=submit>Place order</button>
         </form>`,
        user
      )
    );
  }

  return send(res, 404, page('Not found', '<h1>404</h1><p>No such page.</p>', user));
});

function loginForm(error = '') {
  return `<h1>Sign in</h1>
    ${error ? `<p style="color:#b3261e">${error}</p>` : ''}
    <form method=post>
      <label for=u>Username</label><input id=u name=username autocomplete=username>
      <label for=p>Password</label><input id=p name=password type=password autocomplete=current-password>
      <button type=submit>Sign in</button>
    </form>`;
}

server.listen(PORT, () => console.log(`demo app on http://localhost:${PORT}`));
