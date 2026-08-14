# Browserbase setup

## Why this exists

Readymode's session — cookies, local storage, whatever else it keeps — lives in
a Browserbase **persistent context**, not in this application and not in the
database.

That arrangement is doing real work:

- ReadySupport almost never signs in. It reuses the stored session, so the
  admin credentials are read only on the rare occasion a genuine sign-in is
  needed.
- Nothing session-shaped is ever written to the database. `browser_sessions`
  records that a session existed and what Readymode made of it — no cookies, no
  tokens.
- A redeploy does not sign the bot out. Container restarts, image rebuilds and
  scaling events leave the Readymode session untouched.

## Create a project

1. Sign up at <https://www.browserbase.com>.
2. Create a project. Copy the **Project ID** into `BROWSERBASE_PROJECT_ID`.
3. **Settings** → **API Keys** → copy one into `BROWSERBASE_API_KEY`.

## Create the persistent context

```bash
npm run discover -- --create-context
```

That prints:

```
BROWSERBASE_CONTEXT_ID=ctx_...
```

Put it in your environment. This is the container the Readymode session will
live in, and it should be created once and kept.

## Sign in inside the context

The context starts empty, so somebody has to sign in to Readymode inside it
once, by hand.

```bash
npm run discover
```

That opens a browser session bound to the context and prints a live view URL.
Open it, sign in to Readymode as normal — including any verification step — and
the session is stored in the context.

This is also when you capture the interface selectors, since you are already
looking at the pages. See [SELECTOR_DISCOVERY.md](SELECTOR_DISCOVERY.md).

Confirm it worked:

```
/login_status
```

**Readymode sign-in** should be green.

## How sessions are used

Each job opens its own Browserbase session against the shared context, does one
workflow, and closes it. Sessions are deliberately short-lived rather than one
browser held open for hours — a browser nobody has closed in a day is a browser
whose state nobody can account for.

Because every job shares the one context, jobs run strictly one at a time. Two
workflows navigating the same context concurrently would interleave clicks on
the same pages. This is why the deployment runs a single replica.

## Costs

Every workflow, including read-only ones, opens a session. Two things follow:

- `/license_usage` and `/agent_status` are not free. The rate limits in
  `src/security/ratelimit.ts` exist partly for this.
- The health check deliberately does **not** open a browser to prove a browser
  can be opened. It reports on the most recent session instead.

## Local development without Browserbase

```bash
READYMODE_DRIVER=mock npm run dev
```

No browser, no Browserbase account, no Readymode credentials. The whole
pipeline runs against an in-memory directory of fictional agents.

For discovery against a local browser instead of a Browserbase session:

```bash
npm run discover -- --local
```

Note that a local browser does not persist anything into the Browserbase
context, so this is for looking at pages, not for establishing the session.

## When the session expires

Readymode will eventually sign the session out. What happens then is covered in
[READYMODE_AUTH.md](READYMODE_AUTH.md): the queue is held, work is parked rather
than failed, owners are alerted, and `/reconnect_readymode` picks it all back up.
