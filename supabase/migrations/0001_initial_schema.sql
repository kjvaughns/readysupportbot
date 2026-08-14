-- ReadySupport initial schema.
--
-- The backend connects with the service role key and filters by organization
-- explicitly. Row level security is the second line of defence and is what the
-- frontend relies on: it connects with the anonymous key as an authenticated
-- user and can only ever see rows belonging to an organization it is a member
-- of. The service role key is never exposed to the frontend.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Organizations and membership
-- ---------------------------------------------------------------------------

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create type public.readysupport_role as enum ('owner', 'administrator', 'support', 'viewer');

create table if not exists public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  supabase_user_id uuid references auth.users (id) on delete cascade,
  discord_user_id text,
  role public.readysupport_role not null default 'viewer',
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organization_members_identity_present
    check (supabase_user_id is not null or discord_user_id is not null)
);

create unique index if not exists organization_members_org_supabase_user_key
  on public.organization_members (organization_id, supabase_user_id)
  where supabase_user_id is not null;

create unique index if not exists organization_members_org_discord_user_key
  on public.organization_members (organization_id, discord_user_id)
  where discord_user_id is not null;

-- Membership lookups run inside policies, so they are security definer to avoid
-- recursive policy evaluation.
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.supabase_user_id = auth.uid()
  );
$$;

create or replace function public.has_org_role(org uuid, allowed public.readysupport_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.supabase_user_id = auth.uid()
      and m.role = any (allowed)
  );
$$;

-- ---------------------------------------------------------------------------
-- Discord configuration
-- ---------------------------------------------------------------------------

create table if not exists public.discord_installations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  guild_id text not null unique,
  installed boolean not null default false,
  notification_channel_id text,
  require_mention boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists discord_installations_org_idx
  on public.discord_installations (organization_id);

create table if not exists public.discord_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  guild_id text not null,
  channel_id text not null,
  approved boolean not null default true,
  auto_support boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, channel_id)
);

create table if not exists public.discord_role_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  guild_id text not null,
  discord_role_id text not null,
  role public.readysupport_role not null,
  created_at timestamptz not null default now(),
  unique (organization_id, discord_role_id)
);

-- ---------------------------------------------------------------------------
-- Readymode connection and credentials
-- ---------------------------------------------------------------------------

create table if not exists public.readymode_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade unique,
  login_url text not null default '',
  username text not null default '',
  status text not null default 'unverified'
    check (status in ('connected', 'disconnected', 'authentication_required', 'unverified')),
  last_verified_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only ciphertext is ever written here. The column holds an AES-256-GCM
-- envelope (v1:iv:tag:ciphertext) with a unique initialization value per row.
create table if not exists public.encrypted_credentials (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null default 'readymode_admin',
  login_url text not null,
  username text not null,
  encrypted_password text not null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, kind)
);

create table if not exists public.linked_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  discord_user_id text not null,
  readymode_user_id text not null,
  username text not null,
  full_name text,
  email text,
  created_at timestamptz not null default now(),
  unique (organization_id, readymode_user_id)
);

create index if not exists linked_agents_discord_idx
  on public.linked_agents (organization_id, discord_user_id);

-- ---------------------------------------------------------------------------
-- Automation requests, approvals and audit
-- ---------------------------------------------------------------------------

create sequence if not exists public.automation_request_reference_seq start 1000;

