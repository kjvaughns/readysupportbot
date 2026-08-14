# Deployment

## Railway

### 1. Create the service

Point a Railway service at this repository. `railway.json` selects the
Dockerfile build and sets `/health` as the health check.

### 2. Variables

Set everything from [SETUP.md](SETUP.md) as service variables. Railway provides
`PORT`.

Start conservatively:

```
READYSUPPORT_MODE=dry_run
ENABLE_CREATE_ACCOUNT=false
ENABLE_CLEAR_LICENSE=false
ENABLE_RESET_PASSWORD=false
ENABLE_DEACTIVATE_ACCOUNT=false
```

### 3. One replica

**Keep `numReplicas` at 1.**

Two instances would not corrupt the database — jobs are claimed atomically — but
they would drive the same persistent browser context at the same time,
interleaving clicks on the same Readymode pages. The sequential queue is a
correctness property, not a throughput compromise.

### 4. Selectors

The container has no selector overlay in it. Two options:

**Mount it.** Put `config/readymode-selectors.json` on a Railway volume mounted
at `/app/config`. Survives redeploys, editable without a rebuild. Preferred.

**Bake it in.** Remove `config/readymode-selectors.json` from `.gitignore`,
commit it, and add `COPY config ./config` to the Dockerfile. Simpler, but the
file is then in your repository and a change means a rebuild.

Without it, live workflows refuse to run and say why.

### 5. Database

Apply the migrations before the first deploy — see
[supabase/README.md](../supabase/README.md). The service will start without
them but every request will fail on the first database call.

### 6. First deploy

```
/login_status
```

Expected on a first deploy: Discord and Database green, Readymode sign-in
unknown until the first job, Browser service unknown until the first session.

## Going live

Do this in order, one action at a time. There is no prize for turning everything
on at once.

1. **Read-only first.** `/agent_status` and `/license_usage` need no flags. If
   those work, the session, the selectors and the matching are all sound.
2. **Dry run the mutating ones.** With `READYSUPPORT_MODE=dry_run`, run
   `/create_account`, `/clear_license`, `/reset_password`,
   `/deactivate_account`. Each should navigate, find the account, validate, and
   report what it *would* have done. This exercises every selector except the
   final click.
3. **Go live for one action.** Set `READYSUPPORT_MODE=live` and turn on exactly
   one flag — `ENABLE_CREATE_ACCOUNT=true` is the usual first, since a created
   account is the easiest thing to undo. Run it against a test agent.
4. **Verify by hand.** Open Readymode and confirm the change. Check the audit
   trail and the evidence screenshot agree.
5. **Repeat for the next action.** Only turn on `ENABLE_DEACTIVATE_ACCOUNT`
   last: it is the hardest to undo, which is also why it needs a second
   approver.

## Docker anywhere else

```bash
docker build -t readysupport .

docker run -d --name readysupport \
  --env-file .env \
  -p 3000:3000 \
  -v "$(pwd)/config:/app/config:ro" \
  readysupport
```

The image installs no browser — Playwright connects to Browserbase over CDP.

Use `docker stop` rather than `docker kill`. The app handles `SIGTERM` by
finishing the job in flight before exiting; killing it mid-workflow leaves a
change half-applied and a request quarantined for someone to check by hand.

## Restart safety

By design, restarting loses no work:

| State at shutdown | On restart |
| --- | --- |
| `PENDING`, `AWAITING_APPROVAL` | Untouched. Approval expiry still applies |
| `APPROVED` | Claimed and run |
| `RUNNING` | Moved to `FAILED` with a message asking a human to check Readymode. **Never retried** — it may have partially completed |
| `AUTHENTICATION_REQUIRED` | Stays parked until `/reconnect_readymode` |
| Audit trail | Untouched. Append-only |
| Queue hold | Persisted, so a redeploy does not silently resume a queue somebody paused |

The one thing that does not survive is the in-memory password vault, and that is
the correct trade: a password an administrator typed into a form before a
restart is simply gone, and the job generates a fresh one instead. Nothing is
recovered from storage because nothing is in storage.

## Monitoring

| Endpoint | For |
| --- | --- |
| `GET /health` | Full report. 503 when something is outright failing |
| `GET /ready` | Cheap liveness probe |

`/health` reports states and counts only — no account data, no request contents.

A failing Readymode session returns 503 but is **not** a reason for the platform
to recycle the container: the process is healthy and holding work correctly.
Configure the platform check against `/ready` if 503s trigger restarts.

Owners are alerted when authentication expires, when three workflows fail in a
row, when the interface stops matching, when the browser service is unavailable,
and when an unauthorized request is refused.

## Upgrading

1. Apply any new migrations first. They are additive.
2. Deploy.
3. `/login_status`.

If a release changes the selector registry, `npm run discover -- --list` shows
whether anything new needs mapping.
