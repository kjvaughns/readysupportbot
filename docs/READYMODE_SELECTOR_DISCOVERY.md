# Readymode selector discovery

## Why this exists

ReadySupport's original selectors were written without access to a real
Readymode interface. They were guesses, and the connection test proved it by
reporting 15 of 21 controls unresolved.

The fix is not better guesses. It is to make ReadySupport **learn** its selectors
from the real authenticated interface, and to refuse to act on anything it has
not observed.

## What was actually wrong

Three separate defects produced that report. All three are fixed.

**1. The test looked at one page.** `POST /api/readymode/test` signed in and then
ran the control report against whatever page it landed on. After login the login
fields are gone from the DOM, and the users, campaigns and queue screens had
never been opened — so almost everything was "missing" by construction. The two
controls that did resolve (`login.submit`, `licenses.table`) match generic
markup, so they were most likely false positives on the dashboard.

**2. Nothing looked inside frames.** `page.frames()`, `frameLocator` and
`contentFrame` appeared nowhere in the codebase. Every lookup ran against the
top-level page. A legacy frame-based interface is invisible to that.

**3. Visibility was counted wrong.** `countVisible` waited for state `attached`
rather than `visible`, so hidden duplicate panels — which legacy interfaces keep
in the DOM — were counted as matches and pushed controls into a false
"ambiguous, therefore unresolved" verdict.

## How discovery works now

```
POST /api/readymode/discover        (Owner only, read-only)
   │
   ├─ capture the login page          ← before signing in, while the fields exist
   ├─ sign in                          ← handles the administrator session notice
   ├─ capture the dashboard
   ├─ follow safe navigation, capturing each stop
   │
   ├─ propose selectors from the evidence
   └─ store as a PROPOSED profile      ← not used for anything yet

POST /api/readymode/profiles/:id/approve   (Owner only)
   └─ the profile becomes ACTIVE and its selectors take effect
```

### What is collected

Per page, and per frame within it: URL, title, frame URLs, navigation labels,
buttons and their labels, input types/names/ids/placeholders/associated labels,
links and destinations, form actions, table column headings, checkboxes and
nearby text, select fields and option labels, stable attributes, and a
screenshot.

### What is never collected

Input **values** are never read — there is no `.value` access anywhere in the
collector. Password fields keep only their structural identity (that they exist,
their name, their label); everything value-adjacent is dropped. Cookies, storage
and tokens are never touched. Table **bodies** are never read, only headings —
that is where lead data lives.

Everything captured passes through `sanitizePageValue` and then
`scrubPersonalData`, which masks emails, phone numbers, SSNs, card numbers,
street addresses, dates of birth and long account numbers.

One subtlety worth knowing: personal-data scrubbing deliberately does **not**
apply its "long digit run" rule to structural fields (`id`, `name`, `cssPath`).
Scrubbing those would corrupt the very selectors discovery is trying to build.

### Read-only by construction

The walk clicks navigation and nothing else. `isSafeToClick` refuses any label
matching save, submit, apply, create, add, delete, remove, deactivate, reset,
clear, sign out, import, charge, confirm, continue and similar — and requires a
positive match against a navigation vocabulary. It never types into a field and
never submits a form.

## From evidence to selectors

`proposeSelectors` scores candidate strategies by how stable they are:

| Tier | Score | Example |
| --- | --- | --- |
| stable attribute | 100 | `data-testid="save-agent"` |
| id | 92 | `#saveButton` |
| name | 88 | `input[name="username"]` |
| role + name | 76 | button named "Save" |
| label | 70 | field labelled "Password" |
| placeholder | 60 | placeholder "Search" |
| text | 48 | visible text "Save" |
| css path | 25 | `div > form > button:nth-of-type(2)` |

Penalties apply for generated-looking identifiers (−15) and for elements that
are not visible (−40).

**The uniqueness rule is absolute**: a proposal is emitted only when its strategy
matches exactly one element, in exactly one frame, anywhere in the captured
evidence. Anything else is reported as unproposed with the reason. Below 60, or
at `css-path` tier, a proposal is recorded but never usable.

## Where a selector may come from

At run time, `resolveControl` tries, in order:

1. the organization's **active, Owner-approved profile**,
2. the committed `src/readymode/selectors/observed.generated.ts`,
3. the built-in candidates — which are guesses, and are labelled as such.

Every report says which source matched. That distinction is enforced, not
cosmetic: **a built-in guess may be used to read Readymode, but never to change
it.** `capabilities.ts` marks a modifying capability unusable when its controls
only resolved through a built-in, and the executor refuses before the browser
does anything.

## Committing selectors to git

```bash
# As an Owner, fetch the report for an approved profile
curl -H "Authorization: Bearer <token>" -H "X-Organization-Id: <org>" \
  https://<app>/api/readymode/profiles/<id>/report > evidence/2026-08-21.json

npm run selectors:apply evidence/2026-08-21.json
npm run selectors:check          # CI drift detection
```

The script refuses to emit anything unverified, anything below the confidence
threshold, any `css-path` selector, and any report still containing personal
data. The generated file records the report id and its SHA-256, so a committed
selector can always be traced to the capture that produced it.

`observed.generated.ts` ships **empty**, and that is the correct state: no
discovery report has been captured yet. An empty file says "ReadySupport has not
observed this interface", which is true. Filling it with plausible values would
be a guess wearing the costume of evidence.
