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
  AuthenticationSignals,
  SessionDiagnostics,
  checkAuthentication,
  confirmAuthenticated,
  sameSession,
  sessionDiagnostics,
  settleAfterNavigation,
} from '../authState';
import {
  DISCOVERY_LIMITS,
  Deadline,
  DiscoveryTrace,
  WorkflowReport,
  withTimeout,
} from './trace';
import { assertNotAdministrative } from './readonly';
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
 * The staged, read-only walk through Readymode, run as a finite-state workflow
 * against a deadline it owns.
 *
 * It runs in order — inspect the login page, sign in, continue past the
 * administrator session notice if it appears, settle, confirm the interface on
 * four independent signals, read the navigation structure, and only in `full`
 * mode crawl every administrative screen and walk each workflow.
 *
 * Three things changed after runs that stopped without saying where.
 *
 * The stages are explicit and reported. A run that signs in and then fails to
 * crawl used to look exactly like a run that crawled and found nothing.
 *
 * A screen is always inspected, whether or not its arrival could be confirmed.
 * Confirmation used to gate the capture, so a screen that opened without
 * announcing itself was skipped entirely — and every authenticated screen was
 * skipped, which is how the interface went unobserved while the run reported
 * success. Confirmation now decides how much a capture is trusted, not whether
 * it happens.
 *
 * And the run is bounded. Every navigation, locator wait, frame inspection and
 * screenshot has a limit, no screen may take more than twenty seconds, and the
 * whole thing finishes or fails inside its budget — so Browserbase's own
 * five-minute timeout never becomes the error handler, which is a thing that
 * reports only that something took too long.
 *
 * Nothing here submits, saves, creates, deactivates, resets or changes
 * anything. It navigates and it reads, and every click it makes goes through
 * `assertNotAdministrative` first.
 */

// The looser guard lives with the navigation model, next to the exact
// allowlist it complements. Re-exported because it is the walk's safety rule.
export { isSafeToClick } from '../navigation';
export { AdministrativeActionBlocked, assertNotAdministrative, isAdministrativeLabel } from './readonly';

export interface WalkOptions {
  /** Maximum screens captured, excluding the login and dashboard captures. */
  maxStops?: number;
  screenshots?: boolean;
  /** Skip the workflow probes, for a quick structural run. */
  skipWorkflows?: boolean;
  /**
   * `reduced` does the minimum that proves the path works: sign in, get past
   * the notice, confirm the interface, read the navigation structure, save.
   * Nothing is crawled. It is the default because a full crawl that cannot
   * finish tells you less than a short one that does.
   */
  mode?: 'reduced' | 'full';
  /** Overall budget. The run fails inside this rather than outliving it. */
  totalMs?: number;
  /** Cap on any one screen. */
  perScreenMs?: number;
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
  /** True when the screen used up its own limit and was abandoned. */
  timedOut: boolean;
  durationMs: number;
  reason?: string;
}

export interface WalkResult {
  evidence: InterfaceEvidence;
  /** The finite-state trace: every transition, timestamped. */
  workflow: WorkflowReport;
  /**
   * The live trace, so the caller can record `profile_saved` and
   * `response_returned` — states that happen after the walk returns.
   */
  trace: DiscoveryTrace;
  /** Which authentication signals passed and which did not. */
  authenticationSignals: AuthenticationSignals | null;
  mode: 'reduced' | 'full';
  /** True when the run ended inside its own budget rather than being cut off. */
  withinBudget: boolean;
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
  screensSkipped: number;
  screensFailed: number;
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
  const mode = options.mode ?? 'reduced';
  const totalMs =
    options.totalMs ??
    (mode === 'reduced' ? DISCOVERY_LIMITS.reducedTotalMs : DISCOVERY_LIMITS.totalMs);
  const perScreenMs = Math.min(options.perScreenMs ?? DISCOVERY_LIMITS.perScreenMs, DISCOVERY_LIMITS.perScreenMs);

  const trace = new DiscoveryTrace();
  const deadline = new Deadline(totalMs);

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

