-- ReadySupport 0004 — the cache of Readymode accounts the bot has observed.
--
-- This is a convenience index for matching and for showing choices back to a
-- requester. It is never treated as authoritative: every workflow re-reads the
-- live Readymode state before acting and again to verify afterwards.

create table readymode_accounts (
  id                 uuid primary key default gen_random_uuid(),
  -- Readymode's own identifier, when the interface exposes one. Highest
  -- priority match key.
  readymode_user_id  text unique,
  username           text,
  email              text,
  full_name          text,
  agent_role         text,
  license_type       text,
  team               text,
  campaign           text,
  queue              text,
  active             boolean,
  license_in_use     boolean,
  -- Sanitized snapshot of the row as it was last read from the interface.
  -- Contains no credentials; see src/security/redact.ts.
  snapshot           jsonb not null default '{}'::jsonb,
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Case-insensitive uniqueness: Readymode treats these as identities, and two
-- rows differing only in case would defeat the duplicate pre-checks.
create unique index readymode_accounts_username_key
  on readymode_accounts (lower(username)) where username is not null;
create unique index readymode_accounts_email_key
  on readymode_accounts (lower(email)) where email is not null;
create index readymode_accounts_full_name_idx
  on readymode_accounts (lower(full_name)) where full_name is not null;
create index readymode_accounts_license_idx
  on readymode_accounts (license_type) where license_in_use;

create trigger readymode_accounts_set_updated_at
  before update on readymode_accounts
  for each row execute function set_updated_at();

comment on table readymode_accounts is
  'Observed Readymode accounts. Advisory cache for matching only; live state always wins.';
