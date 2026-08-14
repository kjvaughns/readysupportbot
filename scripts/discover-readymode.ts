import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type Page } from 'playwright-core';
import { loadEnv } from '../src/config/env.js';
import { coverage, DEFAULT_ROUTES, DEFAULT_SELECTORS } from '../src/readymode/selectors.js';

/**
 * Selector discovery.
 *
 * ReadySupport ships knowing nothing about how Readymode looks. Rather than
 * guessing at routes and field labels — which would mean workflows quietly
 * clicking the wrong things — every interface detail starts as UNKNOWN and is
 * captured here, against a real instance, by a person who can see the screen.
 *
 * How it works: it opens a browser you can drive, and each time you press
 * Enter it takes stock of whatever page you are on — every accessible role and
 * name, every form label, every placeholder and test id — and writes that to
 * `discovery/` along with a screenshot. You then copy the values you want into
 * `config/readymode-selectors.json`, and the workflows pick them up with no
 * code change.
 *
 *   npm run discover                open a Browserbase session (persists login)
 *   npm run discover -- --local     use the local Chromium instead
 *   npm run discover -- --create-context   mint a persistent context and exit
 *
 * The screenshots this writes can contain real agent data. `discovery/` is
 * gitignored; delete it when you are done.
 */

const OUTPUT_DIR = resolve(process.cwd(), 'discovery');

interface Candidate {
  strategy: string;
  value: string;
  name?: string;
  /** How many elements this would match. Only a count of 1 is safely usable. */
  matches: number;
  text?: string;
}

/**
 * Everything on the page that could serve as a selector.
 *
 * Ordered the way the registry prefers them: accessible roles and names first,
 * because those survive a restyle, and raw CSS last because it does not.
 */
async function inspect(page: Page): Promise<Candidate[]> {
  return page.evaluate(() => {
    const results: Array<{
      strategy: string;
      value: string;
      name?: string;
      matches: number;
      text?: string;
    }> = [];

    const clean = (value: string | null | undefined): string =>
      (value ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    // Roles and accessible names.
    const roleCounts = new Map<string, number>();
    const roleFor = (element: Element): string | null => {
      const explicit = element.getAttribute('role');
      if (explicit) return explicit;

      const tag = element.tagName.toLowerCase();
      const map: Record<string, string> = {
        button: 'button',
        a: 'link',
        h1: 'heading',
        h2: 'heading',
        h3: 'heading',
        table: 'table',
        tr: 'row',
        select: 'combobox',
        textarea: 'textbox',
        form: 'form',
        nav: 'navigation',
        main: 'main',
      };
      if (tag === 'input') {
        const type = (element as HTMLInputElement).type;
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'submit' || type === 'button') return 'button';
        return 'textbox';
      }
      return map[tag] ?? null;
    };

    for (const element of Array.from(document.querySelectorAll('*'))) {
      if (!visible(element)) continue;

      const role = roleFor(element);
      if (!role) continue;

      const name =
        clean(element.getAttribute('aria-label')) ||
        clean((element as HTMLElement).innerText) ||
        clean(element.getAttribute('title')) ||
        clean((element as HTMLInputElement).placeholder);

      const key = `${role}|${name}`;
      roleCounts.set(key, (roleCounts.get(key) ?? 0) + 1);
    }

    for (const [key, matches] of roleCounts) {
      const [role, name] = key.split('|');
      results.push({
        strategy: 'role',
        value: role ?? '',
        ...(name ? { name } : {}),
        matches,
      });
    }

    // Form labels.
    for (const label of Array.from(document.querySelectorAll('label'))) {
      const text = clean(label.innerText);
      if (!text) continue;
      results.push({ strategy: 'label', value: text, matches: 1 });
    }

    // Placeholders.
    for (const input of Array.from(document.querySelectorAll('[placeholder]'))) {
      const placeholder = clean(input.getAttribute('placeholder'));
      if (!placeholder) continue;
      results.push({ strategy: 'placeholder', value: placeholder, matches: 1 });
    }

    // Test ids, when the application provides them. These are the most
    // durable thing a page can offer.
    for (const attribute of ['data-testid', 'data-test-id', 'data-test']) {
      for (const element of Array.from(document.querySelectorAll(`[${attribute}]`))) {
        const value = clean(element.getAttribute(attribute));
        if (!value) continue;
        results.push({
          strategy: 'testid',
          value,
          matches: document.querySelectorAll(`[${attribute}="${value}"]`).length,
        });
      }
    }

    // Table shapes, for the row selectors the list workflows need.
    for (const table of Array.from(document.querySelectorAll('table'))) {
      const rows = table.querySelectorAll('tbody tr');
      if (rows.length === 0) continue;

      const headers = Array.from(table.querySelectorAll('thead th')).map((header) =>
        clean((header as HTMLElement).innerText),
      );

      results.push({
        strategy: 'css',
        value: 'table tbody tr',
        matches: rows.length,
        text: `columns: ${headers.join(' | ')}`,
      });
    }

    return results;
  });
}

