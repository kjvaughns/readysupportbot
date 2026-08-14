# Architecture

## The shape of the thing

ReadySupport is a single Node process holding four things at once: a Discord
gateway connection, a sequential job queue, a browser driver, and a small HTTP
health endpoint. Everything else is a module those four use.

```
Discord ──▶ authorize ──▶ validate ──▶ [collect] ──▶ [confirm] ──▶ queue ──▶ browser ──▶ verify ──▶ Discord
                │             │                          │            │          │           │
                └─────────────┴──────────────────────────┴────────────┴──────────┴───────────┴──▶ audit
```

Nothing skips a step. Slash commands and natural language converge on the same
submission path, so there is exactly one place where "does this need
confirming?" is decided and no way to add a command that quietly avoids it.

## The request lifecycle

```
                    ┌──────────────────────┐
                    │      PENDING         │
                    └──────────┬───────────┘
                 ┌─────────────┼──────────────┐
                 ▼             ▼              ▼
    AWAITING_INFORMATION  AWAITING_APPROVAL  APPROVED (read-only)
                 │             │              │
                 └─────────────┴──────────────┤
                               ▼              ▼
                          CANCELLED       APPROVED
                                              │
                                              ▼
                                          RUNNING
                          ┌───────────────────┼───────────────────┐
                          ▼                   ▼                   ▼
                     COMPLETED             FAILED     AUTHENTICATION_REQUIRED
                                                                  │
                                                                  ▼
                                                              APPROVED
```

Two edges are missing on purpose:

- **`RUNNING` never returns to `APPROVED`.** A job interrupted mid-flight may
  have partially completed. Re-queueing it blind is the most dangerous thing
  this system could do, so it goes to `FAILED` with a message telling a human to
  check Readymode first.
- **Terminal states have no outgoing edges at all.** A late button click on a
  finished request does nothing.

The table lives in `src/domain/status.ts` and every status write goes through
`assertTransition`.

## Modules

| Module | Responsibility |
| --- | --- |
| `config/` | Environment, validated once at boot; fails fast with a full report |
| `domain/` | Actions, statuses, roles, error categories — the shared vocabulary |
| `db/` | Supabase client and one repository per table; no ad-hoc queries elsewhere |
| `auth/` | Guild, channel, user and role checks; approval policy |
| `validation/`, `util/text` | Input hygiene and untrusted-text handling |
| `approvals/` | Confirmations, nonces, expiry, the independent-approver rule |
| `queue/` | Sequential worker, execution, restart recovery |
| `readymode/` | Selector registry, browser session, matching, one workflow per action |
| `nlp/` | Message → structured action, and the guards around it |
| `audit/` | Append-only event trail |
| `notify/` | Owner alerts, deduplicated |
| `discord/` | Commands, interactions, embeds, result delivery |
| `health/` | Seven checks and an HTTP endpoint |

## Decisions worth explaining

### The Readymode driver is behind an interface

`src/readymode/port.ts` defines `ReadymodeService` — one method per action.
Two implementations satisfy it: the live Playwright driver, and an in-memory
mock. Everything above that line is written against the interface.

The mock is not scaffolding waiting to be removed. It is how the pipeline is
developed and tested without credentials, a browser, or a real agent account,
and it deliberately models the awkward cases: two people with the same name, an
agent mid-call, an account that is already deactivated.

### The interface map is data, not code

Workflows refer to selectors by stable id — `agents.search.input`,
`clearLicense.trigger.button`. The registry holds one entry per id with a
description of what it should point at, and every entry ships as `UNKNOWN`.

This exists because the alternative was guessing. Nobody writing this code has
seen the Readymode admin console, and a plausible-looking `getByLabel('Email')`
that happens to be wrong is far worse than an honest refusal — it would mean a
workflow confidently typing into the wrong field.

So: a workflow declares the ids it needs, `assertConfigured` runs before
anything is opened, and an unmapped id stops the job with
`SELECTOR_NOT_CONFIGURED` and alerts the owner. Captured values arrive as a JSON
overlay merged at boot, so re-mapping the interface after a Readymode update
means editing one file, not rewriting workflows.

