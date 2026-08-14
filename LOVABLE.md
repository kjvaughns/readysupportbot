# Brief for Lovable — the ReadySupport dashboard

**Read this before generating anything.** It describes one specific product, its
constraints, and several things that must not be changed. The constraints are
not stylistic preferences; some of them are the reason the system is safe.

There is a working visual reference in this repository at
**`design/readysupport-ui.html`** — a single self-contained HTML file. Open it in
a browser and click through it. It is the design, already resolved: layout,
colour, spacing, component behaviour, empty and error states, mobile
navigation. Match it rather than reinterpreting it.

---

## 1. What you are building

A **read-only operations dashboard** for ReadySupport, a Discord bot that
performs Readymode administration. The dashboard shows what the bot is doing:
requests and their status, agents, license usage, an audit trail, connection
health, team members and settings.

**Stack:** React + Vite + TypeScript + Tailwind + shadcn/ui.

## 2. What you are *not* building

- **Not the bot.** The bot already exists in this repository as a Node
  service. Do not generate Discord code, Playwright code, or anything that
  talks to Readymode.
- **Not a backend.** Do not create Supabase Edge Functions, API routes, or
  server code. The dashboard reads from Supabase directly.
- **Not on Lovable Cloud.** Connect to the existing Supabase project described
  below. Provisioning a second database would split the data in half — the bot
  writing to one and the dashboard reading from another.
- **Not a marketing page.** No landing page, no hero, no pricing. The
  authenticated application only.
- **Not the database schema.** The tables already exist and are already
  migrated. Do not create, alter or drop tables.

---

## 3. How the pieces fit

```
Supabase (existing)  ←── writes ───  ReadySupport bot   (Node, on Railway)
        ↑                                    │
        └────────── reads ──────  Dashboard (this build)
```

Three layers, one database. The bot is the only thing that writes automation
data and the only thing that touches Readymode. The dashboard observes.

---

## 4. Connecting to Supabase

Use the existing project. Two values, both from Supabase → Project Settings →
API:

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<the anon / publishable key>
```

### Never use the service role key

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security completely. It belongs
to the bot process and nowhere else. Anything in a frontend bundle is public —
putting that key in this app would hand every visitor unrestricted read and
write access to the whole database. If you find yourself reaching for it
because a query returns nothing, the answer is section 8, not that key.

### Authentication

Supabase Auth with the **Discord provider**. The same people already use the
bot through Discord, so asking them for a second set of credentials would be
inventing a problem. After sign-in, look the user up in `bot_users` by their
Discord ID to find their role. Somebody with no `bot_users` row is not a user of
this product — sign them out with a plain message saying an owner needs to add
them.

---

## 5. Scope: read-only, and why

Build every screen. Render every button. But **buttons that would change
Readymode do not perform the action** — they open a dialog explaining that
changes are submitted through Discord, with the matching command to copy.

This is deliberate. Every change in ReadySupport passes through a chain the bot
owns: permission check, confirmation showing the exact values, a second
approver for deactivations, a sequential queue, independent verification after
the fact, and an immutable audit record. A dashboard writing directly to the
database would skip all of it. Wiring up the buttons needs an authenticated API
on the bot, which does not exist yet — see section 11.

So: the dashboard is complete and useful as a window onto the system, and it
does not quietly become a second way to change accounts.

---

## 6. Design system

Take these exactly. They are the brand.

```js
// tailwind.config.ts — theme.extend.colors
brand:   { DEFAULT: '#6D5DFB', press: '#5B4BE0', tint: '#F1EFFE', line: '#D5CFFB' },
ink:     { DEFAULT: '#18181B', 2: '#3F3F46', 3: '#71717A', 4: '#A1A1AA' },
surface: { DEFAULT: '#FFFFFF', 2: '#FAFAFB', 3: '#F4F4F5' },
page:    '#F7F7F8',
line:    '#E5E7EB',
ok:      { DEFAULT: '#16A34A', tint: '#ECFDF3', line: '#BBF7D0' },
warn:    { DEFAULT: '#D97706', tint: '#FFFBEB', line: '#FDE68A' },
danger:  { DEFAULT: '#DC2626', tint: '#FEF2F2', line: '#FECACA' },
```

**Type.** Inter, with Geist as a second choice. Body 14px/1.5. Page titles
22px/600 at `-0.02em`. Card titles 15px/600. Small print 12px. Any column of
numbers gets `font-variant-numeric: tabular-nums`.

**Surfaces.** Cards are white on `#F7F7F8`, 14px radius, 1px `#E5E7EB` border,
and a shadow barely there:
`0 1px 2px rgba(24,24,27,.04), 0 1px 3px rgba(24,24,27,.06)`. Borders separate
things; shadows only lift them slightly. No gradients. No illustrations.

**Spacing.** 24px page padding, 16px between cards, 16px inside them. Generous.
Do not compress to fit more in.