async function openBrowser(local: boolean): Promise<{ browser: Browser; page: Page; liveUrl?: string }> {
  const env = loadEnv();

  if (local) {
    const browser = await chromium.launch({
      headless: false,
      executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] ?? undefined,
    });
    const page = await browser.newPage();
    return { browser, page };
  }

  const client = new Browserbase({ apiKey: env.BROWSERBASE_API_KEY });
  const session = await client.sessions.create({
    projectId: env.BROWSERBASE_PROJECT_ID,
    browserSettings: { context: { id: env.BROWSERBASE_CONTEXT_ID, persist: true } },
    keepAlive: true,
  });

  const connectUrl = (session as { connectUrl?: string }).connectUrl;
  if (!connectUrl) throw new Error('Browserbase did not return a connection URL');

  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  let liveUrl: string | undefined;
  try {
    const debug = await client.sessions.debug((session as { id: string }).id);
    liveUrl = (debug as { debuggerFullscreenUrl?: string }).debuggerFullscreenUrl;
  } catch {
    // Live view is a convenience, not a requirement.
  }

  return { browser, page, ...(liveUrl ? { liveUrl } : {}) };
}

async function createContextAndExit(): Promise<void> {
  const env = loadEnv();
  const client = new Browserbase({ apiKey: env.BROWSERBASE_API_KEY });
  const context = await client.contexts.create({ projectId: env.BROWSERBASE_PROJECT_ID });

  process.stdout.write(
    `Created a Browserbase context.\n\n  BROWSERBASE_CONTEXT_ID=${(context as { id: string }).id}\n\n` +
      'Put that in your environment. Signing in once inside this context is what lets\n' +
      'ReadySupport reuse the session instead of logging in on every job.\n',
  );
}

function report(candidates: Candidate[], label: string): string {
  const usable = candidates.filter((candidate) => candidate.matches === 1);
  const ambiguous = candidates.filter((candidate) => candidate.matches > 1);

  const lines = [
    `# ${label}`,
    '',
    `${usable.length} uniquely-matching candidates, ${ambiguous.length} that match more than one element.`,
    '',
    '## Safe to use (exactly one match)',
    '',
    ...usable.map(
      (candidate) =>
        `- strategy: ${candidate.strategy}, value: ${JSON.stringify(candidate.value)}` +
        (candidate.name ? `, name: ${JSON.stringify(candidate.name)}` : ''),
    ),
    '',
    '## Matches several elements (use for row selectors, not for single controls)',
    '',
    ...ambiguous.map(
      (candidate) =>
        `- strategy: ${candidate.strategy}, value: ${JSON.stringify(candidate.value)}` +
        (candidate.name ? `, name: ${JSON.stringify(candidate.name)}` : '') +
        ` — ${candidate.matches} matches` +
        (candidate.text ? ` (${candidate.text})` : ''),
    ),
  ];

  return lines.join('\n');
}