  // Everything the result reads, in one place, so both exits report the same
  // shape and neither can drift from the other.
  let atLogin: SessionDiagnostics | null = null;
  let atCrawl: SessionDiagnostics | null = null;
  let sessionUnchanged = true;
  let loginPageObserved = false;
  let authenticationSignals: AuthenticationSignals | null = null;
  let dashboardConfirmed = false;
  let loginRedirects = 0;
  let screensAttempted = 0;
  let screensConfirmed = 0;
  let authenticationLostAt: string | null = null;

  const record = (stage: DiscoveryState, reached: boolean, detail?: string) => {
    stages.push({ stage, reached, at: now(), detail });
  };

  const result = (): WalkResult => {
    const auth = lastAuthenticationTrace(session);
    return {
      evidence: buildEvidence(loginUrl, pages, counters),
      workflow: trace.report(),
      trace,
      authenticationSignals,
      mode,
      withinBudget: !deadline.expired(),
      stages,
      stageReached: furthestStage(stages),
      session: { atLogin, atCrawl, same: sessionUnchanged },
      authentication: {
        outcome: auth.outcome,
        marker: authenticationSignals?.marker ?? null,
        urlAfterSubmit: auth.urlAfterSubmit,
        urlAfterContinue: auth.urlAfterContinue,
      },
      authenticationLostAt,
      loginRedirects,
      // Distinct administrative screens, counted from what was actually
      // captured rather than from how many times a page was inspected.
      uniqueAuthenticatedPages: new Set(
        visited.filter((step) => step.startsWith('screen:') || !step.includes(':')),
      ).size,
      screensAttempted,
      screensConfirmed,
      screensSkipped: trace.screens.skipped,
      screensFailed: trace.screens.failed,
      dashboardConfirmed,
      continuedPastSessionNotice: auth.continuedPastSessionNotice,
      panels,
      workflows,
      visited,
      skipped,
      errors,
      loginPageObserved,
    };
  };

  const failed = (operation: string, detail: string, error?: unknown): WalkResult => {
    record('authentication_failed', true, detail);
    errors.push({ where: operation, reason: detail });
    trace.fail(operation, error ?? new Error(detail));
    return result();
  };

  /**
   * Inspects wherever the session is now, under a limit.
   *
   * A frame that will not answer used to be able to hold the whole run: the
   * collector waits per root, and a page with a dozen frames multiplies that.
   */
  const inspect = async (step: string, expected: string | null): Promise<PageEvidence | null> => {
    const budget = deadline.slice(perScreenMs);
    const outcome = await withTimeout(`inspect:${step}`, budget, () =>
      inspectCurrentPage(page, step, counters, {
        // The screenshot is the slowest part of a capture and the least load
        // bearing; it is dropped rather than allowed to cost a screen.
        screenshot: screenshots && budget > DISCOVERY_LIMITS.screenshotMs * 2,
        expectedPanelState: expected,
      }),
    );

    if (!outcome.ok || !outcome.value) {
      trace.screen({
        screen: step,
        result: outcome.timedOut ? 'timeout' : 'failed',
        durationMs: outcome.durationMs,
        detail: outcome.timedOut ? `exceeded ${budget}ms` : reasonOf(outcome.error),
      });
      errors.push({ where: step, reason: outcome.timedOut ? 'Inspection timed out.' : reasonOf(outcome.error) });
      return null;
    }

    pages.push(outcome.value);
    captured += 1;
    return outcome.value;
  };

