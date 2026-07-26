# Driving a UI with uiharness

You are testing a website by using it. Not by reading its code, and not by calling its API —
by clicking the things a person would click. This file is the working protocol.

## The rule

**Every interaction goes through `uiharness`.** No `curl`, no `fetch`, no reading the database
to check whether your action worked. If you want to know whether the order was created, go look
at the orders page like a user would. When you cannot find out something through the UI, that
is itself the finding — write it down instead of routing around it.

`uiharness audit` reports API traffic that no gesture explains and exits non-zero. A run that
ends dirty is a run whose conclusions do not hold.

## Loop

```bash
uiharness snapshot            # see what is on the page
uiharness click 12            # act on a ref, or on a name: uiharness click "New order"
```

Every acting command prints a fresh snapshot, so you rarely need to call `snapshot` twice in a
row. Refs are only valid for the snapshot that produced them — if the page changed underneath
you, you get an error telling you to re-snapshot rather than a silent misclick.

Element names come from the accessible name, which is what a screen reader would announce.
`uiharness click "Place order"` is more durable than a ref and much more readable in your notes.

## Starting up

```bash
uiharness start --target ./target.json     # once per session
uiharness identities                       # who you can be
uiharness login --as buyer                 # real form, real credentials
```

Identities are isolated: each has its own cookie jar, so you can log in as several people at
once and switch with `--as` without anyone getting signed out. Pass `--as` on any command, or
set a default with `uiharness use <identity>`.

If `login` reports failure, believe it — it verifies the destination rather than assuming the
form worked.

## Recording what you find

The run directory captures actions, console errors, failed requests and screenshots
automatically. Take a screenshot when you hit something worth showing:

```bash
uiharness screenshot --label empty-orders-state
uiharness console          # errors the page logged
uiharness network --api    # what it asked the server for
```

Cite these when you report. "The Orders page renders nothing and logs a TypeError
(`0007-empty-orders.png`)" is a finding. "The orders page seems broken" is not.

## Writing up

Separate the three things, because they get fixed by different people:

- **Broken** — it does not work. Include what you did, what happened, and the evidence.
- **Confusing** — it works, but you had to guess, backtrack, or count clicks. Say what you
  expected and what you found instead. This is the part only a fresh user can report, and it is
  usually the most valuable thing you will produce.
- **Missing** — the job cannot be finished in the UI at all.

Report what actually happened, including the parts where you got lost. An agent that says "I
could not find where to do this" is more useful than one that quietly found a workaround no
real user would discover.

## Do not

- Do not call the API directly, or use a shell to check the result of a UI action.
- Do not invent element names — snapshot and use what is actually there.
- Do not report a screen as working because the request succeeded. Look at it.
- Do not stop at the first error if you can keep going; collect the whole picture.
