/* eslint-disable no-console -- Deliberate, temporary deployment diagnostics.
 *
 * These go to stdout rather than through the structured logger so they are
 * visible in a platform's raw log tail with no log level and no JSON viewer.
 * They answer one question — what exactly happens when Continue is clicked —
 * and none of them prints a credential, a cookie, a token, a name, or any page
 * content. Remove them once the click is proven.
 */
import type { Frame, Locator, Page } from 'playwright-core';
import { AUTH_FLOW_VERSION, buildInfo } from '../buildInfo';
import { logger } from '../security/logger';
import { sanitizePageValue } from '../security/sanitize';
import { HUMAN_VERIFICATION_CONDITIONS } from './selectors';
import { anyPresent } from './selectors/discovery';
import { checkAuthentication, sessionDiagnostics, waitForAuthenticated } from './authState';
import {
  ContinueCandidateMetadata,
  collectContinueCandidates,
} from './continueCandidates.browser';
import { submitExistingSessionForm } from './continueSubmit';
import { ReadymodeSession, ensureAuthenticated, lastAuthenticationTrace } from './session';

/**
 * One question, answered without anything else in the way: what happens when
 * Continue is clicked?
 *
 * No discovery, no crawl, no selector registry. Every frame is searched, every
 * candidate is described, the exact element is clicked, and the click's error —
 * if there is one — is reported rather than swallowed. Navigation requests and
 * responses are recorded so "the click did nothing" can be told apart from
 * "Readymode refused it".
 *
 * Everything returned is structural: paths, status codes, element shapes, and
 * whether three markers are visible.
 */

/** What the click actually did. Exactly one of these is true of any run. */
export type ProbeOutcome =
  /** Nothing anywhere matched the label. The control is elsewhere, or absent. */
  | 'no_candidate'
  /** Matched, but nothing visible to click. */
  | 'candidate_not_visible'
  /** The click threw: intercepted, detached, or blocked. */
  | 'click_threw'
  /** Clicked, and the page never asked for anything. Wrong element. */
  | 'clicked_no_navigation'
  /** Readymode answered and left the notice up. It refused the continuation. */
  | 'navigated_but_continue_remains'
  /** The shell is there but the confirmation logic disagreed. */
  | 'dashboard_but_not_confirmed'
  /** Signed in. */
  | 'authenticated'
  /** The notice never appeared: nothing to click. */
  | 'no_notice'
  /** A captcha was on screen, so nothing was clicked. */
  | 'refused_human_verification';

export interface NavigationRecord {
  kind: 'request' | 'response';
  method?: string;
  status?: number;
  /** Path only: a query string can carry a token. */
  path: string;
}

export interface AuthProbeResult {
  authFlowVersion: string;
  commitSha: string;
  commitShort: string;
  session: Awaited<ReturnType<typeof sessionDiagnostics>> | null;
  loginOutcome: string | null;
  /** True when the normal authentication path already handled the notice. */
  continuedByAuthFlow: boolean;

  /** Every Continue-labelled control found, in every frame. */
  candidates: Array<ContinueCandidateMetadata & { frameName: string }>;
  candidateCount: number;
  /** The one that was clicked, when one was. */
  chosen: (ContinueCandidateMetadata & { frameName: string }) | null;
  /** How the exact element was addressed. */
  chosenLocator: string | null;

  beforeClick: { count: number; visible: boolean; enabled: boolean } | null;
  clickCompleted: boolean;
  /** The click's own error. Reported, never suppressed. */
  clickError: string | null;

  /** Navigation the click caused, if any. Paths and statuses only. */
  navigations: NavigationRecord[];

  afterPath: string;
  pageTitle: string;
  continueStillVisible: boolean;
  dashboardVisible: boolean;
  licenseUsageVisible: boolean;
  authenticated: boolean;
  authenticatedMarker: string | null;

  outcome: ProbeOutcome;
  explanation: string;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return sanitizePageValue(url, 120);
  }
}

function frameName(frame: Frame, index: number): string {
  const name = frame.name();
  if (index === 0) return 'main document';
  return name ? `frame "${name}"` : `frame #${index}`;
}

/** Every Continue-labelled control, in every frame, described structurally. */
export async function findContinueCandidates(
  page: Page,
): Promise<Array<ContinueCandidateMetadata & { frameName: string }>> {
  const found: Array<ContinueCandidateMetadata & { frameName: string }> = [];

  const frames = page.frames();
  for (const [index, frame] of frames.entries()) {
    let metadata: ContinueCandidateMetadata[] = [];
    try {
      metadata = await frame.evaluate(collectContinueCandidates);
    } catch (error) {
      logger.debug({ frame: index, err: error }, 'A frame could not be searched for Continue');
      continue;
    }

    for (const entry of metadata) {
      const candidate = { ...entry, frameName: frameName(frame, index) };
      found.push(candidate);
      console.log('[Readymode Auth] Continue candidate', candidate);
    }
  }

  return found;
}

