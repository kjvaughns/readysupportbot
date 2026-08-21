import type { Page } from 'playwright-core';
import { sanitizePageValue } from '../../security/sanitize';
import { LOGIN_SUCCESS_CONDITIONS } from '../selectors';
import { anyPresent } from '../selectors/discovery';
import {
  Arrival,
  findExactLabel,
  gotoRoute,
  isApprovedPanelLabel,
  openFirstRecord,
  waitForArrival,
} from '../navigation';
import { DASHBOARD_ROUTE } from '../interface/registry';
import { ReadymodeSession, ensureAuthenticated, lastAuthenticationTrace } from '../session';
import { EVIDENCE_CAPS, InterfaceEvidence, PageEvidence } from './evidence';
import { buildEvidence, inspectCurrentPage } from './inspector';
import {
  CRAWL_TARGETS,
  CrawlTarget,
  DiscoveryStage,
  StageResult,
  WORKFLOW_PROBES,
  WorkflowProbeResult,
  furthestStage,
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
  /** Roots inspected on this screen, so an empty capture is visible. */
  rootsInspected: number;
  reason?: string;
}

export interface WalkResult {
  evidence: InterfaceEvidence;
  stages: StageResult[];
  stageReached: DiscoveryStage | null;
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

  const record = (stage: DiscoveryStage, reached: boolean, detail?: string) => {
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

  const loginPageObserved = !(await anyPresent(page, LOGIN_SUCCESS_CONDITIONS, 1500));
  await inspect(loginPageObserved ? 'login' : 'already-signed-in', null);
  record('login_page_inspected', true, loginPageObserved ? undefined : 'Already signed in.');

  // -- Stage 2 and 3: sign in, and continue past the session notice ---------
  try {
    await ensureAuthenticated(session);
    const trace = lastAuthenticationTrace(session);

    record('credentials_submitted', true, trace.submittedCredentials ? undefined : 'Session already open.');
    record(
      'session_takeover_continued',
      trace.continuedPastSessionNotice,
      trace.continuedPastSessionNotice
        ? 'Another administrator was signed in; Continue was pressed once.'
        : 'The administrator session notice did not appear.',
    );
  } catch (error) {
    record('credentials_submitted', false, reasonOf(error));
    record('session_takeover_continued', false);
    record('authenticated', false, 'Sign-in did not complete.');
    errors.push({ where: 'authentication', reason: reasonOf(error) });

    // Without a session there is nothing to crawl, and a profile built from the
    // login page alone is the failure this whole rewrite is about. Return what
    // was seen and let the caller refuse to publish it.
    return {
      evidence: buildEvidence(loginUrl, pages, counters),
      stages,
      stageReached: furthestStage(stages),
      dashboardConfirmed: false,
      continuedPastSessionNotice: false,
      panels,
      workflows,
      visited,
      skipped,
      errors,
      loginPageObserved,
    };
  }

  const trace = lastAuthenticationTrace(session);

  // -- Stage 4: confirm the authenticated interface -------------------------
  const dashboard = await gotoRoute(page, DASHBOARD_ROUTE, ['Dashboard'], { timeoutMs: 8000 });
  const signedIn =
    dashboard.opened || (await anyPresent(page, LOGIN_SUCCESS_CONDITIONS, 3000));

  record(
    'authenticated',
    signedIn,
    signedIn
      ? `Confirmed by ${dashboard.opened ? 'the Dashboard' : 'an authenticated navigation signal'}.`
      : 'Neither the Dashboard nor any authenticated signal could be confirmed.',
  );

  if (!signedIn) {
    errors.push({
      where: 'authentication',
      reason: 'Signed in without error, but no authenticated screen could be confirmed.',
    });
  }

  // -- Stage 5 and 6: crawl every screen, inspecting each one ---------------
  const reached = new Set<string>();

  for (const target of CRAWL_TARGETS) {
    if (captured >= maxStops + 2) {
      skipped.push({ label: target.label, reason: 'Capture limit reached.' });
      continue;
    }

    const visit = await visitTarget(page, target);
    panels.push(visit);

    if (visit.confirmed || visit.captured) reached.add(target.key);

    if (visit.captured) {
      const evidence = await inspect(`screen:${target.key}`, target.expect[0] ?? null);
      visit.rootsInspected = evidence.roots.length;
      visit.observedHeading = visit.observedHeading ?? evidence.panelState;
      visited.push(target.key);
    } else {
      skipped.push({ label: target.label, reason: visit.reason ?? 'The screen could not be reached.' });
    }
  }

  record('interface_crawled', visited.length > 0, `${visited.length} screen(s) inspected.`);

  // -- Workflows -------------------------------------------------------------
  if (!options.skipWorkflows && signedIn) {
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

  record('profile_generated', signedIn && visited.length > 0);

  return {
    evidence: buildEvidence(loginUrl, pages, counters),
    stages,
    stageReached: furthestStage(stages),
    dashboardConfirmed: signedIn,
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
