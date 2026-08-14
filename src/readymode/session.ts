import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Browserbase from '@browserbasehq/sdk';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config, env } from '../config';
import { logger } from '../security/logger';
import {
  AuthenticationRequiredError,
  AppError,
  DependencyNotConfiguredError,
} from '../security/errors';
import { recordEvent } from '../audit';
import { getStore } from '../database';
import { resolveCredentials } from './credentials';
import {
  HUMAN_VERIFICATION_CONDITIONS,
  LOGIN_CONTROLS,
  LOGIN_FAILURE_CONDITIONS,
  LOGIN_SUCCESS_CONDITIONS,
} from './selectors';
import { anyPresent, discover } from './selectors/discovery';

/**
 * Readymode browser session management.
 *
 * Sessions run on Browserbase persistent contexts so a signed-in session can be
 * reused across requests, with a local Chromium fallback for self-hosted runs.
 * CAPTCHA and multi-factor prompts are never bypassed: when one appears the
 * session stops, the queue lane pauses, and an Owner is asked to reconnect.
 */

const SCREENSHOT_DIR = process.env.READYSUPPORT_ARTIFACT_DIR ?? join(process.cwd(), 'artifacts');

export function isBrowserbaseConfigured(): boolean {
  return Boolean(env.BROWSERBASE_API_KEY && env.BROWSERBASE_PROJECT_ID);
}

let browserbaseClient: Browserbase | null = null;

function client(): Browserbase {
  if (!isBrowserbaseConfigured()) throw new DependencyNotConfiguredError('Browserbase');
  if (!browserbaseClient) browserbaseClient = new Browserbase({ apiKey: env.BROWSERBASE_API_KEY! });
  return browserbaseClient;
}

export interface ReadymodeSession {
  page: Page;
  context: BrowserContext;
  browser: Browser;
  provider: 'browserbase' | 'local';
  sessionId?: string;
  organizationId: string;
  close(): Promise<void>;
}

async function openBrowserbaseSession(organizationId: string): Promise<ReadymodeSession> {
  const bb = client();
  const created = await bb.sessions.create({
    projectId: env.BROWSERBASE_PROJECT_ID!,
    // A persistent context keeps the Readymode login alive between requests.
    ...(env.BROWSERBASE_CONTEXT_ID
      ? { browserSettings: { context: { id: env.BROWSERBASE_CONTEXT_ID, persist: true } } }
      : {}),
    keepAlive: false,
  });

  const browser = await chromium.connectOverCDP(created.connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(30_000);

  await recordEvent({
    organizationId,
    type: 'browser.session_started',
    message: 'Browserbase session started.',
    data: { sessionId: created.id },
  });

  return {
    page,
    context,
    browser,
    provider: 'browserbase',
    sessionId: created.id,
    organizationId,
    close: async () => {
      await browser.close().catch(() => undefined);
      await recordEvent({
        organizationId,
        type: 'browser.session_ended',
        message: 'Browserbase session ended.',
        data: { sessionId: created.id },
      });
    },
  };
}

async function openLocalSession(organizationId: string): Promise<ReadymodeSession> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  return {
    page,
    context,
    browser,
    provider: 'local',
    organizationId,
    close: async () => {
      await browser.close().catch(() => undefined);
    },
  };
}

/** Opens a browser session. Browserbase when configured, local otherwise. */
export async function openSession(organizationId: string): Promise<ReadymodeSession> {
  if (isBrowserbaseConfigured()) return openBrowserbaseSession(organizationId);
  logger.warn('Browserbase is not configured; falling back to a local browser.');
  return openLocalSession(organizationId);
}

/**
 * Signs in if the persistent context is not already authenticated.
 *
 * A CAPTCHA or multi-factor prompt is reported, never solved.
 */
