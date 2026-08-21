import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_MARKERS,
  checkAuthentication,
  sameSession,
  waitForLoginOutcome,
} from '../src/readymode/authState';
import { LOGIN_SUCCESS_CONDITIONS } from '../src/readymode/selectors';
import { anyPresent } from '../src/readymode/selectors/discovery';
import { buildFakePage } from './support/fakePage';
import type { FakeRootSpec, SessionDiagnosticsLike } from './support/fakePage';

/**
 * The failure these exist for: `ensureAuthenticated` opened the login page,
 * matched a signal the login page also satisfies, concluded the session was
 * already signed in, and returned without entering the credentials. Every
 * administrative route then redirected back to login, and discovery captured
 * the same login page twelve times while reporting a successful crawl.
 */

const BASE = 'https://acme.readymode.com';

/** A realistic Readymode login page: it has a nav, and it mentions signing out. */
const LOGIN_PAGE: FakeRootSpec[] = [
  {
    name: 'page',
    url: `${BASE}/login_new/?then=/`,
    title: 'Readymode Inc. CRM',
    elements: [
      { role: 'navigation', name: 'Site navigation', css: ['nav'] },
      { text: 'You have been signed out.', name: 'You have been signed out.' },
      { css: ['input[type="password"]'], placeholder: 'Password' },
      { css: ["input[placeholder='Username']"], placeholder: 'Username' },
      { role: 'button', name: 'Sign in', text: 'Sign in' },
    ],
  },
];

const DASHBOARD: FakeRootSpec[] = [
  {
    name: 'page',
    url: `${BASE}/-Dashboard`,
    title: 'Readymode Inc. CRM',
    elements: [
      { css: ['#hotbar_search'], placeholder: 'Search..' },
      { css: ['#CCS_Session_Statebox'] },
      { text: 'User Management', name: 'User Management', role: 'link' },
    ],
  },
];

describe('a login page is never authenticated', () => {
  it('refuses the page that caused this, nav and sign-out text and all', async () => {
    const { page } = buildFakePage(LOGIN_PAGE);

    const check = await checkAuthentication(page, 50);

    expect(check.authenticated).toBe(false);
    expect(check.loginFormPresent).toBe(true);
    expect(check.marker).toBeNull();
  });

  it('no longer matches the old signal set either', async () => {
    const { page } = buildFakePage(LOGIN_PAGE);

    // `role=navigation` and /sign out/ used to live in here, and the login page
    // satisfies both. This is the assertion that pins the fix at its source.
    expect(await anyPresent(page, LOGIN_SUCCESS_CONDITIONS, 50)).toBe(false);
  });

  it('refuses even when an authenticated marker is also on screen', async () => {
    // A password field decides it. A page asking for a password is not a page
    // behind one, whatever else it carries.
    const mixed: FakeRootSpec[] = [
      {
        name: 'page',
        url: `${BASE}/-Team/ManageUsers`,
        elements: [
          { css: ['#hotbar_search'] },
          { css: ['input[type="password"]'] },
        ],
      },
    ];

    const { page } = buildFakePage(mixed);
    const check = await checkAuthentication(page, 50);

    expect(check.authenticated).toBe(false);
    expect(check.loginFormPresent).toBe(true);
  });

  it('refuses a password field hidden inside a frame', async () => {
    const framed: FakeRootSpec[] = [
      { name: 'page', url: `${BASE}/-Dashboard`, elements: [{ css: ['#hotbar_search'] }] },
      { name: 'body', url: `${BASE}/login`, elements: [{ css: ['input[type="password"]'] }] },
    ];

    const { page } = buildFakePage(framed);
    expect((await checkAuthentication(page, 50)).authenticated).toBe(false);
  });
});

