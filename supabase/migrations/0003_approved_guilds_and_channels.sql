-- ReadySupport 0003 — where the bot is allowed to operate.
--
-- The bot ignores every interaction from a server or channel that is not
-- listed here, even from a user who holds a role in bot_users. Being invited
-- to a server is not the same as being trusted by it.

create table approved_guilds (
  guild_id    text primary key,
  name        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  text,
  constraint approved_guilds_id_is_snowflake
    check (guild_id ~ '^[0-9]{15,25}$')
);

create trigger approved_guilds_set_updated_at
  before update on approved_guilds
  for each row execute function set_updated_at();

-- What a channel is allowed to be used for.
--   COMMANDS          slash commands accepted here
--   NATURAL_LANGUAGE  free-form requests accepted here (normally exactly one)
--   ALERTS            the bot posts health and authentication alerts here
create type channel_purpose as enum ('COMMANDS', 'NATURAL_LANGUAGE', 'ALERTS');

create table approved_channels (
  id          uuid primary key default gen_random_uuid(),
  guild_id    text not null references approved_guilds (guild_id) on delete cascade,
  channel_id  text not null,
  purpose     channel_purpose not null default 'COMMANDS',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  text,
  constraint approved_channels_id_is_snowflake
    check (channel_id ~ '^[0-9]{15,25}$'),
  constraint approved_channels_unique_purpose unique (channel_id, purpose)
);

create index approved_channels_guild_idx on approved_channels (guild_id) where active;
create index approved_channels_lookup_idx on approved_channels (channel_id, purpose) where active;

create trigger approved_channels_set_updated_at
  before update on approved_channels
  for each row execute function set_updated_at();

comment on table approved_channels is
  'Channel allow-list. A channel absent from this table is treated as untrusted.';
