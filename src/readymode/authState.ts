import type { Page } from 'playwright-core';
import { SelectorStrategy } from './selectors';
import { countVisible, locatorFor } from './selectors/discovery';
import { listSearchRoots } from './selectors/frames';
import type { ReadymodeSession } from './session';

/**
 * Deciding whether the session is actually signed in.
 *
 * This exists because of a specific failure. The old signal set included
 * `role=navigation` and the text /log ?out|sign ?out/ — and Readymode's login
 * page satisfies both. So `ensureAuthenticated` opened the login page, matched
 * "navigation", concluded the session was already signed in, and returned
 * without ever entering the credentials. Every administrative route then
 * redirected straight back to login, and discovery captured the same login page
 * twelve times while reporting that it had crawled the interface.
 *
 * Two rules follow from that.
 *
 * A page showing a password field is never authenticated, whatever else is on
 * it. That single check would have caught the whole failure, and it costs
 * nothing.
 *
 * And an authenticated marker has to be something only the signed-in shell has.
 * The ones below are real element ids recorded by the read-only inspection, not
 * generic roles that any page might satisfy.
 */

/** A visible password field means the login form, whatever else is on screen. */
export const LOGIN_FORM_CONDITIONS: SelectorStrategy[] = [
  { type: 'css', value: 'input[type="password"]' },
];

export interface AuthenticatedMarker {
  name: string;
  strategy: SelectorStrategy;
}

/**
 * Markers only the signed-in shell has.
 *
 * The first three are element ids the inspection recorded on the authenticated
 * hotbar. The rest are the navigation destinations and headings that only exist
 * once signed in.
 */
export const AUTHENTICATED_MARKERS: AuthenticatedMarker[] = [
  { name: 'hotbar search', strategy: { type: 'css', value: '#hotbar_search' } },
  { name: 'session state selector', strategy: { type: 'css', value: '#CCS_Session_Statebox' } },
  { name: 'hotbar sign out', strategy: { type: 'css', value: '#hotbar_logout' } },
  { name: 'User Management navigation', strategy: { type: 'text', value: 'User Management', exact: true } },
  { name: 'Lead Management navigation', strategy: { type: 'text', value: 'Lead Management', exact: true } },
  { name: 'License Usage navigation', strategy: { type: 'text', value: 'License Usage', exact: true } },
  { name: 'Dashboard heading', strategy: { type: 'text', value: 'Dashboard', exact: true } },
  { name: 'Settings navigation', strategy: { type: 'text', value: 'Settings', exact: true } },
  { name: 'administrator container', strategy: { type: 'css', value: '[data-admin], #admin, .admin-container' } },
];

export interface AuthenticationCheck {
  authenticated: boolean;
  /** Which marker proved it, so a report can say how it knows. */
  marker: string | null;
  /** True when a password field is visible anywhere, in any frame. */
  loginFormPresent: boolean;
  /** The address at the moment of the check. Never used as proof on its own. */
  url: string;
}

/**
 * Whether the session is signed in right now.
 *
 * The URL is recorded and never trusted: a legacy shell answers 200 at any
 * address, and a redirect back to login keeps whichever URL was asked for long
 * enough to fool anything reading it.
 */
export async function checkAuthentication(
  page: Page,
  timeoutMs = 1200,
): Promise<AuthenticationCheck> {
  const url = page.url();
  const roots = listSearchRoots(page);

  /**
   * Per-probe waits, capped hard.
   *
   * There are nine authenticated markers and at most one of them is present, so
   * a generous per-probe wait is paid eight times over for nothing: at 1200ms
   * each, a single "are we signed in?" check cost eleven seconds. The markers
   * are either rendered or not by the time this runs, so they get a short wait;
   * the login form gets a little longer because it is the decisive one.
   *
   * A caller that wants to *wait* for a state polls with `waitForAuthenticated`
   * rather than lengthening these.
   */
  const formProbe = Math.min(timeoutMs, 1000);
  const markerProbe = Math.min(timeoutMs, 300);

  let loginFormPresent = false;
  for (const condition of LOGIN_FORM_CONDITIONS) {
    for (const root of roots) {
      try {
        if ((await countVisible(locatorFor(root, condition), formProbe)) > 0) {
          loginFormPresent = true;
          break;
        }
      } catch {
        // A root that cannot be queried says nothing either way.
      }
    }
    if (loginFormPresent) break;
  }

  // Decisive on its own. A screen asking for a password is not a screen behind
  // one, however many navigation-shaped elements it also carries.
  if (loginFormPresent) {
    return { authenticated: false, marker: null, loginFormPresent: true, url };
  }

  for (const marker of AUTHENTICATED_MARKERS) {
    for (const root of roots) {
      try {
        if ((await countVisible(locatorFor(root, marker.strategy), markerProbe)) > 0) {
          return { authenticated: true, marker: marker.name, loginFormPresent: false, url };
        }
      } catch {
        // Try the next root.
      }
    }
  }

  return { authenticated: false, marker: null, loginFormPresent: false, url };
}

