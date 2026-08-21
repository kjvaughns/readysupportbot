import type { Page } from 'playwright-core';
import { sanitizePageValue } from '../../security/sanitize';
import {
  Arrival,
  findExactLabel,
  gotoRoute,
  isApprovedPanelLabel,
  openFirstRecord,
  waitForArrival,
} from '../navigation';
import { DASHBOARD_ROUTE } from '../interface/registry';
import {
  AuthenticationCheck,
  SessionDiagnostics,
  checkAuthentication,
  sameSession,
  sessionDiagnostics,
} from '../authState';
import { ReadymodeSession, ensureAuthenticated, lastAuthenticationTrace } from '../session';
import { EVIDENCE_CAPS, InterfaceEvidence, PageEvidence } from './evidence';
import { buildEvidence, inspectCurrentPage } from './inspector';
import {
  CRAWL_TARGETS,
  CrawlTarget,
  DiscoveryState,
  StageResult,
  WORKFLOW_PROBES,
  WorkflowProbeResult,
  furthestStage,
  mayClaimCrawled,
} from './stages';

/**
 * The staged, read-only walk through Readymode.
 *
 * It runs in order — inspect the login page, sign in, continue past the
 * administrator session notice if it appears, confirm the authenticated
 * dashboard, crawl the administrative screens, walk each workflow, and only
 * then hand the evidence on to be turned into selectors.
 *
 * Two things changed after a run produced a profile that had only ever seen the
 * login page.
 *
 * The stages are now explicit and reported. A run that signs in and then fails
 * to crawl used to look exactly like a run that crawled and found nothing.
 *
 * And a screen is now always inspected, whether or not its arrival could be
 * confirmed. Confirmation used to gate the capture, so a screen that opened
 * without announcing itself in the way the code expected was skipped entirely —
 * and every authenticated screen was skipped, which is how the interface went
 * unobserved while the run reported success. Confirmation now decides how much
 * a capture is trusted, not whether it happens.
 *
 * Nothing here submits, saves, creates, deactivates, resets or changes
 * anything. It navigates and it reads.
 */

// The looser guard lives with the navigation model, next to the exact
// allowlist it complements. Re-exported because it is the walk's safety rule.
export { isSafeToClick } from '../navigation';

export interface WalkOptions {
  /** Maximum screens captured, excluding the login and dashboard captures. */
  maxStops?: number;
  screenshots?: boolean;
  /** Skip the workflow probes, for a quick structural run. */
  skipWorkflows?: boolean;
}

/** One screen the crawl tried to reach. */
export interface PanelVisit {
  key: string;
  label: string;
  route: string | null;
  /** The heading the step expected. */
  expectedHeading: string | null;
  /** The heading that actually appeared. */
  observedHeading: string | null;
  /** How the screen was recognized, or `none` when it never was. */
  arrivalEvidence: Arrival['evidence'];
  /** True when arrival was confirmed. Evidence is captured either way. */
  confirmed: boolean;
  captured: boolean;
  /** The address the navigation actually ended at. Never proof of anything. */
  finalUrl: string | null;
  /** True when the route bounced back to the login form. */
  redirectedToLogin: boolean;
  /** Roots inspected on this screen, so an empty capture is visible. */
  rootsInspected: number;
  reason?: string;
}

export interface WalkResult {
  evidence: InterfaceEvidence;
  stages: StageResult[];
  stageReached: DiscoveryState | null;
  /** Safe browser identity, recorded before login and again before crawling. */
  session: { atLogin: SessionDiagnostics | null; atCrawl: SessionDiagnostics | null; same: boolean };
  /** How the login attempt ended, and which marker proved it. */
  authentication: {
    outcome: string | null;
    marker: string | null;
    urlAfterSubmit: string | null;
    urlAfterContinue: string | null;
  };
  /** Set when a route bounced back to login mid-crawl. */
  authenticationLostAt: string | null;
  /** Captures that were the login page rather than an administrative screen. */
  loginRedirects: number;
  /** Distinct administrative screens actually captured while signed in. */
  uniqueAuthenticatedPages: number;
  screensAttempted: number;
  screensConfirmed: number;
  /** True when the authenticated dashboard was positively confirmed. */
  dashboardConfirmed: boolean;
  /** True when the administrator session notice appeared and was continued past. */
  continuedPastSessionNotice: boolean;
  panels: PanelVisit[];
  workflows: WorkflowProbeResult[];
  visited: string[];
  skipped: Array<{ label: string; reason: string }>;
  errors: Array<{ where: string; reason: string }>;
  loginPageObserved: boolean;
}

