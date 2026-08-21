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
  checkAuthentication,
  waitForAuthenticated,
  waitForLoginOutcome,
  type LoginOutcome,
} from './authState';
import { classifyInterstitial } from './interstitial';
import { captureInterstitial } from './takeover';
import {
  HUMAN_VERIFICATION_CONDITIONS,
  LOGIN_CONTROLS,
  LOGIN_FAILURE_CONDITIONS,
} from './selectors';
import { anyPresent, discover } from './selectors/discovery';
import { handleInterstitial } from './takeover';
import { bindProfile, loadProfile } from './selectors/resolve';

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
/**
 * What happened while signing in, for the discovery report.
 *
 * `ensureAuthenticated` returns void because every caller only needs to know it
 * did not throw. Discovery needs more: which stages actually happened, and in
 * particular whether the administrator session notice appeared and was
 * continued past. This carries that back without changing what a failure means.
 */
export interface AuthenticationTrace {
  /** True when a login form was filled, as opposed to a session already open. */
  submittedCredentials: boolean;
  /** True when the administrator session notice appeared and Continue was pressed. */
  continuedPastSessionNotice: boolean;
  /** True when the dashboard was confirmed after that click. */
  dashboardVerifiedAfterContinue: boolean;
  /** Which authenticated marker proved the session, if one did. */
  authenticatedMarker: string | null;
  /** The address after the login form was submitted. Diagnostic only. */
  urlAfterSubmit: string | null;
  /** The address after Continue was pressed. Diagnostic only. */
  urlAfterContinue: string | null;
  /** How the login attempt ended. */
  outcome: LoginOutcome | null;
}

const authenticationTraces = new WeakMap<ReadymodeSession, AuthenticationTrace>();

/** The trace from the most recent `ensureAuthenticated` for this session. */
export function lastAuthenticationTrace(session: ReadymodeSession): AuthenticationTrace {
  return (
    authenticationTraces.get(session) ?? {
      submittedCredentials: false,
      continuedPastSessionNotice: false,
      dashboardVerifiedAfterContinue: false,
      authenticatedMarker: null,
      urlAfterSubmit: null,
      urlAfterContinue: null,
      outcome: null,
    }
  );
}

export async function ensureAuthenticated(session: ReadymodeSession): Promise<void> {
  const trace: AuthenticationTrace = {
    submittedCredentials: false,
    continuedPastSessionNotice: false,
    dashboardVerifiedAfterContinue: false,
    authenticatedMarker: null,
    urlAfterSubmit: null,
    urlAfterContinue: null,
    outcome: null,
  };
  authenticationTraces.set(session, trace);

  const credentials = await resolveCredentials(session.organizationId);
  const { page } = session;

  const expectedHost = hostOf(credentials.loginUrl);

  await page.goto(credentials.loginUrl, { waitUntil: 'domcontentloaded' });

  // Already signed in? Only when a real authenticated marker is on screen AND
  // no password field is. The old check matched a nav element, which the login
  // page has, so it returned here without ever entering the credentials.
  const existing = await checkAuthentication(page, 1500);
  if (existing.authenticated) {
    trace.authenticatedMarker = existing.marker;
    trace.outcome = 'authenticated';
    return;
  }

  if (await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 1000)) {
    await markAuthenticationRequired(session.organizationId, 'Human verification appeared at login.');
    throw new AuthenticationRequiredError();
  }

  // A persistent context can land straight on the administrator session notice
  // without ever showing a login form.
  const before = await handleInterstitial(session, expectedHost);
  trace.continuedPastSessionNotice = trace.continuedPastSessionNotice || before.clicked;
  trace.dashboardVerifiedAfterContinue =
    trace.dashboardVerifiedAfterContinue || before.dashboardVerified;
  if (before.clicked && before.dashboardVerified) {
    await markConnected(session.organizationId, credentials.loginUrl, credentials.username);
    return;
  }

  const usernameField = await discover(page, LOGIN_CONTROLS.username);
  const passwordField = await discover(page, LOGIN_CONTROLS.password);
  const submit = await discover(page, LOGIN_CONTROLS.submit);

  await usernameField.fill(credentials.username);
  // The password is written straight into the field and never held elsewhere.
  await passwordField.fill(credentials.password);
  await submit.click();
  trace.submittedCredentials = true;

  await recordEvent({
    organizationId: session.organizationId,
    type: 'readymode.credentials_submitted',
    message: 'The Readymode login form was submitted.',
  });

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  trace.urlAfterSubmit = page.url();

  // One of five outcomes, all named. A login that neither succeeded nor
  // visibly failed is a real state, and treating it as success is how a run
  // ends up crawling a login page.
  const outcome = await waitForLoginOutcome(page, {
    humanVerification: () => anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 400),
    sessionWarning: async () => {
      const snapshot = await captureInterstitial(page);
      return classifyInterstitial(snapshot).classification === 'admin_session_takeover';
    },
    limitedAdminMode: async () => {
      const snapshot = await captureInterstitial(page);
      return classifyInterstitial(snapshot).classification === 'limited_admin_mode';
    },
    loginError: () => anyPresent(page, LOGIN_FAILURE_CONDITIONS, 400),
  });

  trace.outcome = outcome.outcome;
  trace.authenticatedMarker = outcome.marker;

  if (outcome.outcome === 'human_verification') {
    await markAuthenticationRequired(
      session.organizationId,
      'Readymode asked for human verification after the password was submitted.',
    );
    throw new AuthenticationRequiredError();
  }

  // The one notice ReadySupport may continue past: another administrator's
  // session being replaced. Everything else is reported, never clicked.
  const after = await handleInterstitial(session, expectedHost);
  trace.continuedPastSessionNotice = trace.continuedPastSessionNotice || after.clicked;
  if (after.clicked) trace.urlAfterContinue = page.url();
  trace.dashboardVerifiedAfterContinue =
    trace.dashboardVerifiedAfterContinue || after.dashboardVerified;

  if (after.clicked && !after.dashboardVerified) {
    throw new AppError(
      'readymode_login_uncertain',
      'ReadySupport continued past the administrator session notice but could not confirm the dashboard, so it stopped without making changes.',
      503,
    );
  }

  const confirmed = await waitForAuthenticated(page, 15_000);
  if (confirmed.authenticated) {
    trace.authenticatedMarker = confirmed.marker;
    trace.outcome = 'authenticated';

    await recordEvent({
      organizationId: session.organizationId,
      type: 'readymode.authenticated_dashboard_confirmed',
      message: `The authenticated interface was confirmed by the ${confirmed.marker}.`,
      data: { marker: confirmed.marker },
    });
    await markConnected(session.organizationId, credentials.loginUrl, credentials.username);
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

  // A recognized notice explains the failure far better than a generic message.
  if (after.classification !== 'unknown') {
    await markAuthenticationRequired(session.organizationId, after.explanation);
    throw new AuthenticationRequiredError(after.explanation);
  }

  throw new AppError(
    'readymode_login_uncertain',
    'ReadySupport could not confirm that the Readymode login succeeded, so it stopped without making changes.',
    503,
  );
}

/** The host a notice must be on before ReadySupport will act on it. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

async function markConnected(
  organizationId: string,
  loginUrl: string,
  username: string,
): Promise<void> {
  await getStore().upsertConnection({
    organizationId,
    loginUrl,
    username,
    status: 'connected',
    lastVerifiedAt: new Date().toISOString(),
    lastError: null,
  });
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
    // Selectors that came from an approved discovery profile take precedence
    // over the built-in guesses for everything this session does, login included.
    bindProfile(session.page, await loadProfile(organizationId));
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