create table if not exists public.automation_requests (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique
    default 'RS ' || nextval('public.automation_request_reference_seq'),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status text not null default 'PENDING' check (
    status in (
      'PENDING',
      'NEEDS_INFORMATION',
      'AWAITING_APPROVAL',
      'APPROVED',
      'RUNNING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'AUTHENTICATION_REQUIRED'
    )
  ),
  action_type text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  requested_by_discord_user_id text,
  requested_by_supabase_user_id uuid references auth.users (id) on delete set null,
  guild_id text,
  channel_id text,
  message_id text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists automation_requests_org_created_idx
  on public.automation_requests (organization_id, created_at desc);

create index if not exists automation_requests_dedupe_idx
  on public.automation_requests (organization_id, dedupe_key, created_at desc);

create table if not exists public.automation_approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.automation_requests (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  approver_discord_user_id text,
  approver_supabase_user_id uuid references auth.users (id) on delete set null,
  approver_role public.readysupport_role not null,
  sequence integer not null default 1,
  created_at timestamptz not null default now(),
  unique (request_id, sequence)
);

create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.automation_requests (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type text not null,
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists automation_events_org_created_idx
  on public.automation_events (organization_id, created_at desc);

create index if not exists automation_events_request_idx
  on public.automation_events (request_id, created_at);

create table if not exists public.browser_sessions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider text not null default 'browserbase',
  provider_session_id text,
  context_id text,
  status text not null default 'active'
    check (status in ('active', 'closed', 'failed', 'authentication_required')),
  request_id uuid references public.automation_requests (id) on delete set null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  last_error text
);

-- ---------------------------------------------------------------------------
-- State configuration
-- ---------------------------------------------------------------------------

create table if not exists public.state_configurations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  readymode_user_id text not null,
  username text,
  states text[] not null default '{}',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, readymode_user_id)
);

create table if not exists public.default_state_configurations (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  states text[] not null default '{}',
  updated_by text,
  updated_at timestamptz not null default now()
);

create table if not exists public.system_settings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  key text not null,
  value jsonb,
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.discord_installations enable row level security;
alter table public.discord_channels enable row level security;
alter table public.discord_role_mappings enable row level security;
alter table public.readymode_connections enable row level security;
alter table public.encrypted_credentials enable row level security;
alter table public.linked_agents enable row level security;
alter table public.automation_requests enable row level security;
alter table public.automation_approvals enable row level security;
alter table public.automation_events enable row level security;
alter table public.browser_sessions enable row level security;
alter table public.state_configurations enable row level security;
alter table public.default_state_configurations enable row level security;
alter table public.system_settings enable row level security;

-- Members can read their own organizations; Owners can update them.
create policy organizations_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

create policy organizations_update on public.organizations
  for update to authenticated
  using (public.has_org_role(id, array['owner']::public.readysupport_role[]))
  with check (public.has_org_role(id, array['owner']::public.readysupport_role[]));

create policy organization_members_select on public.organization_members
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy organization_members_write on public.organization_members
  for all to authenticated
  using (
    public.has_org_role(organization_id, array['owner', 'administrator']::public.readysupport_role[])
  )
  with check (
    public.has_org_role(organization_id, array['owner', 'administrator']::public.readysupport_role[])
  );

-- Read for any member, write for Owners and Administrators.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'discord_installations',
    'discord_channels',
    'discord_role_mappings',
    'readymode_connections',
    'linked_agents',
    'state_configurations',
    'default_state_configurations',
    'system_settings',
    'browser_sessions'
  ]
  loop
    execute format(
      'create policy %1$s_select on public.%1$s for select to authenticated using (public.is_org_member(organization_id));',
      table_name
    );
    execute format(
      'create policy %1$s_write on public.%1$s for all to authenticated using (public.has_org_role(organization_id, array[''owner'', ''administrator'']::public.readysupport_role[])) with check (public.has_org_role(organization_id, array[''owner'', ''administrator'']::public.readysupport_role[]));',
      table_name
    );
  end loop;
end
$$;

-- Requests, approvals and events are readable by any member and are only ever
-- written by the backend through the service role.
create policy automation_requests_select on public.automation_requests
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy automation_approvals_select on public.automation_approvals
  for select to authenticated
  using (public.is_org_member(organization_id));

create policy automation_events_select on public.automation_events
  for select to authenticated
  using (public.is_org_member(organization_id));

-- Encrypted credentials are never readable from the frontend, not even as
-- ciphertext. Only the service role touches this table.
create policy encrypted_credentials_no_access on public.encrypted_credentials
  for select to authenticated
  using (false);

-- ---------------------------------------------------------------------------
-- Housekeeping
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'organizations',
    'organization_members',
    'discord_installations',
    'readymode_connections',
    'encrypted_credentials',
    'automation_requests',
    'state_configurations'
  ]
  loop
    execute format(
      'create trigger %1$s_touch_updated_at before update on public.%1$s for each row execute function public.touch_updated_at();',
      table_name
    );
  end loop;
end
$$;