  // -- Stage 1: the login page ----------------------------------------------
  const opened = await withTimeout('goto:login', deadline.slice(20_000), () =>
    page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 }),
  );
  if (!opened.ok) {
    errors.push({ where: 'login', reason: opened.timedOut ? 'The login page did not load in time.' : reasonOf(opened.error) });
  }

  atLogin = await sessionDiagnostics(session).catch(() => null);

  // Whether the login form is on screen, decided by the form itself rather than
  // by signals a login page also satisfies.
  const beforeSignIn = await checkAuthentication(page, 1500);
  loginPageObserved = beforeSignIn.loginFormPresent;

  await inspect(loginPageObserved ? 'login' : 'already-signed-in', null);
  record(
    'login_page_confirmed',
    true,
    loginPageObserved
      ? 'The login form is on screen.'
      : `No login form; already signed in${beforeSignIn.marker ? ` (${beforeSignIn.marker})` : ''}.`,
  );

  // -- Stages 2 and 3: sign in, and continue past the session notice --------
  //
  // Untouched on purpose. This path works, and the only thing added around it
  // is the naming of what it did.
  try {
    await ensureAuthenticated(session);
  } catch (error) {
    trace.enter('credentials_submitted', 'submitted, sign-in did not complete');
    record('credentials_submitted', true, 'Submitted, but sign-in did not complete.');
    return failed('authentication', reasonOf(error), error);
  }

  const authTrace = lastAuthenticationTrace(session);

  trace.enter(
    'credentials_submitted',
    authTrace.submittedCredentials ? `outcome ${authTrace.outcome ?? 'unknown'}` : 'session already open',
  );
  record(
    'credentials_submitted',
    true,
    authTrace.submittedCredentials
      ? `Submitted; outcome: ${authTrace.outcome ?? 'unknown'}.`
      : 'A session was already open, so no credentials were submitted.',
  );

  if (authTrace.continuedPastSessionNotice) {
    trace.enter('session_warning_detected', 'another administrator session was open');
    trace.enter('continue_clicked', 'the existing-session form was submitted once');
  }
  record(
    'multiple_session_continued',
    authTrace.continuedPastSessionNotice,
    authTrace.continuedPastSessionNotice
      ? 'Another administrator was signed in; Continue was pressed once.'
      : 'The administrator session notice did not appear.',
  );

  // -- Stage 4: settle, then confirm on four signals ------------------------
  //
  // Settling watches the address, the document and the network, and takes the
  // first that fires. Readymode holds background connections open, so waiting
  // for the network to go quiet can wait for something that never happens.
  trace.enter('post_login_navigation_started');
  const settled = await settleAfterNavigation(page, {
    timeoutMs: deadline.slice(DISCOVERY_LIMITS.settleMs),
  });
  trace.enter(
    'authenticated_page_loaded',
    `settled by ${settled.by} at ${settled.path} in ${settled.durationMs}ms`,
  );

  // The dashboard route is opened before confirming, so the check runs against
  // the interface shell rather than against whatever the login flow landed on.
  //
  // No expected heading is passed. Waiting for one here would be the single
  // hardcoded dashboard selector all over again — and it costs its whole
  // timeout on any account whose dashboard is named something else, before
  // the four-signal check that can actually answer the question has run.
  const toDashboard = await withTimeout('goto:dashboard', deadline.slice(perScreenMs), () =>
    gotoRoute(page, DASHBOARD_ROUTE, [], { navigationMs: 12_000 }),
  );
  if (!toDashboard.ok) {
    errors.push({
      where: 'dashboard',
      reason: toDashboard.timedOut ? 'The dashboard route did not load in time.' : reasonOf(toDashboard.error),
    });
  }

  const confirmation = await withTimeout('confirm:authenticated', deadline.slice(DISCOVERY_LIMITS.confirmMs), () =>
    confirmAuthenticated(page, { loginUrl }),
  );
  authenticationSignals = confirmation.value ?? null;
  dashboardConfirmed = Boolean(authenticationSignals?.authenticated);

  trace.note(
    `authentication signals passed=[${authenticationSignals?.passed.join(', ') ?? 'none'}] ` +
      `failed=[${authenticationSignals?.failed.join(', ') ?? 'unknown'}]`,
  );

  record(
    'authenticated_dashboard_confirmed',
    dashboardConfirmed,
    dashboardConfirmed
      ? `Confirmed by ${authenticationSignals?.passed.join(', ')}.`
      : `Not confirmed; these signals failed: ${authenticationSignals?.failed.join(', ') ?? 'the check itself timed out'}.`,
  );

  if (!dashboardConfirmed) {
    return failed(
      'confirm:authenticated',
      authenticationSignals
        ? `Signing in reported success, but ${authenticationSignals.failed.join(' and ')} after it.`
        : 'Signing in reported success, but confirming the interface timed out.',
    );
  }

  trace.enter('dashboard_confirmed', authenticationSignals?.marker ?? authenticationSignals?.path);

  atCrawl = await sessionDiagnostics(session).catch(() => null);
  sessionUnchanged = !atLogin || !atCrawl || sameSession(atLogin, atCrawl);

  if (!sessionUnchanged) {
    // Never observed — the session is one browser, one context, one page
    // throughout — but asserting it is cheaper than trusting it.
    errors.push({
      where: 'session',
      reason: 'The browser context or page changed between signing in and crawling.',
    });
  }

  record('interface_crawling', true, `Crawling as ${atCrawl?.provider ?? 'unknown'} session.`);

  // -- Stages 5 and 6: read the interface -----------------------------------
  trace.enter('screen_discovery_started', `mode ${mode}, ${deadline.remaining()}ms left`);

  if (mode === 'reduced') {
    // The reduced run stops here on purpose. Reading the navigation structure
    // of the confirmed interface is what proves the authenticated path works;
    // crawling eleven screens is what made it impossible to tell whether it
    // did. Nothing is clicked.
    const started = Date.now();
    const evidence = await inspect('screen:navigation', 'Dashboard');
    if (evidence) {
      visited.push('screen:navigation');
      screensAttempted += 1;
      screensConfirmed += 1;
      trace.screen({
        screen: 'navigation-structure',
        path: authenticationSignals?.path,
        result: 'confirmed',
        durationMs: Date.now() - started,
        detail: `${evidence.roots.length} root(s), ${evidence.roots.reduce((sum, root) => sum + root.nav.length, 0)} navigation label(s)`,
      });
    }

    trace.enter('screen_discovery_finished', `${visited.length} inspected in reduced mode`);
    record('interface_crawled', Boolean(evidence), 'Reduced run: the navigation structure was read; no screens were crawled.');
    record('profile_generated', Boolean(evidence));
    return result();
  }

  for (const target of CRAWL_TARGETS) {
    if (authenticationLostAt) {
      skipped.push({ label: target.label, reason: 'The crawl stopped when the session was lost.' });
      trace.screen({ screen: target.key, result: 'skipped', durationMs: 0, detail: 'session lost' });
      continue;
    }
    if (captured >= maxStops + 2) {
      skipped.push({ label: target.label, reason: 'Capture limit reached.' });
      trace.screen({ screen: target.key, result: 'skipped', durationMs: 0, detail: 'capture limit' });
      continue;
    }
    // Two screens' worth of headroom, so the run always has time to build and
    // return its evidence rather than being cut off holding it.
    if (deadline.remaining() < perScreenMs) {
      skipped.push({ label: target.label, reason: 'The discovery budget ran out before this screen.' });
      trace.screen({ screen: target.key, result: 'skipped', durationMs: 0, detail: 'budget exhausted' });
      continue;
    }

    screensAttempted += 1;
    const visit = await visitWithinBudget(page, target, deadline.slice(perScreenMs));
    panels.push(visit);

    trace.screen({
      screen: target.key,
      path: pathOf(visit.finalUrl),
      result: visit.timedOut
        ? 'timeout'
        : visit.redirectedToLogin
          ? 'failed'
          : visit.confirmed
            ? 'confirmed'
            : visit.captured
              ? 'inspected'
              : 'skipped',
      durationMs: visit.durationMs,
      detail: visit.reason,
    });

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
      if (evidence) {
        visit.rootsInspected = evidence.roots.length;
        visit.observedHeading = visit.observedHeading ?? evidence.panelState;
        visited.push(target.key);
      }
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
    dashboardConfirmed,
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

      if (deadline.remaining() < perScreenMs) {
        result.status = 'blocked';
        result.reason = 'The discovery budget ran out before this workflow.';
        workflows.push(result);
        trace.screen({ screen: `workflow:${probe.key}`, result: 'skipped', durationMs: 0, detail: 'budget exhausted' });
        continue;
      }

      let onPath = true;
      for (const key of probe.path) {
        const target = CRAWL_TARGETS.find((entry) => entry.key === key);
        if (!target) continue;

        const visit = await visitWithinBudget(page, target, deadline.slice(perScreenMs));
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
        const outcome = await withTimeout('open-record', deadline.slice(perScreenMs), () =>
          openFirstRecord(page, ['Account Settings', 'Activity Log', 'User Management'], { timeoutMs: 8000 }),
        );
        if (!outcome.ok || !outcome.value?.opened) {
          result.reason = outcome.value?.reason ?? 'No record could be opened.';
          result.status = 'blocked';
          workflows.push(result);
          continue;
        }
      }

      for (const tab of probe.tabs ?? []) {
        if (!isApprovedPanelLabel(tab)) continue;
        const clicked = await clickPanelLabel(page, tab, deadline.slice(8000));
        if (!clicked.ok) result.reason = clicked.reason;
      }

      if (captured < maxStops + 2) {
        const evidence = await inspect(`workflow:${probe.key}`, null);
        result.status = evidence?.roots.some((root) => !root.error) ? 'discovered' : 'blocked';
        if (evidence) visited.push(`workflow:${probe.key}`);
      }

      workflows.push(result);
    }
  }

  trace.enter(
    'screen_discovery_finished',
    `${screensConfirmed} confirmed, ${trace.screens.skipped} skipped, ${trace.screens.failed} failed`,
  );
  record('profile_generated', crawled);

  return result();
}

