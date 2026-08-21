# ReadySupport — backend and Discord bot

ReadySupport is an independent Discord bot that performs approved administrative
work inside Readymode through secure, predefined browser automation.

This repository holds the backend and the bot only. The frontend website lives in
a separate repository: <https://github.com/kjvaughns/readysupport>.

## What it does

Authorized Discord users mention `@ReadySupport` and ask for help in normal
language, or use a slash command. The request is turned into one action from a
fixed list, shown back for confirmation, and only then carried out by a
predefined Playwright workflow against Readymode.

Supported requests:

| Request | Slash command |
| --- | --- |
| Create an agent account | `/create_account` |
| Create multiple agent accounts | `/create_accounts` |
| Clear an agent license | `/clear_license` |
| Reset an agent password | `/reset_password` |
| Deactivate an agent account | `/deactivate_account` |
| Check whether an agent is logged in | `/agent_status` |
| Check which agents are using licenses | `/license_usage` |
| Assign an agent to campaigns | natural language |
| Assign an agent to queues | natural language |
| Configure which states an agent receives | `/set_states` |
| Add states to an agent | `/add_states` |
| Remove states from an agent | `/remove_states` |
| Replace an agent's state assignments | `/set_states` |
| View an agent's states | `/view_states` |
| View recent ReadySupport activity | `/recent_actions` |
| Check Readymode connection status | `/connection_status` |
| Help | `/help` |

Copying one agent's state setup onto another, and setting the default states for
new agents, are available in natural language.

### Example

```
@ReadySupport can you set it up where I'm only receiving TX, VA, and OH states?
```

ReadySupport replies with exactly what will change before touching anything:

```
ReadySupport is ready to update your states.
Agent: Kaeden Vaughns
Current states: TX, FL, GA
New states: TX, VA, OH
Change type: Replace current assignments
Confirm  ·  Edit  ·  Cancel
```

After confirmation it opens Readymode, finds the one matching agent, reads the
current configuration, applies the change, saves, reopens the agent, verifies the
saved values match the request, captures a screenshot, writes the audit record,
and answers:

```
Your state configuration was updated.
Agent: Kaeden Vaughns
Assigned states: TX, VA, OH
Verified in Readymode
Request ID: RS 1048
```

If the saved values do not match, that is reported as a failure — never as a
success.

## How the pieces fit

```
Discord message ──▶ sanitize ──▶ OpenAI (parse only) ──▶ validated action
                                                              │
                                              permission ─────┤
                                              approval   ─────┤
                                                              ▼
                                        serial queue per Readymode account
                                                              │
                                                              ▼
                                      predefined Playwright workflow ──▶ verify ──▶ audit
```

The language model translates one message into one action object and nothing
else. It never selects a page, a selector, or a browser step, never sees
credentials, and never receives page content. Its answer is validated against a
closed schema; anything that does not fit becomes a question back to the user.

## Layout

```
data              The recorded interface inspection and the Help Center bank
src/api           HTTP server and frontend endpoints
src/approvals     Confirmation rules, second approver, ten-minute expiry
src/audit         Audit log
src/auth          Supabase token verification and organization access
src/config        Environment configuration and setup-mode reporting
src/database      Store interface, Supabase implementation, in-memory implementation
src/discord       Gateway client, commands, handlers, request lifecycle
src/health        Liveness and readiness
src/notifications Owner notifications
src/openai        Natural language to validated action
src/permissions   Roles and permissions
src/queue         Serial job queue and status machine
src/knowledge     Help Center bank, crawler, parser, retrieval, answering
src/readymode     Sessions, credentials, agent matching, states, navigation
src/readymode/interface   The interface registry: controls, evidence status, workflow status
src/readymode/discovery   Read-only evidence collection and selector proposal
src/readymode/selectors   Control definitions, frame-aware resolution, capabilities
src/readymode/workflows   Predefined Playwright workflows
src/security      Encryption, redaction, sanitization, errors, ids
src/types         Shared types
supabase/migrations  Database schema and row level security
tests             Unit and integration tests
```

## Running locally

```bash
npm install
cp .env.example .env      # every value is optional; see below
npm run dev
```

The service starts with no credentials at all. `GET /health` answers 200 and
`GET /ready` lists what is still missing. Add configuration a piece at a time and
watch `/ready` turn green.

```bash
npm run build       # production build
npm start           # production start
npm run typecheck
npm run lint
npm test
```

Register slash commands once the bot token is set:

```bash
npm run register:commands              # global, up to an hour to propagate
GUILD_ID=<id> npm run register:commands  # one server, applies immediately
```

