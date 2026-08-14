-- ReadySupport 0002 — who may use the bot, and as what.
--
-- Authority lives here and nowhere else. Discord role names are deliberately
-- not consulted: renaming a Discord role must not change what the bot allows.

create table bot_users (
  id                uuid primary key default gen_random_uuid(),
  discord_user_id   text not null unique,
  -- Display only. Discord handles change; discord_user_id is the identity.
  discord_username  text,
  role              bot_role not null,
  active            boolean not null default true,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- Who granted this access. Null for the bootstrap owner seeded at setup.
  created_by        text,
  constraint bot_users_discord_user_id_is_snowflake
    check (discord_user_id ~ '^[0-9]{15,25}$')
);

create index bot_users_role_idx on bot_users (role) where active;

create trigger bot_users_set_updated_at
  before update on bot_users
  for each row execute function set_updated_at();

comment on table bot_users is
  'Discord user id to internal ReadySupport role. The only source of authority.';
comment on column bot_users.active is
  'Set false to revoke access without losing the audit trail of what they did.';
