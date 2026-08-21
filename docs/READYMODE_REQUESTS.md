# What people can ask ReadySupport for

## Seats and licences

**"Log out inactive users"** — `/clear-licenses`

Readymode has its own control on the Users screen for releasing idle sessions.
ReadySupport presses that control rather than deciding for itself who counts as
inactive: Readymode owns that definition, and second-guessing it would mean
signing out people it would have left alone.

The confirmation shows how many seats are currently held, and the result reports
how many were actually freed — measured by re-reading the list, not by trusting
the on-screen message. One confirmation is required. It does **not** need a
second approver: it uses Readymode's own control and anyone logged out can sign
straight back in.

**"Sign this person out"** — `/force-logout`

Targeted, and disruptive to whoever is using that seat, so it works differently:

- resolves to exactly one account first, never a first name,
- requires a **second Owner or Administrator**,
- optionally resets the password at the same time (`reset_password: true`), so
  the seat cannot be retaken with the old credentials.

ReadySupport never reads the new password. Readymode delivers it through its own
channel.

## Assignments (lead pools)

A "lead pool" is a **playlist** in Readymode — playlist membership is what
decides which leads reach which agent.

| Ask | Command |
| --- | --- |
| Put someone in a playlist | `/add-assignment` |
| Take someone out of a playlist | `/remove-assignment` |
| See what someone is on | `/view-assignments` |

Assignment adds membership without disturbing what an agent already has, and
removal takes away only the named playlists. Membership level (Primary, Backup,
Tertiary) is settable when assigning. Naming a playlist that does not exist in
Readymode stops the request rather than saving a partial change.

## Accounts

`/create_account` and `/create_accounts` are unchanged. Creating more than one
account at a time is a bulk change and needs a second Owner or Administrator.

## Troubleshooting

`/troubleshoot`, or just describe the problem — "my audio isn't working", "I
can't log in", "I'm Ready but not getting calls". ReadySupport recognizes a
problem report and answers with checks instead of trying to turn it into an
administrative change.

**These answers are currently general guidance, and say so.** The Help Center has
not been crawled yet, so ReadySupport gives checks that hold for any
browser-based dialer — headset connection, browser microphone permission, the
right input and output device, status versus assignment — and states plainly that
these are not steps from the official Readymode documentation. It never invents a
Readymode menu path or button name.

Once an Owner runs the Help Center sync, retrieval from the official articles
takes precedence and answers carry a source link.

## Who can do what

Every action has a required permission, and an Owner can raise the bar per action
without a deploy:

```
GET  /api/permissions/actions          # current requirements
POST /api/permissions/actions          # { "action": "CREATE_ACCOUNT", "role": "administrator" }
```

Defaults:

| Action | Default minimum |
| --- | --- |
| Sign a user out (`FORCE_LOGOUT`) | Administrator |
| Reset a password | Administrator |
| Deactivate an account | Administrator |
| Log out inactive users | Support |
| Create accounts | Support |
| Assign / remove playlists | Support |
| Everything read-only | Viewer |

Overrides can only ever be **stricter**. Naming a role that lacks the underlying
permission changes nothing — the permission check runs first, so an override
cannot be used to widen access.

Discord roles map onto these four ReadySupport roles through
`POST /api/permissions`, so gating in practice means mapping your Discord roles
once and then tightening individual actions if you want to.

## Before any of this works

Every action listed here that **changes** Readymode is gated on selectors
observed in your real interface. Until an Owner runs
`POST /api/readymode/discover` and approves the resulting profile, these requests
are refused with an explanation naming the missing controls — including
`/clear-licenses`, which needs the "Log Out Inactive Users" control identified
before it will click anything.

Read-only requests — agent status, licence usage, troubleshooting — work now.
