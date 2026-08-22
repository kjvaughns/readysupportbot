import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverInterface } from '../src/readymode/discovery/walk';

/**
 * The reduced run, end to end.
 *
 * Sign in, get past the administrator session notice, confirm the interface,
 * read the navigation structure, stop. Nothing is crawled and nothing is
 * clicked, and it happens inside its own budget — which is the whole point,
 * because the run this replaces ended in a Browserbase timeout that could say
 * only that something took too long.
 */

const authTrace = {
  submittedCredentials: true,
  continuedPastSessionNotice: true,
  urlAfterSubmit: 'https://acme.readymode.com/login_new/',
  urlAfterContinue: 'https://acme.readymode.com/-Dashboard',
  outcome: 'authenticated' as const,
};

const ensureAuthenticated = vi.fn(async (_session: unknown) => undefined);

vi.mock('../src/readymode/session', () => ({
  ensureAuthenticated: (session: unknown) => ensureAuthenticated(session),
  lastAuthenticationTrace: () => authTrace,
}));

const BASE = 'https://acme.readymode.com';

/** The shape `collectFromRoot` returns, with a navigation shell on it. */
const collected = {
  title: 'Readymode Inc. CRM',
  childFrameUrls: [],
  nav: [
    { label: 'User Management', href: '/-Team/ManageUsers' },
    { label: 'License Usage', href: '/-Team/LicenseUsage' },
    { label: 'Campaigns', href: '/-Campaigns' },
  ],
  buttons: [],
  inputs: [],
  selects: [],
  checkboxes: [],
  links: [],
  forms: [],
  tables: [],
  clickables: [],
  headings: [{ level: 1, text: 'Dashboard' }],
  truncated: [],
  passwordFieldsSeen: 0,
};

function buildSession(): { session: any; clicks: string[]; gotos: string[] } {
  const clicks: string[] = [];
  const gotos: string[] = [];
  let url = `${BASE}/login_new/`;

  const locator = (selector: string) => ({
    first: () => locator(selector),
    // Nothing the reduced run looks for is on screen: no password field, no
    // Continue notice. The dashboard marker is the exception.
    isVisible: async () => selector.includes('hotbar_search') || selector.includes('CCS_Session_Statebox'),
    count: async () => (selector.includes('hotbar') ? 1 : 0),
    waitFor: async () => {
      if (!selector.includes('hotbar')) throw new Error('not found');
    },
    click: async () => {
      clicks.push(selector);
    },
    textContent: async () => '',
    getAttribute: async () => null,
    evaluate: async () => collected,
    nth: () => locator(selector),
  });

  const root: any = {
    url: () => url,
    name: () => '',
    isDetached: () => false,
    title: async () => 'Readymode Inc. CRM',
    locator,
    getByRole: () => locator('role'),
    getByText: () => locator('text'),
    getByLabel: () => locator('label'),
    getByPlaceholder: () => locator('placeholder'),
    evaluate: async () => collected,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
    content: async () => '<html></html>',
    innerText: async () => 'Dashboard',
  };

  const page: any = Object.assign(root, {
    frames: () => [page],
    mainFrame: () => page,
    isClosed: () => false,
    screenshot: async () => Buffer.from(''),
    goto: async (destination: string) => {
      gotos.push(destination);
      url = destination;
    },
  });

  const context: any = { cookies: async () => [{ name: 'PHPSESSID' }], pages: () => [page] };
  const browser: any = { contexts: () => [context] };

  return {
    session: {
      page,
      context,
      browser,
      provider: 'local' as const,
      organizationId: 'org-1',
      close: async () => undefined,
    },
    clicks,
    gotos,
  };
}

describe('the reduced discovery run', () => {
  beforeEach(() => {
    ensureAuthenticated.mockClear();
  });

  it('is the default, so a full crawl is never what runs by accident', async () => {
    const { session } = buildSession();

    const walk = await discoverInterface(session, `${BASE}/login_new/`);

    expect(walk.mode).toBe('reduced');
  });

  it('names every transition, in order, and stops at the navigation structure', async () => {
    const { session } = buildSession();

    const walk = await discoverInterface(session, `${BASE}/login_new/`, { screenshots: false });

    const states = walk.workflow.events.map((event) => event.state).filter(Boolean);

    expect(states).toEqual([
      'credentials_submitted',
      'session_warning_detected',
      'continue_clicked',
      'post_login_navigation_started',
      'authenticated_page_loaded',
      'dashboard_confirmed',
      'screen_discovery_started',
      'screen_discovery_finished',
    ]);
  });

  it('confirms the interface and reports which signals carried it', async () => {
    const { session } = buildSession();

    const walk = await discoverInterface(session, `${BASE}/login_new/`, { screenshots: false });

    expect(walk.dashboardConfirmed).toBe(true);
    expect(walk.authenticationSignals?.passed).toContain('loginFormAbsent');
    expect(walk.authenticationSignals?.passed).toContain('existingSessionNoticeAbsent');
    expect(walk.authenticationSignals?.failed).toEqual([]);
  });

  it('crawls no administrative screen and clicks nothing', async () => {
    const { session, clicks } = buildSession();

    const walk = await discoverInterface(session, `${BASE}/login_new/`, { screenshots: false });

    expect(clicks).toEqual([]);
    expect(walk.panels).toEqual([]);
    expect(walk.workflows).toEqual([]);
    expect(walk.visited).toEqual(['screen:navigation']);
  });

  it('finishes well inside ninety seconds', async () => {
    const { session } = buildSession();
    const started = Date.now();

    const walk = await discoverInterface(session, `${BASE}/login_new/`, { screenshots: false });

    expect(Date.now() - started).toBeLessThan(90_000);
    expect(walk.withinBudget).toBe(true);
    expect(walk.workflow.totalMs).toBeLessThan(90_000);
  });

  it('records the navigation structure it read', async () => {
    const { session } = buildSession();

    const walk = await discoverInterface(session, `${BASE}/login_new/`, { screenshots: false });

    const [inspected] = walk.evidence.pages.filter((page) => page.step === 'screen:navigation');
    expect(inspected).toBeDefined();
    expect(inspected.roots[0].nav.map((entry) => entry.label)).toContain('User Management');
  });
});

describe('a reduced run that cannot confirm the interface', () => {
  it('says where it stopped and what failed, and still returns', async () => {
    const { session } = buildSession();
    // The login form never goes away: whatever the sign-in reported, this is
    // not the interface.
    session.page.locator = (selector: string) => ({
      first: () => session.page.locator(selector),
      isVisible: async () => selector.includes('password'),
      count: async () => (selector.includes('password') ? 1 : 0),
      waitFor: async () => {
        if (!selector.includes('password')) throw new Error('not found');
      },
      click: async () => undefined,
      evaluate: async () => collected,
      nth: () => session.page.locator(selector),
      textContent: async () => '',
      getAttribute: async () => null,
    });

    const walk = await discoverInterface(session, `${BASE}/login_new/`, { screenshots: false });

    expect(walk.dashboardConfirmed).toBe(false);
    expect(walk.workflow.lastSuccessfulState).toBe('authenticated_page_loaded');
    expect(walk.workflow.failingOperation).toBe('confirm:authenticated');
    expect(walk.authenticationSignals?.failed).toContain('loginFormAbsent');
    // A partial profile is still buildable from what it did see.
    expect(walk.evidence.pages.length).toBeGreaterThan(0);
  });
});
