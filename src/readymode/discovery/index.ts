import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { logger } from '../../security/logger';
import { InterfaceProfileWithSelectors } from '../../database/store';
import { ALL_CONTROLS, LOGIN_CONTROLS } from '../selectors';
import { serializeStrategy } from '../selectors/serialize';
import { invalidateProfileCache } from '../selectors/resolve';
import { ReadymodeSession } from '../session';
import { resolveCredentials } from '../credentials';
import { InterfaceEvidence, rootStats } from './evidence';
import { PanelVisit, discoverInterface } from './walk';
import { DiscoveryState, StageResult, WorkflowProbeResult } from './stages';
import { ReadinessAssessment, assessReadiness, controlsWithoutMatchers } from './readiness';
import { WorkflowReport } from './trace';
import { AuthenticationSignals } from '../authState';
import { CONTROL_MATCHERS, ProposedSelector, proposeSelectors, promotable } from './propose';
import { AppError } from '../../security/errors';

export * from './evidence';
export * from './propose';
export * from './walk';
export * from './stages';
export * from './readiness';
export { inspectCurrentPage, buildEvidence } from './inspector';

/**
 * Interface discovery, end to end.
 *
 * Signs in, walks the real interface read-only, records what is there, proposes
 * selectors that the evidence can justify, and stores the result as a *proposed*
 * profile. Nothing is used for automation until an Owner approves it.
 */

export interface DiscoveryRunResult {
  profile: InterfaceProfileWithSelectors;
  /**
   * The run as a finite-state workflow: every transition timestamped, the
   * operation that was in flight if it stopped badly, and the screen counts.
   *
   * This is the answer to "where did it stop", which a platform timeout can
   * never give.
   */
  workflow: WorkflowReport;
  /** Which of the four authentication signals passed, and which did not. */
  authenticationSignals: AuthenticationSignals | null;
  mode: 'reduced' | 'full';
  /** True when the run finished inside its own budget. */
  withinBudget: boolean;
  /** Whether a profile was written, which happens even when screens failed. */
  profileSaved: boolean;
  visited: string[];
  skipped: Array<{ label: string; reason: string }>;
  /** Every screen the walk tried, with the heading it expected and the one it got. */
  panels: PanelVisit[];
  /** Every stage, in order, and whether it was reached. */
  stages: StageResult[];
  stageReached: DiscoveryState | null;
  dashboardConfirmed: boolean;
  continuedPastSessionNotice: boolean;
  /**
   * Counted honestly. Twelve captures of the same login redirect is one page
   * seen twelve times, not twelve pages.
   */
  totals: {
    uniqueAuthenticatedPages: number;
    loginRedirects: number;
    framesInspected: number;
    screensConfirmed: number;
    screensAttempted: number;
    screensSkipped: number;
    screensFailed: number;
    durationMs: number;
  };
  session: { atLogin: unknown; atCrawl: unknown; same: boolean };
  authentication: {
    outcome: string | null;
    marker: string | null;
    urlAfterSubmit: string | null;
    urlAfterContinue: string | null;
  };
  authenticationLostAt: string | null;
  workflows: WorkflowProbeResult[];
  /** Whether the profile may be reviewed at all, and why not when it may not. */
  readiness: ReadinessAssessment;
  /** Controls with no evidence matcher, which no run could ever resolve. */
  controlsWithoutMatchers: string[];
  errors: Array<{ where: string; reason: string }>;
  proposals: ProposedSelector[];
  unproposed: Array<{ control: string; reason: string }>;
  /** Present in the evidence but not uniquely identifiable. */
  ambiguous: Array<{ control: string; reason: string }>;
  /** Nothing matched at all. */
  unresolved: Array<{ control: string; reason: string }>;
  notObservable: Array<{ control: string; reason: string }>;
  loginPageObserved: boolean;
  roots: { total: number; failed: number; succeeded: number };
  evidenceSummary: {
    pages: number;
    roots: number;
    personalDataDropped: number;
    passwordFieldsSeen: number;
    truncatedCategories: string[];
  };
}

