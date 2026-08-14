-- ReadySupport 0010 — lock the schema down, and add the atomic queue claim.
--
-- Nothing in this schema is reachable from a browser. The bot is the only
-- client and it authenticates with the service role key, which bypasses RLS.
-- Enabling RLS with no permissive policies means that if an anon or
-- authenticated key is ever pointed at this project by mistake, it reads
-- nothing rather than everything.

alter table bot_users              enable row level security;
alter table approved_guilds        enable row level security;
alter table approved_channels      enable row level security;
alter table readymode_accounts     enable row level security;
alter table automation_requests    enable row level security;
alter table automation_approvals   enable row level security;
alter table automation_events      enable row level security;
alter table browser_sessions       enable row level security;
alter table system_settings        enable row level security;

-- Force RLS on the table owner too, so a mistakenly-owner connection is also
-- constrained. The service role bypasses RLS entirely and is unaffected.
alter table bot_users              force row level security;
alter table approved_guilds        force row level security;
alter table approved_channels      force row level security;
alter table readymode_accounts     force row level security;
alter table automation_requests    force row level security;
alter table automation_approvals   force row level security;
alter table automation_events      force row level security;
alter table browser_sessions       force row level security;
alter table system_settings        force row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Atomic queue claim
-- ---------------------------------------------------------------------------
--
-- The worker runs one job at a time, but a redeploy can briefly overlap two
-- instances. This function hands out at most one job to at most one caller:
-- the row lock plus the status predicate mean a second caller either waits and
-- then sees RUNNING (and skips the row), or gets nothing.
--
-- It also refuses to hand out work while the queue is paused, which is how an
-- expired Readymode session stops the pipeline without any in-process state.

create or replace function claim_next_request()
returns automation_requests
language plpgsql
as $$
declare
  claimed automation_requests;
  paused boolean;
begin
  select coalesce((value ->> 'paused')::boolean, false) into paused
    from system_settings where key = 'queue_paused';

  if paused then
    return null;
  end if;

  select * into claimed
    from automation_requests
   where status = 'APPROVED'
   order by requested_at
     for update skip locked
   limit 1;

  if not found then
    return null;
  end if;

  update automation_requests
     set status = 'RUNNING',
         started_at = now()
   where id = claimed.id
   returning * into claimed;

  return claimed;
end;
$$;

comment on function claim_next_request is
  'Atomically move the oldest APPROVED request to RUNNING and return it. Returns null when the queue is empty or paused.';

-- ---------------------------------------------------------------------------
-- Restart recovery
-- ---------------------------------------------------------------------------
--
-- A request left RUNNING when the process died may have partially changed
-- Readymode. It is never re-queued automatically. It is failed with a category
-- that tells a human to check the live state first.

create or replace function quarantine_interrupted_requests()
returns integer
language plpgsql
as $$
declare
  affected integer;
begin
  with stuck as (
    update automation_requests
       set status = 'FAILED',
           error_category = 'VERIFICATION_FAILED',
           error_message = 'ReadySupport restarted while this action was running. '
                        || 'Check Readymode to confirm whether it took effect before retrying.',
           completed_at = now()
     where status = 'RUNNING'
     returning 1
  )
  select count(*) into affected from stuck;

  return affected;
end;
$$;

comment on function quarantine_interrupted_requests is
  'Called at boot. Fails any request stranded in RUNNING rather than retrying it, since it may have partially completed.';

-- ---------------------------------------------------------------------------
-- Approval expiry sweep
-- ---------------------------------------------------------------------------

create or replace function expire_stale_approvals()
returns integer
language plpgsql
as $$
declare
  affected integer;
begin
  update automation_approvals
     set decision = 'EXPIRED',
         decided_at = now()
   where decision = 'PENDING'
     and expires_at <= now();

  with expired as (
    update automation_requests
       set status = 'CANCELLED',
           error_category = 'APPROVAL_EXPIRED',
           error_message = 'The confirmation window closed before anyone approved this.',
           completed_at = now()
     where status = 'AWAITING_APPROVAL'
       and approval_expires_at is not null
       and approval_expires_at <= now()
     returning 1
  )
  select count(*) into affected from expired;

  return affected;
end;
$$;

comment on function expire_stale_approvals is
  'Cancels requests whose approval window closed. Safe to call repeatedly.';
