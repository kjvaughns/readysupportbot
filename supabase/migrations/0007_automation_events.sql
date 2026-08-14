-- ReadySupport 0007 — the immutable audit trail.
--
-- Append only. Rows may be inserted and read; updates and deletes are refused
-- by a trigger, including for the service role. If a fact recorded here turns
-- out to be wrong, the correction is a new row, not an edit.
--
-- What must never appear in this table: passwords, complete browser cookies,
-- session tokens, and any OpenAI prompt carrying credentials. Payloads are put
-- through src/security/redact.ts before they are written.

create table automation_events (
  id                uuid primary key default gen_random_uuid(),

  -- 1. Request identity
  request_id        uuid references automation_requests (id) on delete set null,
  reference         bigint,

  event_type        audit_event_type not null,

  -- 2/3. Who, and with what authority
  discord_user_id   text,
  user_role         bot_role,

  -- 4/5. What, against what
  action            action_type,
  target            text,

  -- 6/7/8. Lifecycle timestamps, denormalized so an event row is a complete
  -- record on its own without joining back to a mutable table.
  requested_at      timestamptz,
  approved_at       timestamptz,
  executed_at       timestamptz,

  -- 9. Where the request stood after this event
  status            request_status,

  -- 10/11. Sanitized before and after
  previous_state    jsonb,
  new_state         jsonb,

  -- 12. Failure detail
  error_category    error_category,
  error_message     text,

  -- 13. Evidence
  screenshot_path   text,

  -- Anything else worth keeping: durations, match counts, dry-run flag.
  metadata          jsonb not null default '{}'::jsonb,

  occurred_at       timestamptz not null default now()
);

create index automation_events_request_idx on automation_events (request_id, occurred_at);
create index automation_events_user_idx on automation_events (discord_user_id, occurred_at desc);
create index automation_events_type_idx on automation_events (event_type, occurred_at desc);
create index automation_events_recent_idx on automation_events (occurred_at desc);

-- Append-only enforcement.
create or replace function reject_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'automation_events is append-only; % is not permitted. Record a correcting event instead.',
    tg_op;
end;
$$;

create trigger automation_events_no_update
  before update on automation_events
  for each row execute function reject_audit_mutation();

create trigger automation_events_no_delete
  before delete on automation_events
  for each row execute function reject_audit_mutation();

comment on table automation_events is
  'Append-only audit trail. Updates and deletes are rejected by trigger.';