/**
 * Addresses one candidate exactly.
 *
 * The label lives in different places depending on the element: an input's is
 * its `value` attribute, everything else's is its text. `hasText` does not see
 * a `value`, so an input has to be addressed by attribute or nothing will
 * match — the mistake that would look identical to "no Continue on the page".
 */
function locatorForCandidate(
  root: Page | Frame,
  candidate: ContinueCandidateMetadata,
): { locator: Locator; description: string } {
  if (candidate.id) {
    return { locator: root.locator(`#${CSS_escape(candidate.id)}`), description: `#${candidate.id}` };
  }

  if (candidate.tag === 'input') {
    const type = candidate.type ?? 'submit';
    const selector = `input[type="${type}"][value="Continue" i]`;
    return { locator: root.locator(selector), description: selector };
  }

  const selector = 'button, input[type="submit"], input[type="button"], a, [role="button"]';
  return {
    locator: root.locator(selector).filter({ hasText: /^\s*Continue\s*$/i }),
    description: `${candidate.tag}:has-text("Continue")`,
  };
}

/** Minimal CSS.escape for ids, since this runs in Node. */
function CSS_escape(value: string): string {
  return value.replace(/([^\w-])/g, '\\$1');
}

export async function runAuthProbe(session: ReadymodeSession): Promise<AuthProbeResult> {
  const { page } = session;
  const build = buildInfo();

  console.log(`[Readymode Auth] probe start version=${AUTH_FLOW_VERSION} commit=${build.commitShort}`);

  // Navigation only, and only its shape: method, status, path. No bodies, no
  // headers, no query strings.
  const navigations: NavigationRecord[] = [];
  const onRequest = (request: { isNavigationRequest(): boolean; method(): string; url(): string }) => {
    if (!request.isNavigationRequest()) return;
    const record: NavigationRecord = {
      kind: 'request',
      method: request.method(),
      path: pathOf(request.url()),
    };
    navigations.push(record);
    console.log('[Readymode Auth] navigation request', record);
  };
  const onResponse = (response: {
    request(): { isNavigationRequest(): boolean };
    status(): number;
    url(): string;
  }) => {
    if (!response.request().isNavigationRequest()) return;
    const record: NavigationRecord = {
      kind: 'response',
      status: response.status(),
      path: pathOf(response.url()),
    };
    navigations.push(record);
    console.log('[Readymode Auth] navigation response', record);
  };

  page.on('request', onRequest as never);
  page.on('response', onResponse as never);

  let loginError: string | null = null;
  try {
    await ensureAuthenticated(session);
  } catch (error) {
    // A failure is a result. The point is to see what is on screen.
    loginError = sanitizePageValue(error instanceof Error ? error.message : 'unknown', 200);
    logger.warn({ reason: loginError }, 'Auth probe: signing in did not complete');
  }

  const trace = lastAuthenticationTrace(session);
  await page.waitForTimeout(1500).catch(() => undefined);

  const candidates = await findContinueCandidates(page);
  const clickable = candidates.find((candidate) => candidate.visible && !candidate.disabled);

  const finish = async (
    outcome: ProbeOutcome,
    explanation: string,
    extra: Partial<AuthProbeResult> = {},
  ): Promise<AuthProbeResult> => {
    page.off('request', onRequest as never);
    page.off('response', onResponse as never);

    const confirmed = await checkAuthentication(page, 1500);
    const dashboardVisible = await page
      .locator('#hotbar_search, #CCS_Session_Statebox')
      .first()
      .isVisible()
      .catch(() => false);
    const licenseUsageVisible = await page
      .getByText(/^\s*License Usage\s*$/i)
      .first()
      .isVisible()
      .catch(() => false);
    const continueStillVisible = (await findContinueCandidates(page)).some(
      (candidate) => candidate.visible,
    );

    const result: AuthProbeResult = {
      authFlowVersion: AUTH_FLOW_VERSION,
      commitSha: build.commitSha,
      commitShort: build.commitShort,
      session: await sessionDiagnostics(session).catch(() => null),
      loginOutcome: loginError ? `error: ${loginError}` : trace.outcome,
      continuedByAuthFlow: trace.continuedPastSessionNotice,
      candidates,
      candidateCount: candidates.length,
      chosen: clickable ?? null,
      chosenLocator: null,
      beforeClick: null,
      clickCompleted: false,
      clickError: null,
      navigations,
      afterPath: pathOf(page.url()),
      pageTitle: sanitizePageValue(await page.title().catch(() => ''), 200),
      continueStillVisible,
      dashboardVisible,
      licenseUsageVisible,
      authenticated: confirmed.authenticated,
      authenticatedMarker: confirmed.marker,
      outcome,
      explanation,
      ...extra,
    };

    console.log('[Readymode Auth] after click', {
      path: result.afterPath,
      continueStillVisible: result.continueStillVisible,
      dashboardVisible: result.dashboardVisible,
      licenseUsageVisible: result.licenseUsageVisible,
      outcome: result.outcome,
    });

    return result;
  };

  if (candidates.length === 0) {
    const already = await checkAuthentication(page, 1500);
    return already.authenticated
      ? finish('no_notice', 'Signed in without the existing-session notice appearing.')
      : finish(
          'no_candidate',
          'No control labelled exactly "Continue" exists in any frame. Either the notice is not on screen, or its control carries a different label.',
        );
  }

  if (!clickable) {
    return finish(
      'candidate_not_visible',
      `${candidates.length} Continue-labelled control(s) exist, but none is both visible and enabled.`,
    );
  }

  // The one guard kept even here. A Continue beside a captcha is a captcha, and
  // forcing it would be attempting to defeat human verification.
  if (await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 1000)) {
    console.log('[Readymode Auth] refusing: human verification on screen');
    return finish(
      'refused_human_verification',
      'Human verification is on screen, so Continue was not pressed.',
    );
  }

  const frames = page.frames();
  const targetFrame =
    frames.find((frame, index) => frameName(frame, index) === clickable.frameName) ?? page.mainFrame();
  const root = targetFrame === page.mainFrame() ? page : targetFrame;
  const { locator, description } = locatorForCandidate(root, clickable);
  const target = locator.first();

  const beforeClick = {
    count: await target.count().catch(() => 0),
    visible: await target.isVisible().catch(() => false),
    enabled: await target.isEnabled().catch(() => false),
  };
  console.log('[Readymode Auth] before click', { ...beforeClick, locator: description });

  const navigationsBefore = navigations.length;

  /**
   * Submit the form rather than click the control.
   *
   * The notice is the login form re-rendered with `logout_other_sessions`
   * already set, and Continue is an `<input type="submit">` inside it. Asking
   * the form to submit is a direct statement of what the page wants, and it
   * cannot be defeated by an overlay or an off-screen rectangle.
   */
  const submission = await submitExistingSessionForm(page);

  if (!submission.submitted && submission.error && submission.attempts.every((a) => a.error)) {
    const firstError = submission.attempts.find((attempt) => attempt.error)?.error ?? submission.error;
    return finish('click_threw', `Submitting ${description} failed: ${firstError}`, {
      chosenLocator: description,
      beforeClick,
      clickError: firstError,
    });
  }

  await page.waitForTimeout(3000).catch(() => undefined);

  const navigated = navigations.length > navigationsBefore;
  const confirmed = await waitForAuthenticated(page, 15_000);
  const stillVisible = (await findContinueCandidates(page)).some((candidate) => candidate.visible);

  const shared = { chosenLocator: description, beforeClick, clickCompleted: true, clickError: null };

  if (confirmed.authenticated) {
    return finish(
      'authenticated',
      `The existing-session form was submitted via ${submission.method ?? 'an unknown method'}. ` +
        `Confirmed by the ${confirmed.marker}.`,
      shared,
    );
  }

  if (!navigated) {
    return finish(
      'clicked_no_navigation',
      `The click on ${description} completed and the page requested nothing. The element that was clicked is not the one that submits the notice.`,
      shared,
    );
  }

  if (stillVisible) {
    const lastResponse = [...navigations].reverse().find((entry) => entry.kind === 'response');
    return finish(
      'navigated_but_continue_remains',
      `Readymode answered ${lastResponse?.status ?? 'a navigation'} and left the notice up, so it refused the continuation.`,
      shared,
    );
  }

  const dashboard = await page
    .locator('#hotbar_search, #CCS_Session_Statebox')
    .first()
    .isVisible()
    .catch(() => false);

  return dashboard
    ? finish(
        'dashboard_but_not_confirmed',
        'The signed-in shell is on screen but the confirmation check disagreed, so the confirmation logic is wrong.',
        shared,
      )
    : finish(
        'navigated_but_continue_remains',
        'The notice is gone and the shell is not there either, so the continuation did not land on the interface.',
        shared,
      );
}
