# Deploying ReadySupport

The service is designed to deploy before it is configured. Push it to Railway
first, confirm the health check passes, then connect Supabase, Discord,
Browserbase and Readymode one at a time while watching `/ready`.

## 1. Railway

1. Create a new Railway project from this repository. `railway.json` selects the
   Dockerfile builder, sets the start command to `node dist/index.js`, and points
   the health check at `/health`.
2. Deploy. No environment variables are required for the first deploy — the
   service boots into setup mode and `/health` returns 200.
3. Confirm:

   ```bash
   curl https://<your-app>.up.railway.app/health
   # {"status":"ok","uptimeSeconds":12,"setupMode":true}

   curl https://<your-app>.up.railway.app/ready
   # 503, with every unconfigured dependency named
   ```

The server binds `0.0.0.0` and uses Railway's `PORT`. A missing dependency never
crashes the service; it is reported through `/ready`.

### Build and start commands

| Purpose | Command |
| --- | --- |
| Build | `npm run build` (`tsc -p tsconfig.build.json`) — runs inside the Dockerfile |
| Start | `npm start` (`node dist/index.js`) |
| Health | `GET /health` |
| Readiness | `GET /ready` |

The image is based on `mcr.microsoft.com/playwright:v1.62.1-noble`, which carries
a matching Chromium and its system libraries. Remote Browserbase sessions are the
normal execution path; the bundled browser keeps self-hosted and diagnostic runs
working.

## 2. Encryption key

Generate the key that protects stored Readymode credentials and set it in
Railway:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```
ENCRYPTION_KEY=<64 hex characters>
```

Rotating this key makes previously stored passwords unreadable; re-enter the
Readymode connection from the dashboard after a rotation.

## 3. Supabase

1. Create a Supabase project.
2. Apply the migration in `supabase/migrations/0001_initial_schema.sql`, either
   with `supabase db push` or by pasting it into the SQL editor.
3. Set:

   ```
   SUPABASE_URL=https://<project>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<service role key>
   SUPABASE_ANON_KEY=<anon key>
   ```

The backend uses the service role key and filters every query by organization.
The frontend uses the anonymous key as a signed-in user; row level security
restricts it to organizations the user belongs to. **Never put the service role
key in the frontend.** Encrypted credentials are not readable from the frontend
at all, not even as ciphertext.

Seed the first organization and Owner:

```sql
insert into public.organizations (id, name) values (gen_random_uuid(), 'Your Company')
returning id;

insert into public.organization_members (organization_id, supabase_user_id, role)
values ('<organization id>', '<auth.users id>', 'owner');
```

## 4. Discord

1. Create an application at <https://discord.com/developers/applications>.
2. Add a bot, enable the **Message Content** and **Server Members** privileged
   intents, and copy the token.
3. Set:

   ```
   DISCORD_BOT_TOKEN=...
   DISCORD_CLIENT_ID=...
   DISCORD_CLIENT_SECRET=...
   ```

4. Invite the bot with `POST /api/discord/connect`, which returns the install URL
   with the permissions it needs (view channels, send messages, read history, use
   application commands).
5. Bind the server with `POST /api/discord/install`, approve channels with
   `POST /api/discord/channels`, and map Discord roles to ReadySupport roles with
   `POST /api/permissions`.
6. Register the slash commands:

   ```bash
   GUILD_ID=<your guild id> npm run register:commands
   ```

Requests from servers that have not been installed, or channels that have not
been approved, are refused.

## 5. Browserbase

```
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
BROWSERBASE_CONTEXT_ID=...   # optional persistent context, reused across sessions
```

A persistent context keeps the Readymode session signed in between requests,
which reduces how often a login — and therefore a verification prompt — is
needed.

## 6. OpenAI

```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
```

Used only to translate a Discord message into a validated action. Without it the
bot still works: slash commands are unaffected, and a deterministic parser
handles the common phrasings.

