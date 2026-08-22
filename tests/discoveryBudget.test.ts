import { describe, expect, it, vi } from 'vitest';
import {
  DISCOVERY_LIMITS,
  Deadline,
  DiscoveryTrace,
  WORKFLOW_STATES,
  withTimeout,
} from '../src/readymode/discovery/trace';
import {
  AdministrativeActionBlocked,
  assertNotAdministrative,
  isAdministrativeLabel,
} from '../src/readymode/discovery/readonly';
import { APPROVED_PANEL_LABELS } from '../src/readymode/navigation';
import { confirmAuthenticated, settleAfterNavigation } from '../src/readymode/authState';
import { buildFakePage } from './support/fakePage';
import type { FakeRootSpec } from './support/fakePage';

/**
 * These exist because a run stopped after signing in and reported nothing but
 * a Browserbase timeout. A platform timeout says only that something took too
 * long — never which screen, or what it was doing.
 */

describe('the discovery budget', () => {
  it('is comfortably inside Browserbase’s five minutes', () => {
    expect(DISCOVERY_LIMITS.totalMs).toBeLessThan(5 * 60_000);
    expect(DISCOVERY_LIMITS.reducedTotalMs).toBeLessThanOrEqual(90_000);
    expect(DISCOVERY_LIMITS.perScreenMs).toBeLessThanOrEqual(20_000);
  });

  it('never hands out more time than remains', () => {
    const deadline = new Deadline(1000);

    expect(deadline.slice(5000)).toBeLessThanOrEqual(1000);
    expect(deadline.slice(200)).toBeLessThanOrEqual(200);
    expect(deadline.expired()).toBe(false);
  });

  it('is expired once it has run out', () => {
    const deadline = new Deadline(0);

    expect(deadline.expired()).toBe(true);
    expect(deadline.remaining()).toBe(0);
    expect(deadline.slice(5000)).toBe(0);
  });
});

