# Database

## Applying the migrations

Run them in numerical order. They are additive and safe to apply to an empty
project.

### Supabase CLI

```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### SQL editor

Paste each file from `migrations/` into the Supabase SQL editor in order,
`0001` through `0011`. Each is independent and runs in one go.

### psql

```bash
for file in supabase/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done
```

## What each one does

| File | |
| --- | --- |
| `0001_enums.sql` | Enum types mirroring the TypeScript unions, and the shared `updated_at` trigger |
| `0002_bot_users.sql` | Discord ID → internal role. The only source of authority |
| `0003_approved_guilds_and_channels.sql` | Where the bot is allowed to operate |
| `0004_readymode_accounts.sql` | Advisory cache of observed accounts |
| `0005_automation_requests.sql` | One row per request; also the queue |
| `0006_automation_approvals.sql` | Confirmations, nonces, expiry, the independent-approver trigger |
| `0007_automation_events.sql` | Append-only audit trail |
| `0008_browser_sessions.sql` | Session history — no cookies, tokens or credentials |
| `0009_system_settings.sql` | Auth state, queue hold, failure counts |
| `0010_rls_and_queue_claim.sql` | RLS lockdown, atomic claim, restart recovery, approval sweep |
| `0011_evidence_storage.sql` | Private bucket for evidence screenshots |

## Things the schema enforces on its own

These are not only application rules. They hold even if a bug or a hand-written
query tries otherwise.

**The audit trail cannot be edited.** `automation_events` rejects `UPDATE` and
`DELETE` by trigger, including for the service role. A fact recorded wrongly is
corrected by adding a new row, never by revising the old one.

**A deactivation cannot be self-approved.** `enforce_independent_approval`
raises if an approval marked `requires_independent` records the requester as the
decider. The application checks this twice as well; this is the layer that holds
when the others are wrong.

**A job is handed to one worker.** `claim_next_request()` selects
`FOR UPDATE SKIP LOCKED` and flips the row to `RUNNING` in the same transaction,
and returns nothing while the queue is held.

**Interrupted jobs are not retried.** `quarantine_interrupted_requests()`, run
at boot, fails anything stranded in `RUNNING` with a message asking a human to
check Readymode first — because it may have partially completed.

**Usernames and emails are unique case-insensitively** in
`readymode_accounts`, so the duplicate pre-checks cannot be defeated by case.

## Row-level security

RLS is enabled and forced on every table, with no permissive policies at all.

The bot uses the service role key, which bypasses RLS, and enforces
authorization itself in `src/auth`. The point of enabling RLS anyway is that if
an anon or authenticated key is ever pointed at this project by mistake, it
reads nothing rather than everything.

`anon` and `authenticated` also have all privileges revoked explicitly.

## Storage

`0011` creates a private `automation-evidence` bucket with no policies, so only
the service role can read or write it. Screenshots reach Discord as short-lived
signed URLs, never as public links.

Password fields are emptied in the page *before* a screenshot is taken, so a
captured image never contains one.

## Seeding the first owner

```bash
npm run seed:owner -- --discord-id YOUR_DISCORD_USER_ID
```

There is no in-Discord command for this on purpose: a bot that can grant itself
its own first administrator has no meaningful access control. It is done
out-of-band by whoever holds the database credentials.

## Regenerating types

`src/db/types.ts` is hand-written so the repository layer compiles without a
live database. To check it against reality:

```bash
supabase gen types typescript --project-id YOUR_PROJECT_REF > /tmp/generated.ts
```

and compare. The enums there are the same unions the domain uses, so a schema
change that drops a value shows up as a typecheck failure rather than a runtime
surprise.

## Useful queries

The life of one request:

```sql
select occurred_at, event_type, discord_user_id, user_role, status, error_category
from automation_events
where reference = 1048
order by occurred_at;
```

What is waiting:

```sql
select status, count(*) from automation_requests group by status;
```

Who did what this week:

```sql
select discord_user_id, action, count(*)
from automation_events
where event_type = 'EXECUTION_COMPLETED'
  and occurred_at > now() - interval '7 days'
group by 1, 2
order by 3 desc;
```

## Retention

Nothing is deleted automatically. `automation_events` is the audit trail and is
meant to be kept; `browser_sessions` and `readymode_accounts` are operational
and can be trimmed if they grow.

Do not add a delete policy to `automation_events` — the append-only trigger will
refuse it, which is the intended answer.