**Motion.** Almost none. 120ms ease-out on overlays, a slow pulse on a running
job, nothing else. Respect `prefers-reduced-motion`.

**Theme.** Light only. This is a deliberate choice, not an omission — do not add
a dark mode.

### Three conventions that carry meaning

These are load-bearing. Keep them consistent everywhere they appear.

1. **The kind dot.** A 6px dot before every action name: grey `#A1A1AA` for
   read-only, purple `#6D5DFB` for changes an account, red `#DC2626` for removes
   access. Same three markers on quick actions, table rows, the audit log and
   dialog headers, so the distinction is learnable in one sitting.
2. **The request ID.** `RS-1048`, always monospace, always in a purple chip.
   Traceability is what this product promises, so the ID looks like an object
   you can grab. It appears on every row, panel and log entry.
3. **The connection rail.** The Readymode connection card carries a 4px coloured
   stripe down its left edge — green, amber or red. Whether the bot can reach
   Readymode must be answerable from peripheral vision.

### Status pills

Nine request statuses. Pill with a 6px dot, tinted background, matching border:

| Status | Colour |
|---|---|
| `PENDING` | grey |
| `AWAITING_INFORMATION` | amber |
| `AWAITING_APPROVAL` | amber |
| `APPROVED` | purple |
| `RUNNING` | purple, dot pulses |
| `COMPLETED` | green |
| `FAILED` | red |
| `CANCELLED` | grey |
| `AUTHENTICATION_REQUIRED` | red |

Show the human label, never the enum: "Waiting for approval", not
`AWAITING_APPROVAL`.

---

## 7. Screens

Left sidebar, eight items, logo at top, organisation and user at the bottom
with Help and Sign out. Below 860px the sidebar becomes a drawer behind a
hamburger.

| Screen | Shows | Reads from |
|---|---|---|
| **Sign in** | Discord sign-in only | Supabase Auth |
| **Overview** | Connection card first, four stat cards, recent requests, needs-attention, license holders, completed today | `system_settings`, `automation_requests`, `readymode_accounts` |
| **Requests** | Filterable table: ID, action, target, requester, status, created, completed | `automation_requests` |
| **Request detail** | Right side panel: original wording, extracted fields, approval, timeline, verification, evidence, error | `automation_requests`, `automation_events`, `automation_approvals` |
| **Agents** | Searchable table with license and account status | `readymode_accounts` |
| **Agent detail** | Account info, live status, recent actions on it | `readymode_accounts`, `automation_requests` |
| **Licenses** | Four figures, a segmented usage meter, table of current holders | `readymode_accounts` |
| **Activity** | Audit log: time, person, action, target, result, request, evidence | `automation_events` |
| **Connections** | Readymode card plus Discord, Browserbase, Supabase, OpenAI | `system_settings`, `browser_sessions` |
| **Team** | Members, roles, status, and what each role can do | `bot_users` |
| **Settings** | Eight sections, form controls only | `system_settings`, `approved_channels` |

Every screen needs a **loading** state (skeleton rows, not a spinner), an
**empty** state (icon, one line of what it is, one line of what to do), and an
**error** state (what failed, that nothing was changed, a retry). All three are
in the reference file.

The Overview exists to answer one question: *does anything need me right now?*
Do not add charts. Four numbers and the things that need attention.

---

## 8. Row-level security

**The dashboard will read nothing until you do this, and that is correct.**

Every table has RLS enabled with no permissive policies, because the bot
authenticates as the service role and enforces permissions itself. An anon key
correctly sees zero rows.

Apply this SQL in the Supabase SQL editor. It grants **reads only** — writes
stay with the bot.

