-- ReadySupport 0001 — extensions and shared enum types.
--
-- These enums mirror the TypeScript unions in src/domain/. Adding a value here
-- without adding it there (or the reverse) will fail typecheck or fail at
-- insert time, which is the intent: the two must not drift.

create extension if not exists "pgcrypto";

-- src/domain/roles.ts BOT_ROLES
create type bot_role as enum ('OWNER', 'ADMIN', 'SUPPORT', 'VIEWER');

-- src/domain/actions.ts ACTION_TYPES
create type action_type as enum (
  'CREATE_ACCOUNT',
  'CLEAR_LICENSE',
  'RESET_PASSWORD',
  'DEACTIVATE_ACCOUNT',
  'CHECK_LICENSE_USAGE',
  'CHECK_AGENT_STATUS',
  'LIST_RECENT_ACTIONS'
);

-- src/domain/status.ts REQUEST_STATUSES
create type request_status as enum (
  'PENDING',
  'AWAITING_INFORMATION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'AUTHENTICATION_REQUIRED'
);

-- src/domain/errors.ts ERROR_CATEGORIES
create type error_category as enum (
  'AUTH_EXPIRED',
  'VERIFICATION_REQUIRED',
  'SELECTOR_NOT_CONFIGURED',
  'INTERFACE_CHANGED',
  'NO_MATCH',
  'AMBIGUOUS_MATCH',
  'VERIFICATION_FAILED',
  'PRECONDITION_FAILED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'APPROVAL_EXPIRED',
  'VALIDATION_FAILED',
  'TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'ACTION_DISABLED',
  'UNKNOWN'
);

create type approval_decision as enum ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

create type request_source as enum ('SLASH_COMMAND', 'NATURAL_LANGUAGE', 'SYSTEM');

-- One row is written to automation_events for each of these moments.
create type audit_event_type as enum (
  'REQUEST_CREATED',
  'INFORMATION_REQUESTED',
  'INFORMATION_PROVIDED',
  'APPROVAL_REQUESTED',
  'APPROVAL_GRANTED',
  'APPROVAL_DENIED',
  'APPROVAL_EXPIRED',
  'QUEUED',
  'EXECUTION_STARTED',
  'EXECUTION_VERIFIED',
  'EXECUTION_COMPLETED',
  'EXECUTION_FAILED',
  'AUTHENTICATION_REQUIRED',
  'AUTHENTICATION_RESTORED',
  'PERMISSION_DENIED',
  'RATE_LIMITED',
  'CANCELLED',
  'CREDENTIALS_DELIVERED',
  'SYSTEM_ALERT'
);

create type browser_session_status as enum ('ACTIVE', 'CLOSED', 'FAILED');

create type readymode_auth_state as enum (
  'AUTHENTICATED',
  'EXPIRED',
  'VERIFICATION_REQUIRED',
  'UNKNOWN'
);

-- Shared updated_at trigger.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