/**
 * Clicks a panel label, having first proved it is not an administrative one.
 *
 * The exact allowlist is checked by the caller. This is the second, independent
 * check, and it throws rather than returning false — a state-changing click
 * must not be able to disappear into a `.catch(() => undefined)`.
 */
async function clickPanelLabel(
  page: Page,
  label: string,
  budgetMs: number,
): Promise<{ ok: boolean; reason?: string }> {
  assertNotAdministrative(label);

  const outcome = await withTimeout(`click:${label}`, budgetMs, async () => {
    const found = await findExactLabel(page, label);
    if (!found) return { ok: false, reason: `The "${label}" tab was not uniquely visible.` };
    await found.locator.click({ timeout: 5000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined);
    return { ok: true };
  });

  if (!outcome.ok) {
    return {
      ok: false,
      reason: outcome.timedOut ? `Opening "${label}" took too long.` : reasonOf(outcome.error),
    };
  }

  return outcome.value ?? { ok: false, reason: `The "${label}" tab could not be opened.` };
}

/** One screen, under one hard limit, never fatal to the crawl. */
async function visitWithinBudget(
  page: Page,
  target: CrawlTarget,
  budgetMs: number,
): Promise<PanelVisit> {
  const started = Date.now();
  const outcome = await withTimeout(`screen:${target.key}`, budgetMs, () => visitTarget(page, target));

  if (outcome.ok && outcome.value) {
    return { ...outcome.value, durationMs: Date.now() - started };
  }

  return {
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
    timedOut: outcome.timedOut,
    durationMs: Date.now() - started,
    reason: outcome.timedOut
      ? `The screen used its whole ${budgetMs}ms allowance and was abandoned.`
      : reasonOf(outcome.error),
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
    timedOut: false,
    durationMs: 0,
    reason: target.knownLimitation,
  };

  const result = await gotoRoute(page, target.route, target.expect, {
    timeoutMs: 5000,
    navigationMs: 10_000,
  });

  if (target.tabOf && target.tabLabel && isApprovedPanelLabel(target.tabLabel)) {
    const clicked = await clickPanelLabel(page, target.tabLabel, 8000);
    if (!clicked.ok) visit.reason = clicked.reason;
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

/** Path only. A query string can carry a token. */
function pathOf(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
}

function reasonOf(error: unknown): string {
  return sanitizePageValue(error instanceof Error ? error.message : 'unknown error', 200);
}