### The queue is sequential, and that is the feature

All jobs share one persistent Browserbase context. Two workflows navigating it
concurrently would interleave clicks on the same pages. So: one at a time,
claimed atomically from the database with `FOR UPDATE SKIP LOCKED`.

Because the queue lives in Postgres rather than in memory, a restart loses
nothing. Pending and approved requests are still there and the next process
picks them up.

**This is why the deployment runs a single replica.** Two instances would not
corrupt the database — the claim is atomic — but they would drive the same
browser context at the same time.

### Verification is a separate read

Every mutating workflow, having acted, reloads the page and reads the state
again. A success banner is Readymode's account of what happened; the reload is
ours. A workflow that cannot confirm its own change fails rather than reporting
a qualified success, because "I think I deactivated someone" is not something to
tell an administrator.

### The model classifies; it never decides

OpenAI is given a message and asked which of seven actions it is and what fields
it states. That is all. The answer is re-validated against the Zod schema — a
model claiming completeness it does not have still lands in "I need more
information" — and then travels the identical path a slash command does:
permission check against the database, confirmation by a human, queue.

The structural defence matters more than the prompt: the model cannot name an
action that does not exist, cannot grant a permission, and cannot cause anything
to run. Credentials, cookies and tokens are never included in a prompt.

### Passwords are never written down

A generated password exists in process memory, is registered with the redaction
layer the moment it is created, is typed into a form, is delivered through a
Discord reply only the requester can see, and is then destroyed.

It is not in the database, not in the audit trail, not in a log line, and not in
a screenshot — password fields are emptied in the page *before* any capture,
rather than blurred afterwards, so the unredacted pixels never exist.

If the private reply is unavailable the password is destroyed undelivered and
the requester is told to run the reset again. There is deliberately no "retrieve
it later" path, because that would require storing it.

### Redaction has two independent layers

Key-based: any field whose *name* looks like a secret is replaced, however
deeply nested. Value-based: every secret this process knows about is scrubbed
from every log line and audit payload by exact match.

Either alone leaks eventually. The second catches the case the first cannot —
a password echoed back inside a Readymode error banner, in a field called
something innocuous.

### Everything read from Readymode is untrusted

An agent name, a campaign, a status banner — all of it is text someone typed
into a form. It is stripped of control and invisible characters, flattened to a
single line, truncated, and markdown-escaped before display. It is never
interpreted as an instruction and never sent to the model.

The same applies to Discord messages. Injection-shaped phrasing is refused
outright rather than silently stripped, because acting on a message somebody
deliberately tampered with — without telling them it was refused — is worse than
declining.

## Data model

| Table | Holds |
| --- | --- |
| `bot_users` | Discord ID → internal role. The only source of authority |
| `approved_guilds`, `approved_channels` | Where the bot will operate |
| `automation_requests` | One row per request; also the queue |
| `automation_approvals` | Confirmations, nonces, expiry, independence |
| `automation_events` | Append-only audit trail; updates and deletes are refused by trigger |
| `readymode_accounts` | Advisory cache of observed accounts |
| `browser_sessions` | Session history — no cookies, tokens or credentials |
| `system_settings` | Auth state, queue hold, failure counts |

RLS is enabled with no permissive policies. The bot uses the service role key
and enforces authorization itself; if an anon key is ever pointed at the project
by mistake, it reads nothing.

## Failure handling

| Category | What happens |
| --- | --- |
| `AUTH_EXPIRED` / `VERIFICATION_REQUIRED` | Queue held, request parked (not failed), owner alerted, work resumes on reconnect |
| `SELECTOR_NOT_CONFIGURED` / `INTERFACE_CHANGED` | Stop before acting, alert the owner, nothing changed |
| `AMBIGUOUS_MATCH` | Stop, return the candidates as a menu |
| `VERIFICATION_FAILED` | Stop, never retry, tell a human to check Readymode |
| `PERMISSION_DENIED` | Refuse, audit, alert if the requester is unknown |

Three consecutive failures alert the owner: at that point the problem is
systematic rather than one bad request.