describe('an authenticated page is proved by a real marker', () => {
  it('accepts the signed-in shell, and says which marker proved it', async () => {
    const { page } = buildFakePage(DASHBOARD);
    const check = await checkAuthentication(page, 50);

    expect(check.authenticated).toBe(true);
    expect(check.marker).toBe('hotbar search');
    expect(check.loginFormPresent).toBe(false);
  });

  it('never uses the URL as proof', async () => {
    // The address says User Management; the page is empty. A legacy shell
    // answers at any address, so the URL settles nothing.
    const { page } = buildFakePage([
      { name: 'page', url: `${BASE}/-Team/ManageUsers`, elements: [] },
    ]);

    const check = await checkAuthentication(page, 50);
    expect(check.authenticated).toBe(false);
    expect(check.url).toContain('-Team/ManageUsers');
  });

  it('uses markers only the signed-in shell has', () => {
    const strategies = AUTHENTICATED_MARKERS.map((marker) => JSON.stringify(marker.strategy));

    // A bare role is something a login page can satisfy too.
    expect(strategies.some((strategy) => strategy.includes('"role":"navigation"'))).toBe(false);
    expect(strategies.some((strategy) => strategy.includes('#hotbar_search'))).toBe(true);
  });
});

describe('waiting for the login to resolve', () => {
  const never = async () => false;

  it('reports the session warning when one appears', async () => {
    const { page } = buildFakePage(LOGIN_PAGE);

    const result = await waitForLoginOutcome(
      page,
      { humanVerification: never, sessionWarning: async () => true, limitedAdminMode: never, loginError: never },
      500,
    );

    expect(result.outcome).toBe('multiple_session_warning');
  });

  it('reports human verification before anything else', async () => {
    const { page } = buildFakePage(LOGIN_PAGE);

    // A page carrying both a captcha and a Continue button is a captcha.
    const result = await waitForLoginOutcome(
      page,
      {
        humanVerification: async () => true,
        sessionWarning: async () => true,
        limitedAdminMode: never,
        loginError: never,
      },
      500,
    );

    expect(result.outcome).toBe('human_verification');
  });

  it('reports authentication when the shell appears', async () => {
    const { page } = buildFakePage(DASHBOARD);

    const result = await waitForLoginOutcome(
      page,
      { humanVerification: never, sessionWarning: never, limitedAdminMode: never, loginError: never },
      500,
    );

    expect(result.outcome).toBe('authenticated');
    expect(result.marker).toBe('hotbar search');
  });

  it('reports a visible login error', async () => {
    const { page } = buildFakePage(LOGIN_PAGE);

    const result = await waitForLoginOutcome(
      page,
      { humanVerification: never, sessionWarning: never, limitedAdminMode: never, loginError: async () => true },
      500,
    );

    expect(result.outcome).toBe('login_error');
  });

  it('reports a timeout rather than calling it success', async () => {
    const { page } = buildFakePage(LOGIN_PAGE);

    const result = await waitForLoginOutcome(
      page,
      { humanVerification: never, sessionWarning: never, limitedAdminMode: never, loginError: never },
      200,
    );

    // A login that neither succeeded nor visibly failed is a real state, and
    // treating it as success is how a run ends up crawling a login page.
    expect(result.outcome).toBe('timeout');
  });
});

describe('session identity', () => {
  const diagnostics = (overrides: Partial<SessionDiagnosticsLike> = {}): SessionDiagnosticsLike => ({
    provider: 'browserbase',
    browserbaseSessionId: 'bb-1',
    contextIndex: 0,
    contextCount: 1,
    pageIndex: 0,
    pageCount: 1,
    url: BASE,
    cookieCount: 4,
    hasAuthenticationCookie: true,
    ...overrides,
  });

  it('recognizes the same session, context and page', () => {
    expect(sameSession(diagnostics(), diagnostics({ url: `${BASE}/-Dashboard` }))).toBe(true);
  });

  it('notices a different Browserbase session', () => {
    expect(sameSession(diagnostics(), diagnostics({ browserbaseSessionId: 'bb-2' }))).toBe(false);
  });

  it('notices a new context or page', () => {
    expect(sameSession(diagnostics(), diagnostics({ contextIndex: 1 }))).toBe(false);
    expect(sameSession(diagnostics(), diagnostics({ pageIndex: 1 }))).toBe(false);
  });

  it('carries no cookie name or value', () => {
    const serialized = JSON.stringify(diagnostics());
    expect(serialized).toContain('cookieCount');
    expect(serialized).toContain('hasAuthenticationCookie');
    // The jar is counted and classified. Nothing from inside it is kept.
    expect(serialized).not.toMatch(/PHPSESSID|"name"|"value"|domain/i);
  });
});
