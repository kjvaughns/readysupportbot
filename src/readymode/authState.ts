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

  // Each probe waits for an element that is usually absent — that is the point
  // of asking — so the per-probe wait is capped. A caller that wants to wait
  // for a state to arrive polls with `waitForAuthenticated` instead of passing
  // a long timeout here, which would otherwise be spent proving that a password
  // field is still missing.
  const probe = Math.min(timeoutMs, 1200);

  let loginFormPresent = false;
  for (const condition of LOGIN_FORM_CONDITIONS) {
    for (const root of roots) {
      try {
        if ((await countVisible(locatorFor(root, condition), probe)) > 0) {
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
        if ((await countVisible(locatorFor(root, marker.strategy), probe)) > 0) {
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
