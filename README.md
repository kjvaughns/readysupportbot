# ReadySupport

A Discord bot that does Readymode admin work — making agent accounts, clearing
licenses, resetting passwords, deactivating accounts — without anyone having to
hold the Readymode admin login.

Somebody asks, in a slash command or in plain language. ReadySupport checks
they're allowed, collects anything missing, shows exactly what it's about to
submit, waits for a human to confirm, queues the job, drives Readymode through a
predefined browser workflow, independently checks the change actually happened,
captures a screenshot, and writes an immutable audit record. If anything looks
wrong, it stops rather than guessing.

```
Account created successfully.

Agent: Marcus Smith
Username: msmith
Role: Agent
License: Standard
Campaign: Vantage
Completed at: 3:42 PM EST
Request ID: RS-1048
```

## Two things worth knowing up front

**It ships knowing nothing about the Readymode interface.** Every route, field
label, button and success message lives in one selector registry, and every
entry starts as `UNKNOWN`. Nothing in this repository is a guess about how
Readymode looks. Before the live workflows will run, an administrator captures
the real values against a real instance with `npm run discover`. Until then, a
workflow refuses to start rather than clicking something plausible.
See [docs/SELECTOR_DISCOVERY.md](docs/SELECTOR_DISCOVERY.md).

**It starts in test mode.** `READYSUPPORT_MODE` defaults to `dry_run`: workflows
sign in, navigate, find the account, check every precondition, and then stop
immediately before the click that would change anything — reporting what they
*would* have done. Going live is a deliberate change, and each mutating action
has its own switch on top of that, so they can be turned on one at a time as
their steps are verified.

## What it can do

| Command | What it does | Who |
| --- | --- | --- |
| `/create_account` | Create a Readymode agent account | SUPPORT and up |
| `/clear_license` | Release the license an agent is holding | SUPPORT and up |
| `/reset_password` | Set a new temporary password | SUPPORT and up |
| `/deactivate_account` | Deactivate an account — needs a second approver | ADMIN and up |
| `/license_usage` | Who is using licenses right now | Everyone |
| `/agent_status` | Check one agent | Everyone |
| `/recent_actions` | What ReadySupport has done lately | Everyone |
| `/login_status` | Whether it can reach Readymode, and how everything is doing | Everyone |
| `/reconnect_readymode` | Sign back in after the session expires | ADMIN and up |
| `/help` | What it can do, and how to ask | Everyone |

In one designated channel you can also just say what you need:

> "Create a Readymode account for Marcus Smith. His email is marcus@example.com.
> Make him an agent and assign him to the Vantage campaign."

> "Clear the license from John Brown."

> "Which agents are currently using licenses?"

If something is missing it asks a specific question. It never guesses an account
name, campaign, team, role or user.

## Rules it will not bend

- **Nothing changes without a named human confirming the exact values.** The
  confirmation shows the action, the target, every field that will be submitted,
  and who asked. Approvals expire after ten minutes.
- **Deactivations need a second pair of eyes** — a different OWNER or ADMIN from
  the requester. Enforced in the approval service, in the permission check, and
  by a database trigger.
- **A first name is never enough to act on.** Matching goes user ID, then
  username, then email, then a full name that resolves to exactly one person.
  Two matches means it stops and asks which one.
- **Passwords are never posted in a channel, stored, or logged.** They exist in
  memory, go out through a reply only the requester can see, and are destroyed.
  If that private reply isn't available, the password is destroyed undelivered
  rather than posted.
- **CAPTCHAs and verification codes are handed to a human.** ReadySupport never
  attempts to solve, bypass or work around a security control.
- **A failed workflow stops.** It is never retried automatically, because a job
  that failed halfway may have already changed something.

## Getting started

```bash
npm install
cp .env.example .env        # fill it in — see docs/SETUP.md
                            # apply supabase/migrations — see supabase/README.md
npm run seed:owner -- --discord-id YOUR_DISCORD_USER_ID
npm run register
npm run dev
```

For local development without credentials or a browser, set
`READYMODE_DRIVER=mock` and the whole pipeline runs against an in-memory
directory of fictional agents.

## Documentation

| | |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | How the pieces fit, and why |
| [Setup](docs/SETUP.md) | Environment variables and local development |
| [Discord setup](docs/DISCORD_SETUP.md) | Creating the application and inviting the bot |
| [Browserbase setup](docs/BROWSERBASE_SETUP.md) | The persistent context |
| [Readymode authentication](docs/READYMODE_AUTH.md) | Signing in, staying signed in, reconnecting |
| [Selector discovery](docs/SELECTOR_DISCOVERY.md) | Mapping the Readymode interface |
| [Deployment](docs/DEPLOYMENT.md) | Railway, Docker, going live |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | When something is not working |
| [Database](supabase/README.md) | Migrations and schema |

## Development

```bash
npm run typecheck
npm run lint
npm test                # unit + mocked integration
npm run test:unit       # fast; no browser
```

The integration tests drive a real Chromium against a synthetic fixture app in
this repository. Nothing in the suite touches Readymode, Browserbase, OpenAI or
a live database.