## 7. Readymode

Readymode credentials are submitted by an Owner or Administrator through the
frontend, over HTTPS:

```
POST /api/readymode/connect
{ "organizationId": "...", "loginUrl": "https://...", "username": "...", "password": "..." }
```

The password is encrypted on arrival and only the ciphertext is stored. No
endpoint returns it.

Then verify the connection before enabling live changes:

```
POST /api/readymode/test
```

This signs in and reports which Readymode controls ReadySupport can identify. It
changes nothing. Any control listed under `unresolved` has to be configured in
`src/readymode/selectors/index.ts` before the workflows that use it can run —
a workflow that cannot identify its control stops and says so rather than
clicking something it does not recognize.

Only once the test is clean, turn off dry run:

```
DRY_RUN=false
```

## 8. Frontend origin

```
FRONTEND_URL=https://readysupport.app
```

Comma-separate several origins if needed. In production, an unset `FRONTEND_URL`
means browser requests are refused — CORS is never opened up.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT`, `HOST` | provided by Railway | Listen address; defaults to `0.0.0.0:8080` |
| `NODE_ENV` | no | `production` in deployment |
| `LOG_LEVEL` | no | Default `info` |
| `FRONTEND_URL` | production | Allowed browser origins |
| `PUBLIC_BASE_URL` | no | This service's public URL |
| `DRY_RUN` | no | Default `true`; workflows read and report without saving |
| `ENCRYPTION_KEY` | yes | 32 bytes, hex or base64 |
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Backend only |
| `SUPABASE_ANON_KEY` | yes | Verifying frontend access tokens |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `DISCORD_CLIENT_ID` | yes | Application id |
| `DISCORD_CLIENT_SECRET` | no | Install flow |
| `OPENAI_API_KEY` | no | Natural language parsing |
| `OPENAI_MODEL` | no | Default `gpt-4o-mini` |
| `BROWSERBASE_API_KEY` | yes for live work | Remote browser sessions |
| `BROWSERBASE_PROJECT_ID` | yes for live work | Remote browser sessions |
| `BROWSERBASE_CONTEXT_ID` | no | Persistent context |
| `READYMODE_BASE_URL` / `READYMODE_USERNAME` / `READYMODE_PASSWORD` | no | Single-tenant fallback instead of stored credentials |
| `APPROVAL_TTL_SECONDS` | no | Default 600 |
| `MAX_REQUEST_BYTES` | no | Default 131072 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | no | Default 120 per minute |
| `MAX_BULK_ACCOUNTS` | no | Default 25 |

## Frontend API

All endpoints require a Supabase access token as `Authorization: Bearer <token>`
and an organization, supplied as `X-Organization-Id`, a query parameter, or a
body field. Membership and role are checked on every call.

| Endpoint | Minimum role |
| --- | --- |
| `GET /api/connections` | Viewer |
| `POST /api/discord/connect` | Administrator |
| `GET /api/discord/guilds` | Owner |
| `POST /api/discord/install` | Owner |
| `GET /api/discord/channels` | Viewer |
| `POST /api/discord/channels` | Administrator |
| `GET /api/discord/roles` | Viewer |
| `POST /api/permissions` | Administrator (Owner to grant Owner) |
| `POST /api/readymode/connect` | Administrator |
| `DELETE /api/readymode/connect` | Owner |
| `POST /api/readymode/reconnect` | Administrator |
| `GET /api/readymode/status` | Viewer |
| `POST /api/readymode/test` | Administrator |
| `GET /api/linked-agents` | Viewer |
| `POST /api/linked-agents` | Administrator |
| `GET /api/state-configurations` | Viewer |
| `POST /api/state-configurations` | Support |
| `GET /api/activity` | Viewer |
| `GET /api/requests/:id` | Viewer |

A request belonging to another organization reads as missing, not forbidden.

## When Readymode asks for human verification

CAPTCHA and multi-factor prompts are never bypassed. When one appears:

1. The queue lane for that Readymode account pauses.
2. The request is marked `AUTHENTICATION_REQUIRED`.
3. The notification channel is told what happened.
4. An Owner or Administrator reconnects with `POST /api/readymode/reconnect`.
5. Queued work resumes.

## Loading the Readymode documentation

Run once after deploying, and on a schedule afterwards:

```bash
npm run knowledge:seed   # no network; stores the supplied bank
npm run knowledge:sync   # fetches and parses the real Help Center articles
```

The npm scripts need `tsx`, which the production image does not carry, so on
Railway use the endpoint instead — the same reasoning as slash command
registration, which is also exposed for deployments with no shell:

```bash
# Seed only: stores the supplied bank, no network.
curl -X POST https://<app>/api/knowledge/sync \
  -H "Authorization: Bearer <owner token>" \
  -H "X-Organization-Id: <organization id>" \
  -H "Content-Type: application/json" \
  -d '{"seedOnly": true}'

