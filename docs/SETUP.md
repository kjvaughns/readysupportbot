# Setup and local development

## Requirements

- Node 22 or newer
- A Supabase project
- A Discord application ([DISCORD_SETUP.md](DISCORD_SETUP.md))
- A Browserbase project ([BROWSERBASE_SETUP.md](BROWSERBASE_SETUP.md))
- An OpenAI API key — only needed for the natural-language channel

## Environment variables

Copy `.env.example` to `.env` and fill it in. The process validates everything
at boot and refuses to start with a list of what is wrong, rather than failing
confusingly later.

### Discord

| Variable | Notes |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot → Token. Treat as a password |
| `DISCORD_CLIENT_ID` | General Information → Application ID |
| `DISCORD_GUILD_ID` | Commands are registered to this server only |
| `DISCORD_NL_CHANNEL_ID` | The one channel accepting free-form requests. Leave blank to disable |

### Supabase

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Bypasses RLS. A root credential — server only, never in a client |
| `SUPABASE_EVIDENCE_BUCKET` | Defaults to `automation-evidence` |

### OpenAI

| Variable | Notes |
| --- | --- |
| `OPENAI_API_KEY` | Used only to classify requests and extract fields |
| `OPENAI_MODEL` | Defaults to `gpt-4o-mini` |

Readymode credentials, cookies, tokens and passwords are never sent to this API.

### Browserbase

| Variable | Notes |
| --- | --- |
| `BROWSERBASE_API_KEY` | |
| `BROWSERBASE_PROJECT_ID` | |
| `BROWSERBASE_CONTEXT_ID` | The persistent context holding the Readymode session |

### Readymode

| Variable | Notes |
| --- | --- |
| `READYMODE_LOGIN_URL` | Full URL of your instance's admin sign-in page |
| `READYMODE_ADMIN_USERNAME` | |
| `READYMODE_ADMIN_PASSWORD` | Read only when a sign-in is actually needed |

### Crypto

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the result in `ENCRYPTION_KEY`.

### Behaviour

| Variable | Default | Notes |
| --- | --- | --- |
| `READYSUPPORT_MODE` | `dry_run` | `dry_run` validates everything and stops before submitting. `live` submits |
| `READYMODE_DRIVER` | `live` | `mock` uses the in-memory directory — local development and tests only |
| `ENABLE_CREATE_ACCOUNT` | `false` | Per-action switches. Even in `live` mode, an action stays off until turned on |
| `ENABLE_CLEAR_LICENSE` | `false` | |
| `ENABLE_RESET_PASSWORD` | `false` | |
| `ENABLE_DEACTIVATE_ACCOUNT` | `false` | |
| `READYMODE_SELECTOR_OVERLAY` | `config/readymode-selectors.json` | Where captured selectors are read from |

### Runtime

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Health endpoint |
| `LOG_LEVEL` | `info` | |
| `APPROVAL_TTL_MINUTES` | `10` | |
| `WORKFLOW_TIMEOUT_MS` | `120000` | Per-workflow budget |

## First run

### 1. Database

Apply the migrations in `supabase/migrations` — see
[supabase/README.md](../supabase/README.md).

### 2. First owner

Nobody can use ReadySupport until a row exists in `bot_users`, and there is no
command for adding the first one. A bot that can grant itself its own first
administrator has no meaningful access control, so this is deliberately
out-of-band, run by whoever holds the database credentials:

```bash
npm run seed:owner -- \
  --discord-id 123456789012345678 \
  --commands-channel 234567890123456789 \
  --nl-channel 345678901234567890 \
  --alerts-channel 456789012345678901
```

To find an ID: Discord → Settings → Advanced → Developer Mode, then right-click
and Copy ID.

Only `--discord-id` is required. Channels can be added later by inserting into
`approved_channels`.

### 3. Slash commands

```bash
npm run register
```

Guild-scoped, so they appear immediately.

### 4. Start

```bash
npm run dev
```

## Local development without any real services

```bash
READYMODE_DRIVER=mock npm run dev
```

The whole pipeline — permissions, approvals, queue, audit trail, Discord
experience — runs against an in-memory directory of fictional agents. No
browser, no Readymode credentials, no real account touched.

Useful mock accounts: `jbrown` (holds a license), `sgarcia` (on a call, so the
escalation path fires), `dlee` (already deactivated), and two people both called
Marcus Smith, so asking for "Marcus Smith" reliably produces the
choose-an-account flow.

You still need Supabase for the audit trail and the queue.

## Tests

```bash
npm test              # everything
npm run test:unit     # fast, no browser
npm run test:integration
```

Nothing in the suite reaches a real service.
