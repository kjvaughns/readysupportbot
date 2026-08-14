-- ReadySupport 0009 — small pieces of mutable operational state.
--
-- Deliberately a key/value table: these are single facts the whole system
-- consults (is Readymode signed in? how many workflows have failed in a row?)
-- and giving each its own column would mean a migration every time one is
-- added.
--
-- This is not a secret store. Values are readable operational state only.

create table system_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

create trigger system_settings_set_updated_at
  before update on system_settings
  for each row execute function set_updated_at();

insert into system_settings (key, value, description) values
  (
    'readymode_auth_state',
    '{"state":"UNKNOWN","checkedAt":null,"detail":null}'::jsonb,
    'Last known Readymode authentication state. Set to EXPIRED or VERIFICATION_REQUIRED to hold the queue.'
  ),
  (
    'queue_paused',
    '{"paused":false,"reason":null,"pausedBy":null,"pausedAt":null}'::jsonb,
    'Manual and automatic queue hold. The worker claims no new jobs while paused is true.'
  ),
  (
    'consecutive_failures',
    '{"count":0,"lastCategory":null,"lastAt":null}'::jsonb,
    'Consecutive failed workflows. The OWNER is alerted when this reaches three.'
  ),
  (
    'last_successful_automation',
    '{"at":null,"action":null,"reference":null}'::jsonb,
    'Timestamp of the most recent workflow that completed and verified.'
  ),
  (
    'alert_dedupe',
    '{}'::jsonb,
    'Per-alert-kind timestamps used to avoid repeating the same alert every minute.'
  ),
  (
    'readymode_vocabulary',
    '{"roles":[],"licenseTypes":[],"teams":[],"campaigns":[],"queues":[],"capturedAt":null}'::jsonb,
    'Option values observed in the Readymode interface. Populated by discovery; used to reject values that do not exist rather than submitting a guess.'
  );

comment on table system_settings is
  'Operational state shared across the process. Not a secret store.';