```sql
-- Link a Supabase Auth user to their ReadySupport role.
alter table bot_users add column if not exists auth_user_id uuid references auth.users (id);
create unique index if not exists bot_users_auth_user_id_key
  on bot_users (auth_user_id) where auth_user_id is not null;

-- The signed-in user's role, or null if they are not a ReadySupport user.
--
-- `security definer` is not optional here and is not a shortcut. The policy on
-- bot_users calls this function, and this function reads bot_users. Without
-- security definer that is infinite recursion and every query fails. Leave it.
create or replace function current_bot_role()
returns bot_role language sql stable security definer set search_path = public as $$
  select role from bot_users
   where active and (
     auth_user_id = auth.uid()
     or discord_user_id = (auth.jwt() -> 'user_metadata' ->> 'provider_id')
   )
   limit 1;
$$;

create or replace function current_discord_id()
returns text language sql stable security definer set search_path = public as $$
  select discord_user_id from bot_users
   where active and (
     auth_user_id = auth.uid()
     or discord_user_id = (auth.jwt() -> 'user_metadata' ->> 'provider_id')
   )
   limit 1;
$$;

-- Re-runnable: Postgres has no CREATE POLICY IF NOT EXISTS, so each one is
-- dropped first. Safe to paste more than once.

-- SUPPORT and above see every request; VIEWER sees only their own.
drop policy if exists dashboard_read_requests on automation_requests;
create policy dashboard_read_requests on automation_requests for select to authenticated
  using (
    current_bot_role() in ('OWNER','ADMIN','SUPPORT')
    or requester_discord_id = current_discord_id()
  );

drop policy if exists dashboard_read_events on automation_events;
create policy dashboard_read_events on automation_events for select to authenticated
  using (current_bot_role() in ('OWNER','ADMIN','SUPPORT'));

drop policy if exists dashboard_read_approvals on automation_approvals;
create policy dashboard_read_approvals on automation_approvals for select to authenticated
  using (current_bot_role() in ('OWNER','ADMIN','SUPPORT'));

drop policy if exists dashboard_read_accounts on readymode_accounts;
create policy dashboard_read_accounts on readymode_accounts for select to authenticated
  using (current_bot_role() is not null);

drop policy if exists dashboard_read_team on bot_users;
create policy dashboard_read_team on bot_users for select to authenticated
  using (current_bot_role() is not null);

-- Operational state is for administrators.
drop policy if exists dashboard_read_settings on system_settings;
create policy dashboard_read_settings on system_settings for select to authenticated
  using (current_bot_role() in ('OWNER','ADMIN'));

drop policy if exists dashboard_read_sessions on browser_sessions;
create policy dashboard_read_sessions on browser_sessions for select to authenticated
  using (current_bot_role() in ('OWNER','ADMIN'));

drop policy if exists dashboard_read_channels on approved_channels;
create policy dashboard_read_channels on approved_channels for select to authenticated
  using (current_bot_role() in ('OWNER','ADMIN'));
```

Then set `auth_user_id` on each `bot_users` row after that person first signs
in, or rely on the Discord ID match in the functions above.

**If a query returns nothing, the fix is a policy — never a looser policy and
never the service role key.** Do not add `using (true)` to anything. Do not
disable RLS on any table. These tables hold an audit trail that is supposed to
be tamper-evident.

---

## 9. Rules that must not be broken

1. **Never display a password.** Not in a table, a detail panel, a log entry or
   a tooltip. The bot generates temporary passwords, delivers them through a
   private Discord reply, and destroys them. None is ever stored, so there is
   nothing for this dashboard to show. If you find a field that looks like one,
   it is a bug — do not render it.
2. **The audit log is read-only.** No edit, no delete, no bulk actions. The
   database refuses those anyway, by trigger.
3. **Never hide a connection problem.** If Readymode is unreachable, that is the
   most important thing on the screen — a red rail on the Overview card and a
   persistent banner on every other page.
4. **One obvious primary action per screen.** Overview and Requests: New
   request. Agents: Create account. Licenses: Clear inactive licenses.
5. **Separate reading from changing.** Read-only actions and account-changing
   actions never sit in an undifferentiated list. Group them, label the groups,
   and mark each with its kind dot.
6. **Plain language, never error codes.** "I could not find an account matching
   that" — not `NO_MATCH`. "Two accounts share that name, pick the right one" —
   not `AMBIGUOUS_MATCH`. The person reading this runs an agency; they do not
   need to learn your enum.
7. **Disable a button while its action is running,** and show what is happening.
   Never let the same thing be submitted twice.
8. **Every action is traceable by request ID.** Show it everywhere the action
   appears.

---

## 10. Writing the copy

Write from the reader's side of the screen. "Clear license", then a toast that
says "License cleared." An error says what happened and what to do next, with no
apology and no vagueness.

The bot speaks in the first person and so should the dashboard when it is
reporting what the bot did: "I stopped without changing anything. Two accounts
are named Marcus Smith." That voice is in the reference file throughout — follow
it.

---

## 11. Later, if you want the buttons wired up

Submitting and approving actions from the dashboard needs an authenticated API
on the bot process — it already runs an HTTP server for its health endpoint.
Roughly: `POST /api/requests` to submit, `POST /api/requests/:id/approve` to
confirm, both verifying the Supabase JWT and then going through the bot's
existing permission, approval and queue code.

That work does not exist yet and is out of scope here. Do not approximate it by
writing to the database from the browser: the independent-approver rule, the
ten-minute expiry, the sequential queue and the verification step all live in
the bot, and a dashboard insert would go around every one of them.

---

## 12. Done means

- Every screen in section 7 exists, with loading, empty and error states.
- It matches `design/readysupport-ui.html` closely enough that they look like
  the same product.
- It works on a phone: sidebar becomes a drawer, tables scroll inside their own
  container, nothing makes the page scroll sideways.
- Only the anon key is in the bundle. Search the built output for
  `service_role` and confirm it is absent.
- Signing in as a VIEWER shows only their own requests. Signing in as somebody
  with no `bot_users` row shows a plain "ask an owner to add you".
- No table was created, altered or dropped, and no RLS policy uses
  `using (true)`.
