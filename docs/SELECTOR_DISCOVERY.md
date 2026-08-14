# Selector discovery

## Why you have to do this

ReadySupport ships knowing nothing about the Readymode interface. Not the
routes, not the field labels, not the button text, not what a success message
says. Every entry in the selector registry starts as `UNKNOWN`.

That is deliberate. Nobody who wrote this code has seen your Readymode admin
console, and a plausible-looking guess is worse than an honest refusal — a
`getByLabel('Email')` that happens to be wrong means a workflow confidently
typing into the wrong field on a form that changes real accounts.

So instead: a workflow declares which selector ids it needs, checks them before
it opens anything, and stops with `SELECTOR_NOT_CONFIGURED` if any are still
unmapped. Nothing is ever clicked on a guess.

Discovery is how you fill them in, and it takes about twenty minutes.

## What you will end up with

A file at `config/readymode-selectors.json`:

```json
{
  "routes": {
    "route.agents": { "path": "/admin/agents" }
  },
  "selectors": {
    "agents.search.input": { "strategy": "placeholder", "value": "Search agents" },
    "agents.results.row":  { "strategy": "css", "value": "table.agent-list tbody tr" }
  }
}
```

It is merged over the defaults at boot. Workflows read from the registry, so
re-mapping the interface after a Readymode update means editing this file — not
rewriting a workflow.

The file is gitignored. It describes your instance, and the screenshots
alongside it contain real account data.

## Running it

```bash
npm run discover
```

That opens a browser session bound to your Browserbase persistent context and
prints a live view URL. You drive it. Nothing is clicked for you and nothing is
changed.

Each time you land on a page ReadySupport needs, give it a name and press Enter.
It writes three files into `discovery/`:

| File | What it is |
| --- | --- |
| `NN-name.md` | Readable list of every candidate selector, split into "matches exactly one element" and "matches several" |
| `NN-name.json` | The same data, for scripting |
| `NN-name.png` | Screenshot |

It also prints the page's path, which is what a `routes` entry needs.

Useful flags:

```bash
npm run discover -- --list            # what each id should point at, and what is still missing
npm run discover -- --local           # a local browser instead of a Browserbase session
npm run discover -- --create-context  # mint a persistent context and exit
```

## The pages to visit

| Page | Fills in |
| --- | --- |
| Sign-in | `route.login`, `page.login.marker`, the two credential fields, the submit button, the error message |
| Dashboard (after signing in) | `route.dashboard`, `page.dashboard.marker` |
| Agent list | `route.agents`, `page.agents.marker`, the search box, the result row, the row cells, the open link |
| Agent list, search matching nothing | `agents.results.empty.marker` |
| One agent's page | `page.agentDetail.marker`, every `agent.detail.*` field, the clear-license / reset-password / deactivate controls |
| New agent form | `route.agentCreate`, `page.agentCreate.marker`, every `create.*` field |
| License view | `route.licenses`, `page.licenses.marker`, `licenses.row` and its cells |

Do all of them in one sitting. A partial map means some workflows run and others
refuse, which is more confusing than none of them running.

## Choosing values

The registry prefers strategies in this order, and so should you:

| Strategy | Use when | Durability |
| --- | --- | --- |
| `role` + `name` | The element has a real role and visible name | Survives a restyle |
| `label` | A form field with a proper `<label>` | Good |
| `placeholder` | A field with no label | Good |
| `text` | Banners, success messages, static markers | Fine for markers |
| `testid` | The application provides one | Best, if available |
| `css` | Nothing else works | Brittle — expect to redo it |

The discovery output splits candidates into ones matching exactly one element
and ones matching several. **For a single control, only ever use a
uniquely-matching candidate.** A selector matching two buttons is a selector
that will one day click the wrong one.

The exception is the row selectors — `agents.results.row` and `licenses.row` —
which are *supposed* to match many. Get these right: `agents.results.row` is how
search results are counted, and a miscount defeats the rule that a workflow acts
only when exactly one account matches.

## Markers

The `page.*.marker` entries answer "am I where I think I am?". A good one is
present on that page and nowhere else — a heading, a distinctive container.

A bad one is something in the site chrome, which appears everywhere and so
proves nothing. If the marker cannot tell two pages apart, a workflow that has
been redirected somewhere unexpected will carry on regardless.

## Fields you may leave unmapped

Some are genuinely optional and depend on your instance:

- `agents.search.submit` — leave it out if the list filters as you type
- `create.passwordConfirm.input` — only if the form has one
- `create.team.select`, `create.campaign.select`, `create.queue.select` — only
  if the form offers them
- `clearLicense.confirm.button`, `deactivate.confirm.button` — only if a dialog
  appears
- the `*.success.marker` entries — verification is stronger without them, since
  it falls back to re-reading the record

Everything else is required by at least one workflow, and that workflow will
refuse to run until it is mapped.

Note the interaction between optional form fields and requests: if someone asks
to create an account *with* a campaign and `create.campaign.select` is unmapped,
the workflow stops rather than creating the account without it. Silently
dropping a field somebody asked for would be worse.

## Checking your work

```bash
npm run discover -- --list
```

Prints coverage and lists what is still missing.

Then, still in `dry_run` mode, try a real request in Discord. The workflow will
sign in, navigate, find the account, check every precondition, and stop before
submitting — reporting what it would have done. That exercises every selector
except the final click, safely.

## When Readymode changes

You will find out one of two ways. A workflow stops with
`INTERFACE_CHANGED` — the page did not look right, and nothing was changed — or
an owner alert says the interface no longer matches.

Re-run discovery for the affected page, update the overlay, restart. No code
changes.
