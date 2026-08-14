-- ReadySupport 0008 — Browserbase session history and Readymode auth state.
--
-- Cookies, local storage and the authenticated state itself live inside the
-- Browserbase persistent context, not here. This table records only that a
-- session existed, how it was used, and whether Readymode accepted it, so an
-- operator can see the sign-in history without the credentials being anywhere
-- near the database.

create table browser_sessions (
  id                     uuid primary key default gen_random_uuid(),
  -- Browserbase's identifier for the live session.
  browserbase_session_id text,
  -- The persistent context reused across sessions (BROWSERBASE_CONTEXT_ID).
  context_id             text not null,

  status                 browser_session_status not null default 'ACTIVE',
  auth_state             readymode_auth_state not null default 'UNKNOWN',

  -- Set when the session was opened to serve one specific job.
  request_id             uuid references automation_requests (id) on delete set null,

  -- True when this session had to perform a full credential login rather than
  -- reusing the stored context. A rising count here means the context is not
  -- persisting properly.
  performed_login        boolean not null default false,
  -- True when Readymode presented a CAPTCHA, MFA or other verification step.
  verification_detected  boolean not null default false,

  started_at             timestamptz not null default now(),
  last_checked_at        timestamptz,
  ended_at               timestamptz,

  error_category         error_category,
  error_message          text,

  metadata               jsonb not null default '{}'::jsonb
);

create index browser_sessions_active_idx on browser_sessions (started_at desc)
  where status = 'ACTIVE';
create index browser_sessions_recent_idx on browser_sessions (started_at desc);
create index browser_sessions_request_idx on browser_sessions (request_id);

comment on table browser_sessions is
  'Browserbase session history. Holds no cookies, tokens or credentials.';
comment on column browser_sessions.performed_login is
  'True when the stored context was not usable and a credential login was needed.';