describe('one operation under a hard limit', () => {
  it('returns the value when it finishes in time', async () => {
    const outcome = await withTimeout('quick', 1000, async () => 'done');

    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe('done');
    expect(outcome.timedOut).toBe(false);
  });

  it('reports a timeout rather than throwing one', async () => {
    // The whole point: one screen taking too long is a fact about that screen.
    // Throwing would lose every screen after it.
    const outcome = await withTimeout('slow', 30, () => new Promise(() => undefined));

    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toBeInstanceOf(Error);
  });

  it('reports a thrown error rather than propagating it', async () => {
    const outcome = await withTimeout('broken', 1000, async () => {
      throw new Error('the frame detached');
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.timedOut).toBe(false);
    expect((outcome.error as Error).message).toBe('the frame detached');
  });

  it('refuses immediately when there is no time left', async () => {
    const run = vi.fn(async () => 'never');
    const outcome = await withTimeout('too late', 0, run);

    expect(outcome.timedOut).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('the workflow trace', () => {
  it('names every transition the diagnosis asked for', () => {
    expect(WORKFLOW_STATES).toEqual([
      'credentials_submitted',
      'session_warning_detected',
      'continue_clicked',
      'post_login_navigation_started',
      'authenticated_page_loaded',
      'dashboard_confirmed',
      'screen_discovery_started',
      'screen_discovery_finished',
      'profile_saved',
      'response_returned',
    ]);
  });

  it('records where a run stopped, and where it last succeeded', () => {
    const trace = new DiscoveryTrace();

    trace.enter('credentials_submitted');
    trace.enter('post_login_navigation_started');
    trace.enter('authenticated_page_loaded');
    trace.fail('confirm:authenticated', new TypeError('locator resolved to 0 elements'));

    const report = trace.report();

    expect(report.state).toBe('authenticated_page_loaded');
    expect(report.lastSuccessfulState).toBe('authenticated_page_loaded');
    expect(report.failingOperation).toBe('confirm:authenticated');
    expect(report.errorClass).toBe('TypeError');
    expect(report.errorMessage).toContain('locator resolved to 0 elements');
  });

  it('counts screens by outcome so a partial run is legible', () => {
    const trace = new DiscoveryTrace();

    trace.screen({ screen: 'users', result: 'confirmed', durationMs: 900 });
    trace.screen({ screen: 'licenses', result: 'inspected', durationMs: 1200 });
    trace.screen({ screen: 'queues', result: 'skipped', durationMs: 0 });
    trace.screen({ screen: 'campaigns', result: 'timeout', durationMs: 20_000 });
    trace.screen({ screen: 'voip', result: 'failed', durationMs: 400 });

    const report = trace.report();

    expect(report.screensAttempted).toBe(5);
    expect(report.screensConfirmed).toBe(1);
    expect(report.screensSkipped).toBe(1);
    expect(report.screensFailed).toBe(2);
  });

  it('timestamps every event and keeps them in order', () => {
    const trace = new DiscoveryTrace();

    trace.enter('credentials_submitted');
    trace.screen({ screen: 'users', result: 'confirmed', durationMs: 10 });
    trace.enter('screen_discovery_finished');

    const report = trace.report();

    expect(report.events).toHaveLength(3);
    for (const event of report.events) {
      expect(Date.parse(event.at)).not.toBeNaN();
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('records no page text, credentials or personal data', () => {
    const trace = new DiscoveryTrace();

    // A sanitized message is what reaches the report. The raw one never does.
    trace.fail('inspect:users', new Error(`x`.repeat(1000)));

    expect(trace.report().errorMessage!.length).toBeLessThanOrEqual(300);
  });
});

/**
 * The rule the brief states plainly: discovery does not click Create, Save,
 * Update, Delete, Reset Password, Clear License, Deactivate, Logout, or any
 * assignment control.
 */
describe('administrative controls are refused during discovery', () => {
  const forbidden = [
    'Create',
    'Create User',
    'Save',
    'Save Changes',
    'Update',
    'Update Agent',
    'Delete',
    'Delete Queue',
    'Reset Password',
    'Clear License',
    'Deactivate',
    'Deactivate Agent',
    'Logout',
    'Log Out',
    'Sign Out',
    'Assign',
    'Assign Campaign',
    'Unassign',
    'Reassign Lead',
    'Remove',
    'Submit',
    'Apply',
    'Confirm',
  ];

  for (const label of forbidden) {
    it(`throws on "${label}"`, () => {
      expect(isAdministrativeLabel(label)).toBe(true);
      expect(() => assertNotAdministrative(label)).toThrow(AdministrativeActionBlocked);
    });
  }

  it('throws rather than returning false, so the refusal cannot be swallowed', () => {
    // Every click site wraps its work in `.catch(() => undefined)`. A guard
    // that returned false would be ignored by exactly the code it protects.
    let caught: unknown;
    try {
      assertNotAdministrative('Delete User');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AdministrativeActionBlocked);
    expect((caught as AdministrativeActionBlocked).label).toBe('Delete User');
  });

  it('allows every label the panel walk is actually allowed to click', () => {
    for (const label of APPROVED_PANEL_LABELS) {
      expect(() => assertNotAdministrative(label)).not.toThrow();
    }
  });
});

/**
 * Readymode holds background connections open, so `networkidle` may simply
 * never arrive. Waiting on it alone spends the whole budget waiting for
 * something that is not going to happen.
 */
describe('settling after the post-login navigation', () => {
  const pageWhoseNetworkNeverGoesQuiet = (urls: string[]) => {
    let index = 0;
    return {
      url: () => urls[Math.min(index++, urls.length - 1)],
      waitForTimeout: async () => undefined,
      waitForLoadState: async (state: string) => {
        if (state === 'networkidle') return new Promise(() => undefined);
        return undefined;
      },
    } as never;
  };

  it('settles on the document rather than waiting for the network', async () => {
    const settled = await settleAfterNavigation(
      pageWhoseNetworkNeverGoesQuiet(['https://acme.readymode.com/-Dashboard']),
      { timeoutMs: 500 },
    );

    expect(settled.settled).toBe(true);
    expect(settled.by).not.toBe('network-idle');
    expect(settled.durationMs).toBeLessThan(500);
  });

  it('settles on the address changing', async () => {
    const page = {
      url: () => 'https://acme.readymode.com/-Dashboard',
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => new Promise(() => undefined),
    } as never;

    const settled = await settleAfterNavigation(page, {
      timeoutMs: 800,
      previousUrl: 'https://acme.readymode.com/login_new/',
    });

    expect(settled.settled).toBe(true);
    expect(settled.by).toBe('url-change');
    expect(settled.path).toBe('/-Dashboard');
  });

  it('gives up inside its own limit when nothing ever fires', async () => {
    const page = {
      url: () => 'https://acme.readymode.com/login_new/',
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => new Promise(() => undefined),
    } as never;

    const started = Date.now();
    const settled = await settleAfterNavigation(page, { timeoutMs: 300 });

    expect(settled.settled).toBe(false);
    expect(settled.by).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reports the path only, never the query string', async () => {
    const page = {
      url: () => 'https://acme.readymode.com/-Dashboard?session=secret-token',
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
    } as never;

    const settled = await settleAfterNavigation(page, { timeoutMs: 200 });

    expect(settled.path).toBe('/-Dashboard');
    expect(settled.path).not.toContain('secret-token');
  });
});

/**
 * Four signals rather than one hardcoded dashboard selector. A marker that
 * does not render on a given account used to read as "not signed in" for every
 * screen after it.
 */
describe('confirming the interface on several signals', () => {
  const BASE = 'https://acme.readymode.com';

  const dashboard: FakeRootSpec[] = [
    {
      name: 'page',
      url: `${BASE}/-Dashboard`,
      title: 'Readymode Inc. CRM',
      elements: [{ css: ['#hotbar_search'] }, { css: ['#CCS_Session_Statebox'] }],
    },
  ];

  const loginPage: FakeRootSpec[] = [
    {
      name: 'page',
      url: `${BASE}/login_new/`,
      elements: [
        { css: ['input[type="password"]'], placeholder: 'Password' },
        { role: 'button', name: 'Sign in', text: 'Sign in' },
      ],
    },
  ];

  const existingSessionNotice: FakeRootSpec[] = [
    {
      name: 'page',
      url: `${BASE}/login_new/`,
      elements: [
        { css: ['input[type="submit"][value="Continue" i]'], text: 'Continue' },
        { css: ['#hotbar_search'] },
      ],
    },
  ];

  it('confirms the dashboard and says which signals carried it', async () => {
    const { page } = buildFakePage(dashboard);

    const signals = await confirmAuthenticated(page, { loginUrl: `${BASE}/login_new/`, timeoutMs: 50 });

    expect(signals.authenticated).toBe(true);
    expect(signals.failed).toEqual([]);
    expect(signals.passed).toContain('loginFormAbsent');
    expect(signals.passed).toContain('authenticatedMarkerPresent');
    expect(signals.passed).toContain('urlIsNotLogin');
    expect(signals.path).toBe('/-Dashboard');
  });

  it('refuses the login page and names the signal that failed', async () => {
    const { page } = buildFakePage(loginPage);

    const signals = await confirmAuthenticated(page, { loginUrl: `${BASE}/login_new/`, timeoutMs: 50 });

    expect(signals.authenticated).toBe(false);
    expect(signals.failed).toContain('loginFormAbsent');
    expect(signals.failed).toContain('urlIsNotLogin');
  });

  it('refuses while the existing-session notice is still on screen', async () => {
    // Continue is still there, so whatever else the page has, it is the notice.
    const { page } = buildFakePage(existingSessionNotice);

    const signals = await confirmAuthenticated(page, { loginUrl: `${BASE}/login_new/`, timeoutMs: 50 });

    expect(signals.authenticated).toBe(false);
    expect(signals.failed).toContain('existingSessionNoticeAbsent');
  });
});
