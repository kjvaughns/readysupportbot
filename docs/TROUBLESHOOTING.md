# Troubleshooting

Start with `/login_status`. It runs all seven health checks and usually points
straight at the problem.

## The bot does not respond at all

**Nothing happens when I type a slash command.**
The channel is probably not in `approved_channels`. A channel the bot was
invited to but which nobody approved is treated as untrusted and ignored
silently.

```sql
select * from approved_channels where channel_id = 'THE_CHANNEL_ID';
```

**The commands do not appear in the picker.**
Run `npm run register`. They are registered to `DISCORD_GUILD_ID` only, so check
you are in that server.

**"You are not set up to use ReadySupport."**
No active row in `bot_users`:

```sql
select discord_user_id, role, active from bot_users;
```

**Free-form messages are ignored, but slash commands work.**
Three things must all be true: Message Content Intent is on in the Discord
developer portal, `DISCORD_NL_CHANNEL_ID` matches the channel, and that channel
has a `NATURAL_LANGUAGE` row in `approved_channels`.

## It will not start

**"ReadySupport cannot start: invalid environment configuration"**
The message lists every missing or malformed variable. Compare against
`.env.example`.

**"ENCRYPTION_KEY must decode to 32 bytes"**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**It starts, then every request fails on the database.**
The migrations have not been applied. See [supabase/README.md](../supabase/README.md).

## Readymode

**"ReadySupport has lost access to Readymode."**
The session expired. Run `/reconnect_readymode`. Queued work is parked, not
lost, and resumes automatically. See [READYMODE_AUTH.md](READYMODE_AUTH.md).

**"Readymode asked for extra verification."**
A CAPTCHA or a code. This needs a human by design — ReadySupport will not
attempt to bypass a security control. Run `npm run discover`, sign in through
the live view, quit, then `/reconnect_readymode`.

**Reconnect keeps failing with the credentials rejected.**
The Readymode password has probably changed. Update
`READYMODE_ADMIN_PASSWORD` and redeploy.

**`browser_sessions.performed_login` is true on every session.**
The persistent context is not persisting. Check `BROWSERBASE_CONTEXT_ID` is set,
is the same context you signed into during discovery, and has not been deleted.

## Selectors and the interface

**"This action is not ready yet: part of the Readymode interface it needs has
not been mapped."**
Expected on a fresh install. Run discovery — see
[SELECTOR_DISCOVERY.md](SELECTOR_DISCOVERY.md). `npm run discover -- --list`
shows exactly what is missing.

**"The Readymode page did not look the way I expected, so I stopped."**
Either Readymode changed, or a `page.*.marker` is too weak — a marker that also
appears on other pages proves nothing. Re-capture that page and check the marker
is unique to it.

**A workflow says it found no account, but the account exists.**
The row cell selectors are probably wrong, so rows are being read as blank.
Check `agents.row.username` and friends against the discovery output for the
agent list.

**"Readymode returned N accounts matching..."**
Working as intended. Pick from the menu, or ask again with the username. The
matcher will not choose for you.

**A workflow acted but reported it could not verify.**
Read this one carefully: the change may have gone through. Check Readymode by
hand. Nothing is retried automatically for exactly this reason. The usual cause
is that a `agent.detail.*` state field is unmapped or points at the wrong
element, so the after-read cannot see the change.

## The queue

**Jobs sit in APPROVED and never run.**

```sql
select value from system_settings where key = 'queue_paused';
```

If held, `/reconnect_readymode` releases it once Readymode is reachable.
Otherwise check `/login_status` — the worker may not be running.

**A request is stuck in RUNNING.**
Only possible if the process died mid-job. The next start moves it to `FAILED`
with a message asking someone to check Readymode. It is never retried.

**Everything is slow.**
Jobs are sequential by design; one at a time, each opening its own browser
session. A queue of ten mutating requests takes ten times one.

## Passwords

**"I could not send the temporary password privately."**
The private reply was not available — usually the interaction expired, or the
process restarted between the job finishing and the reply. The password was
destroyed rather than posted, and there is no copy to retrieve, because it is
never stored. Run the reset again.

**Where can I see a password afterwards?**
Nowhere. There is no admin view, no log line, no database column, and no
screenshot containing one. If it was lost in delivery, issue a new one.

## Alerts

**No alerts arrive.**
There is probably no `ALERTS` channel:

```sql
select * from approved_channels where purpose = 'ALERTS';
```

Critical alerts also go by direct message to every OWNER, but owners commonly
have DMs closed, so the channel is what to rely on.

**The same alert repeats.**
It should not — each kind has a dedupe window. If it is repeating, the
`alert_dedupe` setting may not be writable; check the database is healthy.

## Health

| Check | Red means |
| --- | --- |
| Discord | Gateway is down. Check the token and outbound connectivity |
| Database | Supabase unreachable. Nothing can be recorded or queued |
| Browser service | The last Browserbase session failed |
| Readymode sign-in | Expired or verification needed. `/reconnect_readymode` |
| Job queue | Worker not running, or held |
| Last success | Nothing has completed in over a day |
| Recent failures | Three or more in a row — something systematic |

## Getting more detail

Set `LOG_LEVEL=debug` and restart. Logs are safe to read and share: everything
goes through the redaction layer, so credentials cannot appear in them.

The audit trail is the other place to look:

```sql
select occurred_at, event_type, action, target, status, error_category, error_message
from automation_events
where reference = 1048
order by occurred_at;
```

That shows the whole life of one request — requested, approved, executed,
verified or failed — including who did each part.