const now = () => new Date().toISOString();

export async function discoverInterface(
  session: ReadymodeSession,
  loginUrl: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxStops = Math.min(options.maxStops ?? 16, EVIDENCE_CAPS.maxPages - 2);
  const screenshots = options.screenshots !== false;
  const counters = { personalDataDropped: 0, passwordFieldsSeen: 0 };

  const pages: PageEvidence[] = [];
  const stages: StageResult[] = [];
  const panels: PanelVisit[] = [];
  const workflows: WorkflowProbeResult[] = [];
  const visited: string[] = [];
  const skipped: Array<{ label: string; reason: string }> = [];
  const errors: Array<{ where: string; reason: string }> = [];

  const { page } = session;
  let captured = 0;

  const record = (stage: DiscoveryState, reached: boolean, detail?: string) => {
    stages.push({ stage, reached, at: now(), detail });
  };

  /** Inspects wherever the session is now. Always records something. */
  const inspect = async (step: string, expected: string | null): Promise<PageEvidence> => {
    const evidence = await inspectCurrentPage(page, step, counters, {
      screenshot: screenshots,
      expectedPanelState: expected,
    });
    pages.push(evidence);
    captured += 1;
    return evidence;
  };

  // -- Stage 1: the login page ----------------------------------------------
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch((error) => {
    errors.push({ where: 'login', reason: reasonOf(error) });
  });

  const atLogin = await sessionDiagnostics(session).catch(() => null);

  // Whether the login form is on screen, decided by the form itself rather than
  // by signals a login page also satisfies.
  const beforeSignIn = await checkAuthentication(page, 1500);
  const loginPageObserved = beforeSignIn.loginFormPresent;

  await inspect(loginPageObserved ? 'login' : 'already-signed-in', null);
  record(
    'login_page_confirmed',
    true,
    loginPageObserved
      ? 'The login form is on screen.'
      : `No login form; already signed in${beforeSignIn.marker ? ` (${beforeSignIn.marker})` : ''}.`,
  );

  const failed = (detail: string): WalkResult => {
    record('authentication_failed', true, detail);
    errors.push({ where: 'authentication', reason: detail });

    return {
      evidence: buildEvidence(loginUrl, pages, counters),
      stages,
      stageReached: furthestStage(stages),
      session: { atLogin, atCrawl: null, same: true },
      authentication: {
        outcome: lastAuthenticationTrace(session).outcome,
        marker: null,
        urlAfterSubmit: lastAuthenticationTrace(session).urlAfterSubmit,
        urlAfterContinue: lastAuthenticationTrace(session).urlAfterContinue,
      },
      authenticationLostAt: null,
      loginRedirects: 0,
      uniqueAuthenticatedPages: 0,
      screensAttempted: 0,
      screensConfirmed: 0,
      dashboardConfirmed: false,
      continuedPastSessionNotice: false,
      panels,
      workflows,
      visited,
      skipped,
      errors,
      loginPageObserved,
    };
  };

  // -- Stages 2 and 3: sign in, and continue past the session notice --------
  try {
    await ensureAuthenticated(session);
  } catch (error) {
    record('credentials_submitted', true, 'Submitted, but sign-in did not complete.');
    return failed(reasonOf(error));
  }

  const trace = lastAuthenticationTrace(session);

  record(
    'credentials_submitted',
    true,
    trace.submittedCredentials
      ? `Submitted; outcome: ${trace.outcome ?? 'unknown'}.`
      : 'A session was already open, so no credentials were submitted.',
  );
  record(
    'multiple_session_continued',
    trace.continuedPastSessionNotice,
    trace.continuedPastSessionNotice
      ? 'Another administrator was signed in; Continue was pressed once.'
      : 'The administrator session notice did not appear.',
  );

  // -- Stage 4: confirm the authenticated dashboard -------------------------
  //
  // The dashboard has to be proved by something only the signed-in shell has.
  // A previous version accepted any navigation element, which the login page
  // also has, so it confirmed a dashboard that was really a login form and then
  // crawled eleven redirects back to it.
  await gotoRoute(page, DASHBOARD_ROUTE, ['Dashboard'], { timeoutMs: 8000 });
  const authenticated: AuthenticationCheck = await checkAuthentication(page, 4000);

  record(
    'authenticated_dashboard_confirmed',
    authenticated.authenticated,
    authenticated.authenticated
      ? `Confirmed by the ${authenticated.marker}.`
      : authenticated.loginFormPresent
        ? 'The dashboard route showed the login form, so the session is not signed in.'
        : 'No authenticated marker was found on the dashboard route.',
  );

  if (!authenticated.authenticated) {
    return failed(
      authenticated.loginFormPresent
        ? 'Signing in reported success, but the dashboard route shows the login form.'
        : 'Signing in reported success, but no authenticated marker could be found.',
    );
  }

  const atCrawl = await sessionDiagnostics(session).catch(() => null);
  const sessionUnchanged = !atLogin || !atCrawl || sameSession(atLogin, atCrawl);

  if (!sessionUnchanged) {
    // Never observed — the session is one browser, one context, one page
    // throughout — but asserting it is cheaper than trusting it.
    errors.push({
      where: 'session',
      reason: 'The browser context or page changed between signing in and crawling.',
    });
  }

  record('interface_crawling', true, `Crawling as ${atCrawl?.provider ?? 'unknown'} session.`);

  // -- Stages 5 and 6: crawl every screen, inspecting each one --------------
  let loginRedirects = 0;
  let screensAttempted = 0;
  let screensConfirmed = 0;
  let authenticationLostAt: string | null = null;

  for (const target of CRAWL_TARGETS) {
    if (authenticationLostAt) {
      skipped.push({ label: target.label, reason: 'The crawl stopped when the session was lost.' });
      continue;
    }
    if (captured >= maxStops + 2) {
      skipped.push({ label: target.label, reason: 'Capture limit reached.' });
      continue;
    }

    screensAttempted += 1;
    const visit = await visitTarget(page, target);
    panels.push(visit);

    // A route that bounces back to login is not an administrative screen, and
    // recording it as one is how twelve captures of the same login page were
    // reported as twelve pages of interface.
    if (visit.redirectedToLogin) {
      loginRedirects += 1;
      authenticationLostAt = target.key;
      skipped.push({
        label: target.label,
        reason: 'Redirected to the login form; the session was lost here.',
      });
      break;
    }

    if (visit.confirmed) screensConfirmed += 1;

    if (visit.captured) {
      const evidence = await inspect(`screen:${target.key}`, target.expect[0] ?? null);
      visit.rootsInspected = evidence.roots.length;
      visit.observedHeading = visit.observedHeading ?? evidence.panelState;
      visited.push(target.key);
    } else {
      skipped.push({ label: target.label, reason: visit.reason ?? 'The screen could not be reached.' });
    }
  }

  if (authenticationLostAt) {
    record(
      'authentication_lost',
      true,
      `The session was signed in and then was not: ${authenticationLostAt} redirected to the login form.`,
    );
    errors.push({
      where: `screen:${authenticationLostAt}`,
      reason: 'Redirected to the login form mid-crawl.',
    });
  }

  // Only a run that confirmed the dashboard and then confirmed at least one
  // administrative screen may say it crawled the interface.
  const crawled = mayClaimCrawled({
    dashboardConfirmed: authenticated.authenticated,
    screensConfirmed,
    authenticationLost: Boolean(authenticationLostAt),
  });

  record(
    'interface_crawled',
    crawled,
    crawled
      ? `${visited.length} screen(s) inspected, ${screensConfirmed} confirmed by name.`
      : `Not claimed: ${screensConfirmed} screen(s) confirmed of ${screensAttempted} attempted.`,
  );

  // -- Workflows -------------------------------------------------------------
  if (!options.skipWorkflows && crawled) {
    for (const probe of WORKFLOW_PROBES) {
      const result: WorkflowProbeResult = {
        key: probe.key,
        intent: probe.intent,
        reached: [],
        unreachable: [],
        controlsFound: [],
        controlsMissing: [...probe.controls],
        status: probe.blocked ? 'blocked' : 'documented',
        reason: probe.blocked,
      };

      if (probe.blocked) {
        workflows.push(result);
        continue;
      }

      let onPath = true;
      for (const key of probe.path) {
        const target = CRAWL_TARGETS.find((entry) => entry.key === key);
        if (!target) continue;

        const visit = await visitTarget(page, target);
        if (visit.captured || visit.confirmed) result.reached.push(key);
        else {
          result.unreachable.push(key);
          result.reason = visit.reason;
          onPath = false;
          break;
        }
      }

      if (!onPath) {
        result.status = 'blocked';
        workflows.push(result);
        continue;
      }

      if (probe.openFirstRecord && captured < maxStops + 2) {
        // A record has no route of its own. Its contents are never captured —
        // the collector reads attributes and structure, not cells.
        const opened = await openFirstRecord(
          page,
          ['Account Settings', 'Activity Log', 'User Management'],
          { timeoutMs: 8000 },
        );
        if (!opened.opened) {
          result.reason = opened.reason ?? 'No record could be opened.';
          result.status = 'blocked';
          workflows.push(result);
          continue;
        }
      }

      for (const tab of probe.tabs ?? []) {
        if (!isApprovedPanelLabel(tab)) continue;
        const found = await findExactLabel(page, tab);
        if (!found) {
          result.reason = `The "${tab}" tab was not uniquely visible.`;
          continue;
        }
        await found.locator.click({ timeout: 6000 }).catch(() => undefined);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      }

      if (captured < maxStops + 2) {
        const evidence = await inspect(`workflow:${probe.key}`, null);
        result.status = evidence.roots.some((root) => !root.error) ? 'discovered' : 'blocked';
        visited.push(`workflow:${probe.key}`);
      }

      workflows.push(result);
    }
  }

  record('profile_generated', crawled);

  return {
    evidence: buildEvidence(loginUrl, pages, counters),
    stages,
    stageReached: furthestStage(stages),
    session: { atLogin, atCrawl, same: sessionUnchanged },
    authentication: {
      outcome: trace.outcome,
      marker: authenticated.marker,
      urlAfterSubmit: trace.urlAfterSubmit,
      urlAfterContinue: trace.urlAfterContinue,
    },
    authenticationLostAt,
    loginRedirects,
    // Distinct administrative screens, counted from what was actually captured
    // rather than from how many times a page was inspected.
    uniqueAuthenticatedPages: new Set(visited.filter((step) => step.startsWith('screen:') || !step.includes(':'))).size,
    screensAttempted,
    screensConfirmed,
    dashboardConfirmed: authenticated.authenticated,
    continuedPastSessionNotice: trace.continuedPastSessionNotice,
    panels,
    workflows,
    visited,
    skipped,
    errors,
    loginPageObserved,
  };
}