export async function ensureAuthenticated(session: ReadymodeSession): Promise<void> {
  const credentials = await resolveCredentials(session.organizationId);
  const { page } = session;

  await page.goto(credentials.loginUrl, { waitUntil: 'domcontentloaded' });

  if (await anyPresent(page, LOGIN_SUCCESS_CONDITIONS, 1500)) return;

  if (await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 1000)) {
    await markAuthenticationRequired(session.organizationId, 'Human verification appeared at login.');
    throw new AuthenticationRequiredError();
  }

  const usernameField = await discover(page, LOGIN_CONTROLS.username);
  const passwordField = await discover(page, LOGIN_CONTROLS.password);
  const submit = await discover(page, LOGIN_CONTROLS.submit);

  await usernameField.fill(credentials.username);
  // The password is written straight into the field and never held elsewhere.
  await passwordField.fill(credentials.password);
  await submit.click();

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  if (await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 2000)) {
    await markAuthenticationRequired(
      session.organizationId,
      'Readymode asked for human verification after the password was submitted.',
    );
    throw new AuthenticationRequiredError();
  }

  if (await anyPresent(page, LOGIN_SUCCESS_CONDITIONS, 5000)) {
    await getStore().upsertConnection({
      organizationId: session.organizationId,
      loginUrl: credentials.loginUrl,
      username: credentials.username,
      status: 'connected',
      lastVerifiedAt: new Date().toISOString(),
      lastError: null,
    });
    return;
  }

  if (await anyPresent(page, LOGIN_FAILURE_CONDITIONS, 1000)) {
    await getStore().upsertConnection({
      organizationId: session.organizationId,
      loginUrl: credentials.loginUrl,
      username: credentials.username,
      status: 'authentication_required',
      lastVerifiedAt: null,
      lastError: 'Readymode rejected the stored credentials.',
    });
    throw new AuthenticationRequiredError(
      'Readymode rejected the stored credentials. Reconnect from the ReadySupport dashboard.',
    );
  }

  throw new AppError(
    'readymode_login_uncertain',
    'ReadySupport could not confirm that the Readymode login succeeded, so it stopped without making changes.',
    503,
  );
}

async function markAuthenticationRequired(organizationId: string, reason: string): Promise<void> {
  const store = getStore();
  const existing = await store.getConnection(organizationId);
  await store.upsertConnection({
    organizationId,
    loginUrl: existing?.loginUrl ?? '',
    username: existing?.username ?? '',
    status: 'authentication_required',
    lastVerifiedAt: existing?.lastVerifiedAt ?? null,
    lastError: reason,
  });
  await recordEvent({
    organizationId,
    type: 'request.authentication_required',
    message: reason,
  });
}

/** Captures evidence for the audit trail. Returns the stored path. */
export async function captureScreenshot(
  page: Page,
  label: string,
): Promise<string | null> {
  try {
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60);
    const path = join(SCREENSHOT_DIR, `${Date.now()}-${safeLabel}.png`);
    const buffer = await page.screenshot({ fullPage: false });
    await writeFile(path, buffer);
    return path;
  } catch (error) {
    logger.warn({ err: error }, 'Screenshot capture failed');
    return null;
  }
}

/** Runs a function with an authenticated session and always closes it. */
export async function withSession<T>(
  organizationId: string,
  handler: (session: ReadymodeSession) => Promise<T>,
): Promise<T> {
  const session = await openSession(organizationId);
  try {
    await ensureAuthenticated(session);
    return await handler(session);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** Whether live browser work can run at all right now. */
export async function browserAvailability(organizationId?: string): Promise<{
  ok: boolean;
  detail?: string;
}> {
  if (!isBrowserbaseConfigured()) {
    return { ok: false, detail: 'BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID are not set.' };
  }
  if (organizationId) {
    const connection = await getStore().getConnection(organizationId);
    if (connection?.status === 'authentication_required') {
      return { ok: false, detail: 'Readymode requires reconnection.' };
    }
  }
  return { ok: true };
}

/** Live check used by /ready. */
export async function checkBrowserbase(): Promise<{ ok: boolean; detail?: string }> {
  if (!isBrowserbaseConfigured()) {
    return { ok: false, detail: 'BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID are not set.' };
  }
  try {
    await client().sessions.list({ status: 'RUNNING' } as never);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Unavailable.' };
  }
}

export const dryRunEnabled = () => config.dryRun;
