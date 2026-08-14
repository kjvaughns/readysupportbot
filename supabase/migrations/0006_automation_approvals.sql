-- ReadySupport 0006 — confirmations and second-approver sign-off.
--
-- A request may carry more than one approval row: the requester's own
-- confirmation, and for deactivations and bulk work, an independent sign-off
-- from a different OWNER or ADMIN.

create table automation_approvals (
  id                      uuid primary key default gen_random_uuid(),
  request_id              uuid not null references automation_requests (id) on delete cascade,

  -- Bound into the Discord button custom_id. A click carrying a nonce that
  -- does not match this row is rejected, so buttons cannot be replayed or
  -- forged from an older message.
  nonce                   text not null,

  -- Minimum role that may decide this one.
  required_role           bot_role not null default 'ADMIN',
  -- True when the decider must be someone other than the requester.
  requires_independent    boolean not null default false,

  decision                approval_decision not null default 'PENDING',
  decided_by_discord_id   text,
  decided_by_role         bot_role,
  decided_at              timestamptz,
  -- Why it was cancelled or denied, when a reason was given.
  decision_note           text,

  expires_at              timestamptz not null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  constraint automation_approvals_decided_together check (
    (decision = 'PENDING' and decided_by_discord_id is null and decided_at is null)
    or (decision <> 'PENDING')
  ),
  -- An independent approval that records the requester as the decider is
  -- exactly the failure this table exists to prevent, so the database refuses
  -- it as well as the application.
  constraint automation_approvals_nonce_present check (length(nonce) >= 8)
);

-- At most one open approval per request at a time.
create unique index automation_approvals_one_pending
  on automation_approvals (request_id)
  where decision = 'PENDING';

create index automation_approvals_expiry_idx
  on automation_approvals (expires_at)
  where decision = 'PENDING';

create index automation_approvals_request_idx
  on automation_approvals (request_id, created_at);

create trigger automation_approvals_set_updated_at
  before update on automation_approvals
  for each row execute function set_updated_at();

-- Enforce the independence rule in the database as well as the application.
create or replace function enforce_independent_approval()
returns trigger
language plpgsql
as $$
declare
  requester text;
begin
  if new.decision = 'CONFIRMED' and new.requires_independent then
    select requester_discord_id into requester
      from automation_requests where id = new.request_id;

    if requester is not null and requester = new.decided_by_discord_id then
      raise exception
        'Request % requires approval from someone other than the requester', new.request_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger automation_approvals_independent_check
  before insert or update on automation_approvals
  for each row execute function enforce_independent_approval();

comment on table automation_approvals is
  'Confirmation records. Deactivations and bulk actions require an independent OWNER/ADMIN.';
