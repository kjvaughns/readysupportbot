# Discord setup

## Create the application

1. Go to <https://discord.com/developers/applications> and click **New
   Application**. Name it ReadySupport.
2. **General Information** → copy the **Application ID** into
   `DISCORD_CLIENT_ID`.
3. **Bot** → **Reset Token**, copy it into `DISCORD_BOT_TOKEN`. It is shown
   once. Treat it as a password: anyone holding it can act as the bot.

## Intents

Under **Bot** → **Privileged Gateway Intents**:

- **Message Content Intent** — **on**. This is what lets the bot read free-form
  requests in the designated channel. Without it, slash commands still work and
  only that one channel goes quiet.
- Presence and Server Members intents — leave **off**. Nothing here needs them.

## Invite it

**OAuth2** → **URL Generator**:

- Scopes: `bot`, `applications.commands`
- Bot permissions: **View Channels**, **Send Messages**, **Embed Links**,
  **Read Message History**, **Use Slash Commands**

That is the whole list. ReadySupport does not need Manage Server, Manage Roles,
Manage Messages or Administrator, and should not be given them — its authority
comes from its own database, not from Discord, so extra Discord permissions add
risk without adding capability.

Open the generated URL and add the bot to your server.

## Channels

Three roles, which can be the same channel or three different ones:

| Purpose | What happens there |
| --- | --- |
| `COMMANDS` | Slash commands are accepted |
| `NATURAL_LANGUAGE` | Free-form requests are read. Normally exactly one channel |
| `ALERTS` | The bot posts health and authentication alerts |

A channel the bot has been invited to but which is not in `approved_channels` is
treated as untrusted and ignored. Being in a server is not the same as being
trusted by it.

Set them up with the seed script:

```bash
npm run seed:owner -- \
  --discord-id YOUR_USER_ID \
  --commands-channel COMMANDS_CHANNEL_ID \
  --nl-channel NL_CHANNEL_ID \
  --alerts-channel ALERTS_CHANNEL_ID
```

Put the natural-language channel ID in `DISCORD_NL_CHANNEL_ID` too. Both are
required — the environment variable says where to listen, the database row says
it is allowed. An environment variable pointing at a channel nobody approved is
not enough.

### Suggested channel setup

Make the natural-language and command channels private to the people who should
be using ReadySupport. It refuses anyone not in `bot_users` regardless, but
there is no reason to advertise the bot to people who cannot use it.

The alerts channel should be somewhere people actually look. An expired
Readymode session stops all queued work, and an alert in a channel nobody
watches is not a notification. Critical alerts are also sent as direct messages
to every OWNER, which is the backstop — but owners commonly have DMs closed, so
the channel matters.

## Register the commands

```bash
npm run register
```

Commands are registered to `DISCORD_GUILD_ID` only, not globally. Guild commands
appear immediately where global ones take up to an hour, and a tool that
administers real accounts has no business being installable in servers nobody
approved.

To remove them:

```bash
npm run register -- --clear
```

## Adding people

Insert into `bot_users`:

```sql
insert into bot_users (discord_user_id, discord_username, role, created_by)
values ('123456789012345678', 'someone', 'SUPPORT', 'your-discord-id');
```

| Role | Can |
| --- | --- |
| `OWNER` | Everything, including managing permissions |
| `ADMIN` | Create, clear licenses, reset passwords, deactivate, view all logs |
| `SUPPORT` | Create, clear licenses, reset passwords, view account status |
| `VIEWER` | License usage, agent status, and their own requests |

Discord role names are never consulted. Someone with Administrator in the server
has no standing with ReadySupport unless they are in this table, and a server
owner cannot grant themselves access by editing Discord roles.

To revoke access, set `active = false` rather than deleting the row — that keeps
the audit trail of what they did intact.

## Checking it works

In an approved channel:

```
/help          — should describe your access level
/login_status  — should show green for Discord and the database
```

If `/help` says you are not set up, the `bot_users` row is missing or `active`
is false. If nothing happens at all, the channel is probably not in
`approved_channels`.
