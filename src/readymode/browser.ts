import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright-core';
import { env } from '../config/env.js';
import { errorFor } from '../domain/errors.js';
import * as browserSessions from '../db/repositories/browserSessions.js';
import { moduleLogger } from '../util/logger.js';
import { getSelector, UNKNOWN, type SelectorSpec } from './selectors.js';

/**
 * Browser plumbing: opening a Browserbase session against the persistent
 * context, connecting Playwright to it, and turning selector specs into
 * locators.
 *
 * The persistent context is what makes this workable at all. Readymode
 * cookies and local storage live in Browserbase rather than here, so the bot
 * signs in rarely, the credentials sit in environment variables that are only
 * read when a sign-in is actually needed, and nothing authentication-shaped is
 * ever written to the database.
 */

const log = moduleLogger('browser');

export interface ReadymodeSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Browserbase's id for this session. */
  sessionId: string | null;
  /** The browser_sessions row tracking it. */
  recordId: string;
  close(status?: 'CLOSED' | 'FAILED'): Promise<void>;
}

let client: Browserbase | undefined;

function browserbase(): Browserbase {
  client ??= new Browserbase({ apiKey: env().BROWSERBASE_API_KEY });
  return client;
}

/** Test helper. */
export function setBrowserbaseClient(replacement: Browserbase | undefined): void {
  client = replacement;
}

interface CreatedSession {
  id: string | null;
  connectUrl: string;
}

/**
 * Ask Browserbase for a session bound to the persistent context.
 *
 * `persist: true` is the part that matters: without it the context is read at
 * the start and thrown away at the end, and every job would have to sign in
 * again.
 */
async function createRemoteSession(): Promise<CreatedSession> {
  const config = env();

  try {
    const session = await browserbase().sessions.create({
      projectId: config.BROWSERBASE_PROJECT_ID,
      browserSettings: {
        context: { id: config.BROWSERBASE_CONTEXT_ID, persist: true },
      },
      keepAlive: false,
    });

    const connectUrl = (session as { connectUrl?: string }).connectUrl;
    if (!connectUrl) {
      throw new Error('Browserbase did not return a connection URL for the session');
    }

    return { id: (session as { id?: string }).id ?? null, connectUrl };
  } catch (cause) {
    throw errorFor('UPSTREAM_UNAVAILABLE', {
      message: 'I could not open a browser session, so I stopped without changing anything.',
      cause,
      details: { stage: 'browserbase.sessions.create' },
    });
  }
}

/**
 * Open a session and return the first page.
 *
 * Connecting over CDP attaches to the browser Browserbase already started, so
 * the existing context — and with it the Readymode cookies — comes with it.
 */
export async function openSession(options: { requestId?: string } = {}): Promise<ReadymodeSession> {
  const config = env();
  const remote = await createRemoteSession();

  const record = await browserSessions.open({
    browserbaseSessionId: remote.id,
    contextId: config.BROWSERBASE_CONTEXT_ID,
    ...(options.requestId ? { requestId: options.requestId } : {}),
  });

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(remote.connectUrl);
  } catch (cause) {
    await browserSessions.close(record.id, 'FAILED', {
      category: 'UPSTREAM_UNAVAILABLE',
      message: 'Could not connect to the browser session.',
    });
    throw errorFor('UPSTREAM_UNAVAILABLE', {
      message: 'I could not connect to the browser, so I stopped without changing anything.',
      cause,
      details: { stage: 'chromium.connectOverCDP' },
    });
  }

  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());

  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(45_000);

  log.info({ sessionId: remote.id, recordId: record.id }, 'Opened a Readymode browser session');

  return {
    browser,
    context,
    page,
    sessionId: remote.id,
    recordId: record.id,
    async close(status: 'CLOSED' | 'FAILED' = 'CLOSED') {
      try {
        // Closing the context is what tells Browserbase to persist it. The
        // browser itself is detached rather than killed.
        await browser.close();
      } catch (cause) {
        log.warn({ err: cause }, 'Could not close the browser cleanly');
      }
      await browserSessions.close(record.id, status);
    },
  };
}

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

type Scope = Page | Frame | Locator;

/**
 * Turn a selector spec into a Playwright locator.
 *
 * Accessible strategies come first in the registry for a reason: a locator
 * built from a role and a visible name survives a restyle, where a CSS path
 * does not. `css` exists because some tables have no accessible structure at
 * all, but every use of it is a place the interface can shift underneath us.
 */
export function toLocator(scope: Scope, spec: SelectorSpec): Locator {
  if (spec.value === UNKNOWN) {
    throw errorFor('SELECTOR_NOT_CONFIGURED', {
      details: { selector: spec.id, description: spec.description },
    });
  }

  const exact = spec.exact ?? false;

  switch (spec.strategy) {
    case 'role':
      return scope.getByRole(spec.value as Parameters<Scope['getByRole']>[0], {
        ...(spec.name ? { name: spec.name, exact } : {}),
      });
    case 'label':
      return scope.getByLabel(spec.value, { exact });
    case 'placeholder':
      return scope.getByPlaceholder(spec.value, { exact });
    case 'text':
      return scope.getByText(spec.value, { exact });
    case 'testid':
      return scope.getByTestId(spec.value);
    case 'css':
      return scope.locator(spec.value);
  }
}

/** Resolve by id. The usual entry point for workflows. */
export function locate(scope: Scope, selectorId: string): Locator {
  return toLocator(scope, getSelector(selectorId));
}

/** True when the element appears within the timeout. Never throws. */
export async function isVisible(scope: Scope, selectorId: string, timeoutMs = 3_000): Promise<boolean> {
  try {
    await locate(scope, selectorId).first().waitFor({ state: 'visible', timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/**
 * The same, for a selector that may not be mapped. Used for optional markers
 * — a confirmation dialog that some instances show and others do not.
 */
export async function isVisibleIfConfigured(
  scope: Scope,
  selectorId: string,
  timeoutMs = 3_000,
): Promise<boolean> {
  const spec = getSelector(selectorId);
  if (spec.value === UNKNOWN) return false;
  return isVisible(scope, selectorId, timeoutMs);
}

/**
 * Assert the page is what the workflow expects before it acts.
 *
 * This is the check that turns "the interface changed" from a wrong click into
 * a clean stop.
 */
export async function confirmPage(
  page: Page,
  markerSelectorId: string,
  pageDescription: string,
  timeoutMs = 10_000,
): Promise<void> {
  const present = await isVisible(page, markerSelectorId, timeoutMs);
  if (present) return;

  throw errorFor('INTERFACE_CHANGED', {
    message: `I expected to be on ${pageDescription} but the page did not look right, so I stopped without changing anything.`,
    details: { marker: markerSelectorId, url: page.url() },
  });
}

/** Read an element's trimmed text, or undefined when it is not there. */
export async function readText(
  scope: Scope,
  selectorId: string,
  timeoutMs = 3_000,
): Promise<string | undefined> {
  const spec = getSelector(selectorId);
  if (spec.value === UNKNOWN) return undefined;

  try {
    const text = await toLocator(scope, spec).first().innerText({ timeout: timeoutMs });
    return text.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Navigate to a mapped route relative to the Readymode origin. */
export async function goToRoute(page: Page, path: string): Promise<void> {
  const origin = new URL(env().READYMODE_LOGIN_URL).origin;
  const target = new URL(path, origin).toString();

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  } catch (cause) {
    throw errorFor('TIMEOUT', {
      message: 'Readymode did not load in time, so I stopped without changing anything.',
      cause,
      details: { url: target },
    });
  }
}