# Seed and fetch. Bounded per call; re-running is cheap.
curl -X POST https://<app>/api/knowledge/sync \
  -H "Authorization: Bearer <owner token>" \
  -H "X-Organization-Id: <organization id>" \
  -H "Content-Type: application/json" \
  -d '{"maxArticles": 60}'

# What has actually been read.
curl https://<app>/api/knowledge/status \
  -H "Authorization: Bearer <owner token>" \
  -H "X-Organization-Id: <organization id>"
```

Call the second one repeatedly until `status` reports `succeeded`; each call
picks up where the last left off, and an unchanged article costs a 304.
`KNOWLEDGE_MAX_ARTICLES` bounds the npm script the same way (default 200).

The sync is polite by construction: one request at a time, a second between
them, conditional requests so an unchanged article costs a 304, and a hard
refusal to fetch anything that is not an official `help.readymode.com/support/`
page. Re-running it is cheap and safe.

What it reports:

- `succeeded` — every folder was read and every article parsed.
- `partial` — some articles were stored and some failed. The failures keep
  whatever content they already had, and the reason is recorded on each one.
- `failed` — nothing was read. Nothing is ever marked removed on the strength of
  a run like this.

## Learning the interface

```bash
# Read-only. Walks the administrative screens and proposes selectors.
curl -X POST https://<app>/api/readymode/discover \
  -H "Authorization: Bearer <owner token>" \
  -H "X-Organization-Id: <organization id>"

# What it found, and what is blocking anything it did not.
curl https://<app>/api/readymode/capabilities \
  -H "Authorization: Bearer <owner token>" \
  -H "X-Organization-Id: <organization id>"

# An Owner approves the profile. Until this, no change may run.
curl -X POST https://<app>/api/readymode/profiles/<profile id>/approve \
  -H "Authorization: Bearer <owner token>" \
  -H "X-Organization-Id: <organization id>"
```

Discovery never clicks save, submits a form, or changes anything. It opens
screens by their inspected route, confirms each one by the heading that appears,
and refuses to click any label outside a fixed allowlist.

A profile that only identified the login controls cannot be approved: signing in
proves the credentials work and says nothing about the administrative interface.

Keep `DRY_RUN=true` until each workflow has been run against the real account and
verified. The status table at `/api/readymode/capabilities` is the record of how
far each one has actually got.

## Operating notes

- Watch `/ready`. It reports Discord, Supabase, Browserbase, Readymode, OpenAI,
  encryption and the job queue separately.
- Browser work runs one job at a time per Readymode account, so two requests
  never drive the same account at once.
- A failed run is never retried automatically. Send the request again; it starts
  by reading the current Readymode state.
- Screenshots are written to `artifacts/` inside the container (override with
  `READYSUPPORT_ARTIFACT_DIR`). Container storage is ephemeral — the audit record
  in Supabase is the durable evidence trail.
