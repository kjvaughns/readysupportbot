# Readymode authentication

## The order of operations

Every workflow starts the same way:

1. Open a Browserbase session against the persistent context.
2. Load the dashboard and see what Readymode shows.
3. If signed in — carry on. This is the normal case.
4. If signed out — sign in with the stored credentials, then carry on.
5. If Readymode wants a CAPTCHA, a code, or any other verification — **stop**
   and hand it to a human.

Step 5 is not a limitation waiting to be engineered away. Those controls exist
for a reason, and a bot defeating them would be the security problem rather than
the solution. ReadySupport does not attempt to solve, bypass or work around any
of them, and it will not be made to.

## Where the credentials live

`READYMODE_ADMIN_USERNAME` and `READYMODE_ADMIN_PASSWORD`, as environment
variables, read only at the moment a genuine sign-in is needed. They are:

- registered with the redaction layer at boot, so they cannot appear in a log
  line even by accident
- never written to the database
- never sent to OpenAI
- emptied out of the page before any screenshot is taken

They are not in the source, and there is no code path that reads them for any
purpose other than filling the sign-in form.

## Detecting the state

The dashboard is loaded and five markers are looked for at once:

| Marker | Means |
| --- | --- |
| `auth.captcha.marker` | A challenge — stop |
| `auth.mfa.marker` | A verification code — stop |
| `page.dashboard.marker` | Signed in |
| `page.login.marker` | Signed out |
| `auth.expired.marker` | Session expired |

Verification wins over everything else. A page can show a sign-in form *and* a
CAPTCHA, and treating that as "just expired" would mean typing credentials into
a challenge.

All five are mapped during discovery. Until `page.dashboard.marker` and
`page.login.marker` exist, ReadySupport cannot tell signed-in from signed-out
and says so rather than assuming.

## When the session expires

The bot does several things at once:

1. The queue is **held**. No new jobs are claimed.
2. The request that hit the problem is moved to `AUTHENTICATION_REQUIRED`, not
   `FAILED`. It was a perfectly good request; it should run once someone
   reconnects, not have to be typed again.
3. Every OWNER is alerted, in the alerts channel and by direct message.
4. The requester is told their request has been kept.

```
ReadySupport has lost access to Readymode. No queued changes will run
until an administrator reconnects the account.
```

## Reconnecting

```
/reconnect_readymode
```

OWNER or ADMIN only. It opens a session, tries the stored credentials, and:

**If it works** — the auth state is cleared, the hold is lifted, and every
parked request is put back in the queue. The reply says how many resumed.

**If Readymode wants verification** — it stops and tells you so. That needs a
human:

1. `npm run discover` — opens a browser bound to the same persistent context.
2. Sign in through the live view, completing whatever Readymode asks for.
3. Close the discovery session. The context keeps the new session.
4. `/reconnect_readymode` again — it should now find itself already signed in.

**If the credentials are rejected** — the Readymode password has probably
changed. Update `READYMODE_ADMIN_PASSWORD` and redeploy, then reconnect.

## The manual path in full

Use this when the credentials cannot be typed in by a bot at all — an
account with mandatory MFA on every sign-in, for instance.

1. Run `npm run discover` from a machine with the Browserbase credentials.
2. Open the live view URL it prints.
3. Sign in to Readymode by hand, completing every verification step.
4. Type `quit` to close the session cleanly.
5. `/reconnect_readymode` in Discord.

Nothing about the credential is transmitted anywhere by this flow: the person
signing in types it into Readymode's own form in a browser, and only the
resulting session is retained.

## Keeping the session alive

There is no keep-alive. If Readymode expires sessions aggressively, the bot will
sign in again as needed, and `browser_sessions.performed_login` records each
time it had to. A rising count there means the context is not persisting
properly — check that the Browserbase context ID is right and that it is the
same one used for discovery.

## What is recorded

`browser_sessions` holds one row per session: when it opened, whether it had to
sign in, whether verification appeared, what Readymode made of it, and when it
closed. It holds no cookies, no tokens, and no credentials.

Every authentication event also lands in `automation_events` — expiry,
restoration, and each verification prompt.
