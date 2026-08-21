# Operator troubleshooting

## The connection test reports controls as unresolved

Read the `capabilities` array, not the raw `unresolved` list. Each entry says
whether that capability is usable and what is missing.

Then check three things in the response:

**`pageUrl`** — which page the test looked at. A control can only be found on the
page it lives on. `login.username` is *supposed* to be absent after signing in.

**`frames`** — the frames that were searched. If this shows only `page`, the
interface is not frame-based, or the frames had not loaded when the test ran.

**`controls[].attachedMatches`** — this distinguishes the two failure modes:

| Reading | Meaning | Fix |
| --- | --- | --- |
| `visibleMatches: 0, attachedMatches: 0` | Not on this page at all | Navigate to the right screen, or run discovery |
| `visibleMatches: 0, attachedMatches: 2` | Present but hidden — duplicate panels | Usually resolves once discovery captures the right frame |
| `state: 'ambiguous'` | Several visible matches | Needs a more specific selector from discovery |
| `source: 'builtin'` | Matched only a guess | Fine for reading, refused for changes. Run discovery |

## Every change is refused with "controls unverified"

Expected until a discovery profile is approved. Run:

```bash
curl -X POST -H "Authorization: Bearer <owner-token>" \
  -H "X-Organization-Id: <org>" https://<app>/api/readymode/discover
```

Review `proposals` and `unproposed`, then approve:

```bash
curl -X POST -H "Authorization: Bearer <owner-token>" \
  -H "X-Organization-Id: <org>" \
  https://<app>/api/readymode/profiles/<id>/approve
```

Approval is refused when a profile identified nothing uniquely — approving it
would create the appearance of a verified interface while changing nothing.

## Discovery proposes very few controls

Look at `unproposed`, which gives a reason per control:

- **"No element in the captured interface matched"** — the walk never reached
  that screen. Check `visited` and `skipped`. Raise `maxStops`, or the navigation
  labels do not match the vocabulary in `isSafeToClick`.
- **"Matched N elements, but none could be identified uniquely"** — the elements
  exist but have no distinguishing handle. This is common on legacy markup with
  no ids. Those controls stay unusable for changes, honestly.

## Readymode asks for human verification

The queue lane pauses and the notification channel is told. Nothing retries.
An Owner reconnects with `POST /api/readymode/reconnect`, which resumes the lane
on success. ReadySupport never solves a CAPTCHA or a multi-factor prompt.

## "Continued past the administrator session notice but could not confirm the dashboard"

ReadySupport clicked Continue once, then could not verify it reached the
dashboard, so it stopped rather than proceeding blind. Usually the dashboard
signals in `LOGIN_SUCCESS_CONDITIONS` do not match this interface. Run discovery
and check the dashboard capture. The click is not retried — the attempt is marked
used for the whole session.

## A workflow fails verification after saving

By design: the workflow reopened the agent, re-read it, and the saved values did
not match the request. Nothing is retried automatically, because a partially
applied change must be re-read before anything else is attempted. Check the audit
event and the screenshot, then send the request again.

## Nothing appears in Discord

Check, in order: the guild is installed, the channel is approved, the user's
Discord role maps to a ReadySupport role, and `requireMention` matches how you
are addressing the bot. `GET /api/connections` shows all four.

## Where the evidence is

Screenshots go to `artifacts/` in the container (override with
`READYSUPPORT_ARTIFACT_DIR`). Container storage is ephemeral — the audit trail in
Supabase is the durable record. Raw discovery evidence is Owner-only via
`GET /api/readymode/profiles/:id/evidence`, and reading it is audited.
