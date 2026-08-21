# ReadySupport safety model

## The core rule

ReadySupport may **read** Readymode using its best guess at where things are. It
may only **change** Readymode using selectors it has observed in that
organization's real interface and an Owner has approved.

This is enforced in one place — `assertCapabilityVerified` in
`src/readymode/executor.ts` — which runs before any browser interaction for every
action. When the controls are not verified it raises `ControlsUnverifiedError`,
naming exactly which controls are missing and pointing an Owner at
`POST /api/readymode/discover`. Nothing is attempted.

With no approved profile, every modifying action refuses. That is the intended
posture, not a regression.

## The administrator session notice

Readymode warns when signing in will disconnect another administrator. This is
the **only** interstitial ReadySupport is authorized to click through.

`classifyInterstitial` is a pure function returning exactly one of ten
classifications, and permission to click is computed in a single place as
`classification === 'admin_session_takeover'`:

| Classification | Continue? |
| --- | --- |
| `admin_session_takeover` | **Yes**, once, under the conditions below |
| `human_verification` (CAPTCHA, 2FA, OTP) | Never |
| `destructive_confirmation` | Never |
| `account_suspended` | Never |
| `password_expired` | Never |
| `no_admin_license` | Never |
| `permission_denied` | Never |
| `credentials_rejected` | Never |
| `limited_admin_mode` | Never |
| `unknown` | Never |

`unknown` is the default, so an unrecognized phrasing fails closed.

A takeover additionally requires **all** of:

1. the page is on the configured Readymode host (exact match, not a suffix),
2. wording that another administrator session will be signed out,
3. exactly one visible Continue button,
4. no password field on the page,
5. no CAPTCHA present,
6. no disqualifying signal anywhere in the text — re-checked explicitly, so
   reordering the classifier cannot introduce a false positive.

Then: an audit event is written, the attempt is marked as used **before** the
click so a throw cannot be retried, one click happens, and the dashboard is
verified afterwards. If the dashboard cannot be confirmed, the login stops rather
than proceeding.

Limited Admin Mode is reported honestly — only License Usage is available — and
ReadySupport does **not** sign anyone out to free a licence.

CAPTCHA and multi-factor prompts are never solved, never bypassed, never clicked
past. They pause the queue and notify an Owner.

### How this is proven

`tests/interstitial.test.ts` runs every non-takeover fixture a second time with a
Continue button and takeover wording bolted on, and asserts each still refuses. A
CAPTCHA page offering Continue, or a "this cannot be undone" page offering
Continue, must never become clickable. Writing that test found two real bugs: a
"this account has been locked" page and an "all administrator licenses are in
use" page were both slipping past the disqualifying re-check, because the
patterns had been written out twice and had drifted. There is now one definition
of each pattern.

## Untrusted input

Discord messages and Readymode page content are data, never instructions. Page
text passes through `sanitizePageValue` before use, and instruction-shaped
content is neutralized and recorded before it reaches the language model. The
model fills in a closed action schema and nothing else — it never selects a page,
a selector, or a browser step.

## Personal data

Discovery reads real pages containing real people's data. It keeps the shape of
the interface and discards the contents: no input values, no table bodies, and
emails, phone numbers, SSNs, card numbers, addresses, dates of birth and account
numbers masked wherever they appear.

Raw evidence is stored in its own table with **no frontend read access at all**,
mirroring how encrypted credentials are handled. Reading it requires an Owner and
is audited.

## Dry run

`DRY_RUN=true` is the default and should stay set until each workflow has passed
its read-only and dry-run tests against the real interface. In dry run, workflows
read Readymode and report exactly what would change, and save nothing.
