-- ReadySupport 0005 — the request record and the job queue.
--
-- One row per request, from the moment a Discord user asks for something until
-- it reaches a terminal state. The queue worker claims work from this table, so
-- pending and approved requests survive a restart.

-- Short human-readable reference, e.g. RS-1048. Sequence rather than a counter
-- column so it stays unique and monotonic across instances.
create sequence automation_request_reference_seq start 1000;

create table automation_requests (
  id                    uuid primary key default gen_random_uuid(),
  reference             bigint not null unique
                          default nextval('automation_request_reference_seq'),

  status                request_status not null default 'PENDING',
  action                action_type not null,
  source                request_source not null default 'SLASH_COMMAND',

  -- Where it came from.
  guild_id              text not null,
  channel_id            text not null,
  interaction_message_id text,

  -- Who asked. Role is captured at request time so that a later role change
  -- does not rewrite history.
  requester_discord_id  text not null,
  requester_bot_user_id uuid references bot_users (id) on delete set null,
  requester_role        bot_role not null,

  -- Who signed off, when a second approver was required.
  approver_discord_id   text,
  approver_bot_user_id  uuid references bot_users (id) on delete set null,
  approver_role         bot_role,

  -- What it targets. target_ref is the sanitized identifier the requester
  -- gave; target_account_id is filled in once exactly one account matched.
  target_summary        text,
  target_ref            jsonb not null default '{}'::jsonb,
  target_account_id     uuid references readymode_accounts (id) on delete set null,

  -- The validated structured action, sanitized. Never contains a password.
  input                 jsonb not null default '{}'::jsonb,
  -- Fields Readymode turned out to require that the requester has not supplied.
  missing_fields        text[] not null default '{}',
  -- Original natural language text, sanitized and truncated. Null for slash
  -- commands.
  request_text          text,

  -- Outcome.
  result                jsonb,
  error_category        error_category,
  error_message         text,
  screenshot_path       text,

  retry_count           integer not null default 0,
  -- True when the run stopped before submitting, per READYSUPPORT_MODE.
  dry_run               boolean not null default true,

  requested_at          timestamptz not null default now(),
  approved_at           timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  -- When the pending approval stops being valid.
  approval_expires_at   timestamptz,
  updated_at            timestamptz not null default now(),

  constraint automation_requests_retry_count_sane check (retry_count >= 0 and retry_count <= 5)
);

-- The queue worker's hot path: oldest approved job first.
create index automation_requests_queue_idx
  on automation_requests (requested_at)
  where status = 'APPROVED';

-- Sweeper looking for approvals that have run out of time.
create index automation_requests_expiry_idx
  on automation_requests (approval_expires_at)
  where status = 'AWAITING_APPROVAL';

-- Requests parked until Readymode is reconnected.
create index automation_requests_blocked_idx
  on automation_requests (requested_at)
  where status = 'AUTHENTICATION_REQUIRED';

create index automation_requests_requester_idx
  on automation_requests (requester_discord_id, requested_at desc);
create index automation_requests_recent_idx
  on automation_requests (requested_at desc);
create index automation_requests_status_idx
  on automation_requests (status, requested_at desc);

create trigger automation_requests_set_updated_at
  before update on automation_requests
  for each row execute function set_updated_at();

comment on column automation_requests.input is
  'Sanitized structured action. Passwords are stripped before write - see src/security/redact.ts.';
comment on column automation_requests.dry_run is
  'True when the workflow validated everything but stopped before submitting.';