/**
 * Waits until the session is authenticated, or the time runs out.
 *
 * Polls rather than waiting once with a long timeout: each probe asks about an
 * element that is usually absent, and a single long wait would be spent proving
 * absence instead of noticing the moment the shell appears.
 */
export async function waitForAuthenticated(
  page: Page,
  timeoutMs = 30_000,
): Promise<AuthenticationCheck> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const check = await checkAuthentication(page, 600);
    if (check.authenticated) return check;
    if (Date.now() >= deadline) return check;
    await page.waitForTimeout(500).catch(() => undefined);
  }
}

/**
 * Waits for one of the outcomes a submitted login can have.
 *
 * Naming them all is what stops the wait ending on whichever happens to be
 * checked first. `timeout` is an outcome too — a login that neither succeeded
 * nor visibly failed is a real state, and calling it success is how a run ends
 * up crawling a login page.
 */
export type LoginOutcome =
  | 'authenticated'
  | 'multiple_session_warning'
  | 'limited_admin_mode'
  | 'login_error'
  | 'human_verification'
  | 'timeout';

export interface LoginOutcomeResult {
  outcome: LoginOutcome;
  marker: string | null;
  url: string;
}

export async function waitForLoginOutcome(
  page: Page,
  probes: {
    sessionWarning: () => Promise<boolean>;
    humanVerification: () => Promise<boolean>;
    loginError: () => Promise<boolean>;
    limitedAdminMode: () => Promise<boolean>;
  },
  timeoutMs = 20_000,
): Promise<LoginOutcomeResult> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    // Human verification is checked first and always: a page carrying both a
    // captcha and a Continue button is a captcha, never a session takeover.
    if (await probes.humanVerification()) {
      return { outcome: 'human_verification', marker: null, url: page.url() };
    }

    const check = await checkAuthentication(page, 400);
    if (check.authenticated) {
      return { outcome: 'authenticated', marker: check.marker, url: check.url };
    }

    if (await probes.sessionWarning()) {
      return { outcome: 'multiple_session_warning', marker: null, url: page.url() };
    }

    if (await probes.limitedAdminMode()) {
      return { outcome: 'limited_admin_mode', marker: 'License Usage', url: page.url() };
    }

    if (await probes.loginError()) {
      return { outcome: 'login_error', marker: null, url: page.url() };
    }

    if (Date.now() >= deadline) {
      return { outcome: 'timeout', marker: null, url: page.url() };
    }

    await page.waitForTimeout(400).catch(() => undefined);
  }
}

/**
 * Safe diagnostics about the browser session.
 *
 * Enough to prove that login and crawling happened in the same place, and to
 * see whether a session cookie survived — with nothing sensitive recorded. The
 * cookie jar is counted and classified; no cookie name, value, domain or expiry
 * is returned, logged or stored, and the array is discarded on the next line.
 */
export interface SessionDiagnostics {
  provider: 'browserbase' | 'local';
  /** The Browserbase session, when there is one. */
  browserbaseSessionId: string | null;
  /** Position of this context among the browser's contexts. */
  contextIndex: number;
  contextCount: number;
  /** Position of this page among the context's pages. */
  pageIndex: number;
  pageCount: number;
  url: string;
  cookieCount: number;
  /** True when a cookie that looks like a session cookie exists. */
  hasAuthenticationCookie: boolean;
}

const AUTH_COOKIE_PATTERN = /sess|sid|auth|token|login|phpsessid/i;

export async function sessionDiagnostics(session: ReadymodeSession): Promise<SessionDiagnostics> {
  let cookieCount = 0;
  let hasAuthenticationCookie = false;

  try {
    const cookies = await session.context.cookies();
    cookieCount = cookies.length;
    // Names are read to classify and are not kept. Nothing leaves this line.
    hasAuthenticationCookie = cookies.some((cookie) => AUTH_COOKIE_PATTERN.test(cookie.name));
  } catch {
    // A context that cannot be read reports zero rather than guessing.
  }

  const contexts = session.browser.contexts();
  const pages = session.context.pages();

  return {
    provider: session.provider,
    browserbaseSessionId: session.sessionId ?? null,
    contextIndex: contexts.indexOf(session.context),
    contextCount: contexts.length,
    pageIndex: pages.indexOf(session.page),
    pageCount: pages.length,
    url: session.page.url(),
    cookieCount,
    hasAuthenticationCookie,
  };
}

/**
 * Confirms that crawling is happening in the same place the login did.
 *
 * The session was never actually split — one browser, one context, one page,
 * carried through — but that was worth proving rather than asserting, and this
 * keeps it true if the lifecycle is ever changed.
 */