Load the Help Center documentation:

```bash
npm run knowledge:seed   # stores the supplied bank; no network needed
npm run knowledge:sync   # fetches and parses the real articles
```

`knowledge:seed` stores 13 articles that carry real content and 134 that are
titles with none. Only the first group is ever answered from. `knowledge:sync`
reaches help.readymode.com, so it runs where that is reachable — on Railway
rather than from a sandbox with no egress.

## What it knows about Readymode, and how sure it is

Two separate things, kept in separate places on purpose.

**The interface registry** (`src/readymode/interface/`) says which element to
click. It is transcribed from a read-only inspection of a real administrator
account, recorded in `data/readysupport_interface_map.json`, and every control
carries its own evidence status:

| Status | Means |
| --- | --- |
| `documented` | An article or an operator described it. Nobody has seen it. |
| `discovered` | It was seen on a real screen. |
| `implemented` | ReadySupport has code for it — which says nothing about Readymode. |
| `dry_run_tested` | Run against the real account without saving. |
| `live_tested` | Run for real and verified. |
| `blocked` | Looked for and not resolvable. The reason is recorded. |
| `unsupported` | Deliberately never automated. |

Only `discovered`, `dry_run_tested` and `live_tested` may be proposed for
automation, and evidence alone still does not authorize a change: a modifying
capability additionally requires a selector profile an Owner approved for that
organization. Those are different claims — one is about the interface, the other
is about permission — and both are required.

`GET /api/readymode/capabilities` returns the whole table, including what is
blocking each workflow that is not ready.

**The knowledge bank** (`src/knowledge/`) holds public Help Center documentation
that gets quoted to people with a link to the original. It never supplies a
selector, and an article ReadySupport has not actually fetched is never answered
from — instructions written from a title are invented instructions that happen
to sound official.

Readymode Starter and Readymode iQ have different screens. Every answer says
which product it is describing, and where an article disagrees with the live
interface, the reply names the likely cause: interface version, account
permissions, or outdated documentation.

## Safety model

- **Dry run by default.** `DRY_RUN=true` means workflows read Readymode and
  report what would change, without saving. Turn it off only for a connection
  that has been verified end to end.
- **Confirmation before every change**, showing the exact before and after.
  Deactivations and bulk changes additionally need a second Owner or
  Administrator. Confirmations expire after ten minutes.
- **No identity guessing.** "I" and "my" resolve only when the Discord account is
  linked to exactly one Readymode account. An action is never performed from a
  first name; a target must match a Readymode user id, an exact username, an
  exact email, a unique exact full name, or a linked Discord user.
- **No automatic retries.** A run that may have partially completed is never
  retried on its own; a fresh request re-reads the current Readymode state first.
- **CAPTCHA and multi-factor prompts are never bypassed.** The queue pauses, an
  Owner is notified, the request is marked as authentication required, and work
  resumes only after reconnecting through the frontend.
- **Nothing about Readymode's markup is assumed.** Controls are resolved through
  a discovery system that accepts a match only when exactly one element is found,
  in exactly one frame. If the right control cannot be identified, the workflow
  stops and reports that it needs configuration. A control that legitimately
  appears once per table row — the per-row "Sign Out" on License Usage — is
  resolved by matching the row to the account it belongs to, never by position.
- **Arrival is confirmed by the screen, not the address.** Navigation goes to the
  inspected route and then waits for the panel heading. A legacy shell answers
  with a page whether or not the screen opened, so believing the URL would have
  every workflow acting on whatever was already there.
- **Evidence is metadata.** Discovery records labels, element types, routes,
  frame names, table headings and selector attributes. It never reads a field
  value, a tick box, a cookie, storage, or the body of a table. A dropdown's
  options are captured only when the field's identity says it lists a
  configuration vocabulary rather than people.
- **Every request is classified** as a question, a read-only check, a proposed
  change, an approved change, or something ReadySupport will not do. Before a
  change runs, the confirmation shows what was understood, what would change,
  whose account it touches, which controls it would use and where each selector
  came from, what approval is required, and what success would look like.
- **Untrusted input.** Discord messages and Readymode page content are treated as
  data, never as instructions. Instruction-like text is neutralized before it
  reaches the model and recorded in the audit log.
- **Credentials.** The Readymode password is encrypted with AES-256-GCM the
  moment it arrives, with a unique initialization value per record and the
  organization bound in as authenticated data. It is never returned by an
  endpoint, never logged, never sent to OpenAI, and never written into Discord.

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for Railway, Supabase, Discord, Browserbase
and Readymode setup.