/** Guesses which Readymode interface this organization uses, from evidence only. */
export function detectInterfaceVersion(evidence: InterfaceEvidence): 'starter' | 'iq' | 'unknown' {
  const haystack = evidence.pages
    .flatMap((page) => [
      page.pageTitle,
      ...page.roots.flatMap((root) => [root.title, ...root.nav.map((entry) => entry.label)]),
    ])
    .join(' ')
    .toLowerCase();

  // Only claim iQ when the interface says so. Everything else stays unknown
  // rather than being asserted as Starter.
  if (/\breadymode\s*iq\b|\biq\s+dashboard\b|autopilot|local presence/.test(haystack)) return 'iq';
  if (/\breadymode\b/.test(haystack)) return 'starter';
  return 'unknown';
}

export async function runDiscovery(input: {
  session: ReadymodeSession;
  organizationId: string;
  discoveredBy: string | null;
  maxStops?: number;
  /**
   * `reduced` — the default — signs in, confirms the interface, reads the
   * navigation structure and saves. Crawling every administrative screen is
   * `full`, and is only worth running once the reduced path is fast.
   */
  mode?: 'reduced' | 'full';
  totalMs?: number;
}): Promise<DiscoveryRunResult> {
  const credentials = await resolveCredentials(input.organizationId);
  const mode = input.mode ?? 'reduced';

  const walk = await discoverInterface(input.session, credentials.loginUrl, {
    maxStops: input.maxStops,
    mode,
    totalMs: input.totalMs,
  });

  const roots = rootStats(walk.evidence);

  // Every root failing means the evidence is empty for a mechanical reason, not
  // because the interface is bare. Creating a profile from it would record
  // "nothing found" as though it were an observation.
  if (roots.total > 0 && roots.succeeded === 0) {
    const firstError = walk.evidence.pages
      .flatMap((page) => page.roots)
      .find((root) => root.error)?.error;

    throw new AppError(
      'discovery_collected_nothing',
      `Interface discovery could not read any page: all ${roots.total} frame(s) failed. ` +
        `No profile was created.${firstError ? ` First error: ${firstError}` : ''}`,
      502,
      { rootsInspected: roots.total },
    );
  }

  // Controls that were never on screen are reported as such rather than as
  // missing: an already signed-in session simply never shows the login form.
  const skip: Record<string, string> = {};
  if (!walk.loginPageObserved) {
    for (const control of Object.values(LOGIN_CONTROLS)) {
      skip[control.name] =
        'Not observable in this run: the session was already signed in, so the login page never appeared.';
    }
  }

  const { proposals, unproposed, ambiguous, unresolved, withoutMatchers, notObservable } =
    proposeSelectors(walk.evidence, ALL_CONTROLS, { skip });
  const usable = proposals.filter(promotable);

  const screensInspected = walk.evidence.pages.filter((page) =>
    page.step.startsWith('screen:'),
  ).length;

  const readiness = assessReadiness({
    proposals,
    workflows: walk.workflows,
    dashboardConfirmed: walk.dashboardConfirmed,
    // Screens actually confirmed while signed in. A login redirect captured
    // under a screen's name is not that screen.
    screensInspected: walk.screensConfirmed,
    mode,
  });

  const missingMatchers = withoutMatchers.length
    ? withoutMatchers.map((entry) => entry.control)
    : controlsWithoutMatchers(new Set(CONTROL_MATCHERS.map((matcher) => matcher.control)));

  logger.info(
    {
      organizationId: input.organizationId,
      pages: walk.evidence.pages.length,
      rootsInspected: roots.total,
      rootsFailed: roots.failed,
      proposed: proposals.length,
      usable: usable.length,
      unproposed: unproposed.length,
      notObservable: notObservable.length,
      loginPageObserved: walk.loginPageObserved,
    },
    'Interface discovery completed',
  );

  const profile = await getStore().createInterfaceProfile({
    profile: {
      organizationId: input.organizationId,
      // A run that never reached the interface is stored as incomplete, so it
      // cannot be presented for approval however many login controls it found.
      status: readiness.readiness === 'ready_for_review' ? 'ready_for_review' : 'incomplete',
      schemaVersion: 1,
      baseUrl: walk.evidence.baseUrl,
      interfaceVersion: detectInterfaceVersion(walk.evidence),
      pagesCaptured: walk.evidence.pages.length,
      controlsTotal: ALL_CONTROLS.length,
      controlsProposed: usable.length,
      capabilities: [],
      // Both kinds are stored, flagged, so the reason a control is absent
      // survives into the record rather than being flattened to "missing".
      unproposed: [
        ...unproposed.map((entry) => ({ ...entry, notObservable: false })),
        ...notObservable.map((entry) => ({ ...entry, notObservable: true })),
      ],
      screenshotPaths: walk.evidence.pages
        .map((page) => page.screenshotPath)
        .filter((path): path is string => Boolean(path)),
      discoveredBy: input.discoveredBy,
      discoveredAt: new Date().toISOString(),
      notes: null,
    },
    selectors: proposals.map((proposal) => ({
      organizationId: input.organizationId,
      controlName: proposal.control,
      strategy: serializeStrategy(proposal.strategy),
      tier: proposal.tier,
      confidence: proposal.confidence,
      rootName: proposal.rootName,
      rootUrl: proposal.rootUrl,
      evidenceRef: {
        page: proposal.pageStep,
        category: proposal.evidence.category,
        ordinal: proposal.evidence.ordinal,
        excerpt: proposal.evidence.excerpt,
      },
      // "Verified" here means the evidence identifies exactly one element and
      // the proposal is strong enough to be used. It is not a claim that the
      // workflow has been run.
      verified: promotable(proposal),
      verifiedMatches: 1,
    })),
    evidence: walk.evidence,
  });

  walk.trace.enter('profile_saved', `${profile.id} as ${profile.status}`);

  await recordEvent({
    organizationId: input.organizationId,
    type: 'readymode.interface_discovered',
    message:
      `Interface discovery reached ${walk.stageReached ?? 'no stage'}, inspected ${screensInspected} ` +
      `administrative screen(s), and proposed ${usable.length} of ${ALL_CONTROLS.length} controls. ` +
      `Readiness: ${readiness.readiness}.`,
    data: {
      profileId: profile.id,
      visited: walk.visited,
      readiness: readiness.readiness,
      stageReached: walk.stageReached,
      panels: walk.panels.map((panel) => ({
        screen: panel.key,
        expected: panel.expectedHeading,
        observed: panel.observedHeading,
        confirmed: panel.confirmed,
      })),
      unproposed: unproposed.map((entry) => entry.control),
    },
  });

  invalidateProfileCache(input.organizationId);
  walk.trace.enter('response_returned');

  return {
    profile,
    workflow: walk.trace.report(),
    authenticationSignals: walk.authenticationSignals,
    mode: walk.mode,
    withinBudget: walk.withinBudget,
    profileSaved: true,
    visited: walk.visited,
    skipped: walk.skipped,
    panels: walk.panels,
    stages: walk.stages,
    stageReached: walk.stageReached,
    dashboardConfirmed: walk.dashboardConfirmed,
    continuedPastSessionNotice: walk.continuedPastSessionNotice,
    totals: {
      uniqueAuthenticatedPages: walk.uniqueAuthenticatedPages,
      loginRedirects: walk.loginRedirects,
      framesInspected: walk.evidence.pages.reduce((sum, entry) => sum + entry.roots.length, 0),
      screensConfirmed: walk.screensConfirmed,
      screensAttempted: walk.screensAttempted,
      screensSkipped: walk.screensSkipped,
      screensFailed: walk.screensFailed,
      durationMs: walk.workflow.totalMs,
    },
    session: walk.session,
    authentication: walk.authentication,
    authenticationLostAt: walk.authenticationLostAt,
    workflows: walk.workflows,
    readiness,
    controlsWithoutMatchers: missingMatchers,
    errors: walk.errors,
    proposals,
    unproposed,
    ambiguous,
    unresolved,
    notObservable,
    loginPageObserved: walk.loginPageObserved,
    roots,
    evidenceSummary: {
      pages: walk.evidence.pages.length,
      roots: walk.evidence.pages.reduce((sum, page) => sum + page.roots.length, 0),
      personalDataDropped: walk.evidence.redactions.personalDataDropped,
      passwordFieldsSeen: walk.evidence.redactions.passwordFieldsSeen,
      truncatedCategories: walk.evidence.redactions.truncatedCategories,
    },
  };
}