export function sameSession(a: SessionDiagnostics, b: SessionDiagnostics): boolean {
  return (
    a.browserbaseSessionId === b.browserbaseSessionId &&
    a.contextIndex === b.contextIndex &&
    a.pageIndex === b.pageIndex
  );
}


/**
 * Waiting for Readymode to settle after Continue.
 *
 * `networkidle` alone is the wrong instrument here: Readymode holds background
 * connections open, so idle may never arrive and the wait becomes the whole
 * budget. Three signals are watched instead, and the first that fires wins —
 * the address changing, the document being replaced, or the network going quiet
 * if it happens to.
 */
export interface SettleResult {
  settled: boolean;
  by: 'url-change' | 'dom-change' | 'network-idle' | 'timeout';
  /** Path only: a query string can carry a token. */
  path: string;
  durationMs: number;
}

export async function settleAfterNavigation(
  page: Page,
  options: { timeoutMs?: number; previousUrl?: string } = {},
): Promise<SettleResult> {
  const timeoutMs = options.timeoutMs ?? 8000;
  const started = Date.now();
  const before = options.previousUrl ?? page.url();

  const path = (url: string): string => {
    try {
      return new URL(url).pathname;
    } catch {
      return url.slice(0, 120);
    }
  };

  const urlChanged = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (page.url() !== before) return 'url-change' as const;
      await page.waitForTimeout(150).catch(() => undefined);
    }
    return null;
  })();

  const domReplaced = page
    .waitForLoadState('domcontentloaded', { timeout: timeoutMs })
    .then(() => 'dom-change' as const)
    .catch(() => null);

  // Watched, never depended on: it may simply never happen.
  const networkQuiet = page
    .waitForLoadState('networkidle', { timeout: timeoutMs })
    .then(() => 'network-idle' as const)
    .catch(() => null);

  const first = await Promise.race([
    urlChanged,
    domReplaced,
    networkQuiet,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

  return {
    settled: first !== null,
    by: first ?? 'timeout',
    path: path(page.url()),
    durationMs: Date.now() - started,
  };
}

/**
 * Whether the session is authenticated, decided on four independent signals.
 *
 * One hardcoded dashboard selector is a single point of failure, and it failed:
 * a marker that does not render on a given account reads as "not signed in" for
 * every screen thereafter. These four disagree in useful ways — the first two
 * say what the page is *not*, the last two say what it *is* — and which passed
 * is reported so a wrong answer can be diagnosed instead of guessed at.
 */
export interface AuthenticationSignals {
  loginFormAbsent: boolean;
  existingSessionNoticeAbsent: boolean;
  urlIsNotLogin: boolean;
  authenticatedMarkerPresent: boolean;
  /** The marker that fired, when one did. */
  marker: string | null;
  /** Passed signal names, for the report. */
  passed: string[];
  failed: string[];
  authenticated: boolean;
  path: string;
}

export async function confirmAuthenticated(
  page: Page,
  options: { loginUrl?: string; timeoutMs?: number } = {},
): Promise<AuthenticationSignals> {
  const check = await checkAuthentication(page, options.timeoutMs ?? 1200);

  const loginPath = (() => {
    try {
      return options.loginUrl ? new URL(options.loginUrl).pathname : '/login_new/';
    } catch {
      return '/login_new/';
    }
  })();

  const currentPath = (() => {
    try {
      return new URL(page.url()).pathname;
    } catch {
      return '';
    }
  })();

  const noticeAbsent = !(await page
    .locator('input[type="submit"][value="Continue" i]')
    .first()
    .isVisible()
    .catch(() => false));

  const signals: AuthenticationSignals = {
    loginFormAbsent: !check.loginFormPresent,
    existingSessionNoticeAbsent: noticeAbsent,
    urlIsNotLogin: currentPath !== loginPath,
    authenticatedMarkerPresent: check.authenticated,
    marker: check.marker,
    passed: [],
    failed: [],
    authenticated: false,
    path: currentPath,
  };

  for (const [name, passed] of [
    ['loginFormAbsent', signals.loginFormAbsent],
    ['existingSessionNoticeAbsent', signals.existingSessionNoticeAbsent],
    ['urlIsNotLogin', signals.urlIsNotLogin],
    ['authenticatedMarkerPresent', signals.authenticatedMarkerPresent],
  ] as Array<[string, boolean]>) {
    (passed ? signals.passed : signals.failed).push(name);
  }

  /**
   * The rule: the page must not be the login form, and something must say it is
   * the interface.
   *
   * A marker is the strongest of those, but the URL having moved off the login
   * path, with no login form and no notice on screen, is enough on its own —
   * which keeps one unrendered marker from failing an otherwise good session.
   */
  signals.authenticated =
    signals.loginFormAbsent &&
    signals.existingSessionNoticeAbsent &&
    (signals.authenticatedMarkerPresent || signals.urlIsNotLogin);

  return signals;
}