/**
 * Goes to one screen and reports what happened.
 *
 * `captured: true` means there is something worth inspecting, which is not the
 * same as `confirmed: true`. A route that loads without announcing itself is
 * still inspected — the previous behaviour was to skip it, and skipping every
 * unannounced screen is exactly how an authenticated crawl produced nothing.
 */
async function visitTarget(page: Page, target: CrawlTarget): Promise<PanelVisit> {
  const visit: PanelVisit = {
    key: target.key,
    label: target.label,
    route: target.route,
    expectedHeading: target.expect[0] ?? null,
    observedHeading: null,
    arrivalEvidence: 'none',
    confirmed: false,
    captured: false,
    finalUrl: null,
    redirectedToLogin: false,
    rootsInspected: 0,
    reason: target.knownLimitation,
  };

  const result = await gotoRoute(page, target.route, target.expect, { timeoutMs: 6000 });

  if (target.tabOf && target.tabLabel) {
    if (isApprovedPanelLabel(target.tabLabel)) {
      const tab = await findExactLabel(page, target.tabLabel);
      if (tab) {
        await tab.locator.click({ timeout: 6000 }).catch(() => undefined);
        await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      } else {
        visit.reason = `The "${target.tabLabel}" tab was not uniquely visible.`;
      }
    }
  }

  // Before anything else: did this route bounce back to the login form? The
  // final URL is recorded and is never the thing that answers the question.
  const state = await checkAuthentication(page, 1200);
  visit.finalUrl = state.url;

  if (state.loginFormPresent) {
    visit.redirectedToLogin = true;
    visit.captured = false;
    visit.confirmed = false;
    visit.reason = 'Redirected to the login form.';
    return visit;
  }

  const arrival = await waitForArrival(page, target.expect, 3000);
  visit.observedHeading = arrival.heading;
  visit.arrivalEvidence = arrival.evidence;
  visit.confirmed = Boolean(arrival.heading);

  // Inspect unless the navigation itself failed. A screen that loaded and did
  // not announce itself still has controls on it.
  visit.captured = result.opened || arrival.heading !== null || !result.reason?.includes('could not be reached');

  if (!visit.confirmed && !visit.reason) {
    visit.reason = `Loaded, but none of ${target.expect.join(', ')} could be confirmed on screen.`;
  }

  return visit;
}

function reasonOf(error: unknown): string {
  return sanitizePageValue(error instanceof Error ? error.message : 'unknown error', 200);
}