function printUnmapped(): void {
  const map = coverage();
  process.stdout.write(
    `\n${map.configured} of ${map.total} interface details are mapped.\n` +
      (map.missing.length > 0
        ? `Still needed:\n${map.missing.map((id) => `  - ${id}`).join('\n')}\n`
        : 'Everything is mapped.\n'),
  );
}

function printRegistryReference(): void {
  process.stdout.write('\nWhat each id should point at:\n\n');

  for (const [id, spec] of Object.entries(DEFAULT_ROUTES)) {
    process.stdout.write(`  ${id}\n      ${spec.description}\n`);
  }
  for (const [id, spec] of Object.entries(DEFAULT_SELECTORS)) {
    process.stdout.write(`  ${id}\n      ${spec.description}\n`);
  }
}

async function main(): Promise<void> {
  const local = process.argv.includes('--local');

  if (process.argv.includes('--create-context')) {
    await createContextAndExit();
    return;
  }

  if (process.argv.includes('--list')) {
    printRegistryReference();
    printUnmapped();
    return;
  }

  const env = loadEnv();
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const { browser, page, liveUrl } = await openBrowser(local);

  process.stdout.write(
    '\nReadymode selector discovery\n' +
      '============================\n\n' +
      (liveUrl
        ? `Drive the browser here:\n  ${liveUrl}\n\n`
        : 'A browser window has opened. Drive it there.\n\n') +
      'Sign in if you are asked to, then navigate to each page ReadySupport needs and\n' +
      'press Enter here to capture it. Nothing is clicked for you and nothing is changed.\n\n' +
      'Type `quit` to finish.\n',
  );

  printUnmapped();

  await page.goto(env.READYMODE_LOGIN_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let captureCount = 0;

  try {
    for (;;) {
      const label = await rl.question(
        '\nName this page (e.g. agents-list, agent-detail, create-form), or `quit`: ',
      );

      if (label.trim().toLowerCase() === 'quit') break;
      if (!label.trim()) continue;

      const safeLabel = label.trim().replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      captureCount += 1;

      const url = page.url();
      const candidates = await inspect(page);

      const base = resolve(OUTPUT_DIR, `${String(captureCount).padStart(2, '0')}-${safeLabel}`);

      writeFileSync(`${base}.md`, `${report(candidates, safeLabel)}\n\nCaptured from: ${url}\n`, 'utf8');
      writeFileSync(
        `${base}.json`,
        JSON.stringify({ label: safeLabel, url, path: new URL(url).pathname, candidates }, null, 2),
        'utf8',
      );
      await page.screenshot({ path: `${base}.png`, fullPage: true });

      process.stdout.write(
        `\nCaptured ${candidates.length} candidates from ${url}\n` +
          `  ${base}.md    readable list\n` +
          `  ${base}.json  the same data, for scripting\n` +
          `  ${base}.png   screenshot\n` +
          `\nThe path for a route entry is: ${new URL(url).pathname}\n`,
      );
    }
  } finally {
    rl.close();
    await browser.close().catch(() => undefined);
  }

  process.stdout.write(
    `\nDone. ${captureCount} page(s) captured in ${OUTPUT_DIR}.\n\n` +
      'Next: copy the values you want into config/readymode-selectors.json, in this shape:\n\n' +
      '  {\n' +
      '    "routes":    { "route.agents": { "path": "/admin/agents" } },\n' +
      '    "selectors": { "agents.search.input": { "strategy": "placeholder", "value": "Search agents" } }\n' +
      '  }\n\n' +
      'Then run `npm run discover -- --list` to see what is still missing.\n' +
      'These captures contain real account data — delete the folder when you are finished.\n',
  );
}

main().catch((cause) => {
  process.stderr.write(`Discovery failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exit(1);
});
