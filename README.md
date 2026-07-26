# browser-agent-UI-harness

A CLI that lets an AI agent drive a website **the way a user does** — real clicks, real
typing, real login forms — instead of quietly calling the API and reporting that the screens
worked.

```console
$ uiharness start --target ./target.json
started  demo-app  (http://localhost:4173)
  browser   /usr/bin/chromium [headless]
  run log   .uiharness/runs/2026-07-26_02-26-08-demo-app
  identities buyer, operator

$ uiharness login --as buyer
✓ signed in as buyer  (isolated context)
  now at http://localhost:4173/

$ uiharness snapshot
# Dashboard · Demo
  http://localhost:4173/
   [1] link       "Dashboard"  -> /
   [2] link       "Orders"     -> /orders
   [3] link       "New order"  -> /orders/new
   [4] link       "Sign out"   -> /logout

$ uiharness click "New order"
click [3] "New order" → http://localhost:4173/orders/new
   [7] textbox    "Item"
   [9] textbox    "Quantity"  value="1"
  [11] combobox   "Priority"  value="Normal"  options=["Normal", "Rush"]
  [12] button     "Place order"

$ uiharness fill 7 "Flywheel" && uiharness select 11 Rush && uiharness click "Place order"
```

## Why not just use a browser automation library

Because three things go wrong when an agent tests a UI, and none of them are about clicking.

**The agent cheats, usually without meaning to.** Asked to "test the checkout flow", an agent
that can reach the API will reach the API — it is faster and more reliable, and the resulting
report describes an API that works and a UI nobody exercised. `uiharness audit` reads the run
log and reports API traffic that no user gesture explains, so a clean run means something.

**Multiple users collide.** Cookies are scoped by host, **not by port**. Running one login on
`:3000` and another on `:3001` puts both in the same jar, and the second login silently evicts
the first — a trap that produces confidently wrong results. Every identity here gets its own
browser context, so several users stay signed in at once on the same host.

**Findings aren't citable.** Every action, console error, failed request and screenshot lands
in an append-only run directory, so a claim about the UI can be traced to the moment it
happened.

## Install

```bash
git clone https://github.com/IsaacFW/browser-agent-UI-harness
cd browser-agent-UI-harness
npm install
npm link          # optional — gives you `uiharness` on PATH
```

Needs Node ≥ 20 and a Chromium-family browser already on the machine. The harness does **not**
download one; it drives what your users would use. Detection order is Chrome, then Chromium,
then `PATH`. Override with `UIHARNESS_BROWSER=/path/to/browser` — worth knowing, because the
most common setup failure is a tool hardcoding Chrome's path on a box that only has Chromium.

## Target configuration

A target describes the site and who can log into it. It is meant to be committed, so it may
point at a secret but may never contain one — `loadTarget` refuses to load a config with a
literal `password`, `token` or `secret` key.

```json
{
  "name": "demo-app",
  "baseUrl": "http://localhost:4173",
  "apiPathPrefixes": ["/api"],
  "login": {
    "path": "/login",
    "fields": [
      { "field": "Username", "value": "{{username}}" },
      { "field": "Password", "value": "{{password}}" }
    ],
    "submit": "Sign in",
    "successUrlNot": "/login"
  },
  "signout": { "control": "Sign out" },
  "identities": {
    "buyer": {
      "username": "buyer",
      "passwordEnv": "DEMO_BUYER_PASSWORD",
      "description": "Places orders. Cares how fast a purchase completes."
    }
  }
}
```

`field`, `submit` and `signout.control` match against an element's **accessible name**, so a
config survives markup changes that a CSS selector would not. `{{username}}` and `{{password}}`
interpolate from the identity; the password is read from the named environment variable at run
time and is never written to the run log.

`successUrlNot` is what turns a silent login failure into a loud one. Without it, a form that
rejects credentials and re-renders looks exactly like success.

## Try it

The repo ships a small demo app so you can exercise everything without pointing at anything
real:

```bash
node examples/demo-app/server.mjs &
export DEMO_BUYER_PASSWORD=buyer-pw DEMO_OPERATOR_PASSWORD=operator-pw
uiharness start --target examples/demo-app/target.json
uiharness login --as buyer
uiharness snapshot
```

## Commands

| | |
|---|---|
| `start --target <cfg>` | launch a browser and begin a run (`--headed` to watch) |
| `status` / `stop` | inspect or end the session |
| `identities` | list who you can log in as |
| `login --as <id>` / `signout` | authenticate through the real form |
| `use <id>` | set the default identity for later commands |
| `snapshot` | list the page's interactive elements with refs |
| `click` `fill` `select` `hover` `press` | act on a ref number or an element name |
| `goto` `back` `forward` `reload` | navigate |
| `screenshot [--full]` | capture to the run directory |
| `console` / `network [--api]` | what the page reported and requested |
| `audit` | API traffic with no user gesture behind it (exit 2 if any) |

Add `--json` to any command for machine-readable output, and `--as <identity>` to act as
someone other than the current one.

## How refs work

Each CLI invocation is a separate process, so a snapshot records a re-findable selector for
every element rather than a live handle. Refs stay valid until the page changes; act on a stale
one and you get a clear error telling you to re-snapshot, never a silent misclick. The page's
DOM is never tagged or modified — the app under test behaves exactly as it does for a human.

## What `audit` can and cannot see

It flags:

- **`injected-api-call`** — a request made through the automation channel rather than by the
  page. Identified by its initiator stack, not by timing.
- **`navigated-to-api`** — pointing the browser at an API path instead of using a page.

It deliberately does **not** flag background polling. An app that refreshes on a timer produces
API calls with no gesture behind them; those are reported separately as observations, because
treating them as violations would make the check cry wolf on any real application.

It cannot see a shell command. If an agent runs `curl` in another terminal, no browser-side
tool will know. `audit` raises the cost of cheating and makes the honest path the easy one; it
is not a sandbox.

## Using it from an agent

See [AGENTS.md](./AGENTS.md) for the working protocol — it is written to be dropped into an
agent's context directly.

## License

Copyright (C) 2026 Isaac Williams.

This program is free software: you can redistribute it and/or modify it under the terms of
the GNU Affero General Public License as published by the Free Software Foundation, either
version 3 of the License, or (at your option) any later version. See [LICENSE](./LICENSE).

Because this is the AGPL, running a modified version to provide a service over a network
counts as distribution: anyone who does so must offer their users the corresponding source.
