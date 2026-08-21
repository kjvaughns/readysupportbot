-- Readymode interface profiles.
--
-- ReadySupport does not assume how Readymode's screens are built. It observes
-- the real authenticated interface, proposes selectors from that evidence, and
-- an Owner approves a profile before those selectors are used for anything.
-- These tables hold that evidence and the approval state.
--
-- Written exclusively by the backend service role. Members may read the profile
-- and its selectors; nobody reads the raw evidence from the frontend.

create table if not exists public.readymode_interface_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  status text not null default 'proposed'
    check (status in ('proposed', 'active', 'superseded', 'rejected')),
  schema_version integer not null default 1,
  base_url text not null default '',
  interface_version text not null default 'unknown'
    check (interface_version in ('starter', 'iq', 'unknown')),
  pages_captured integer not null default 0,
  controls_total integer not null default 0,
  controls_proposed integer not null default 0,
  capabilities jsonb not null default '[]'::jsonb,
  unproposed jsonb not null default '[]'::jsonb,
  screenshot_paths text[] not null default '{}',
  discovered_by uuid references auth.users (id) on delete set null,
  discovered_at timestamptz not null default now(),
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  superseded_by uuid references public.readymode_interface_profiles (id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- At most one active profile per organization. The approval path depends on
-- this: a concurrent double approval fails loudly instead of quietly leaving
-- two profiles active.
create unique index if not exists readymode_interface_profiles_one_active
  on public.readymode_interface_profiles (organization_id)
  where status = 'active';

create index if not exists readymode_interface_profiles_org_discovered_idx
  on public.readymode_interface_profiles (organization_id, discovered_at desc);

create table if not exists public.readymode_selector_versions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null
    references public.readymode_interface_profiles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  control_name text not null,
  -- A serialized SelectorStrategy. Patterns are stored as {source, flags} and
  -- are validated on read, because a stored selector is data, not code.
  strategy jsonb not null,
  tier text not null,
  confidence integer not null check (confidence between 0 and 100),
  root_name text not null default '',
  root_url text not null default '',
  -- A pointer to the evidence, not the evidence itself.
  evidence_ref jsonb not null default '{}'::jsonb,
  verified boolean not null default false,
  verified_matches integer not null default 0,
  created_at timestamptz not null default now(),
  unique (profile_id, control_name)
);

create index if not exists readymode_selector_versions_org_control_idx
  on public.readymode_selector_versions (organization_id, control_name);

-- The raw captured evidence. Large, and never readable from the frontend.
-- It is already sanitized and stripped of personal data before it arrives.
create table if not exists public.readymode_interface_evidence (
  profile_id uuid primary key
    references public.readymode_interface_profiles (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  evidence jsonb not null,
  byte_size integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.readymode_interface_profiles enable row level security;
alter table public.readymode_selector_versions enable row level security;
alter table public.readymode_interface_evidence enable row level security;

-- Read for members. Deliberately no write policy: promoting a profile to active
-- must go through the audited backend endpoint, never a direct table update.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'readymode_interface_profiles',
    'readymode_selector_versions'
  ]
  loop
    execute format(
      'create policy %1$s_select on public.%1$s for select to authenticated using (public.is_org_member(organization_id));',
      table_name
    );
  end loop;
end
$$;

-- Raw evidence is not readable from the frontend at all, mirroring how
-- encrypted_credentials is handled in 0001.
create policy readymode_interface_evidence_no_access
  on public.readymode_interface_evidence
  for select to authenticated
  using (false);

create trigger readymode_interface_profiles_touch_updated_at
  before update on public.readymode_interface_profiles
  for each row execute function public.touch_updated_at();
