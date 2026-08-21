/* eslint-disable no-console -- Deliberate, temporary deployment diagnostics.
 *
 * These go to stdout rather than through the structured logger so they are
 * visible in a platform's raw log tail with no log level and no JSON viewer.
 * They exist to settle one question — is the deployed build running the current
 * authentication code — and none of them prints a credential, a cookie, a
 * token, a name, or any page content. Remove them once the deployment is
 * confirmed and `AUTH_FLOW_VERSION` has served its purpose.
 */
import type { Page } from 'playwright-core';
import { recordEvent } from '../audit';
import { logger } from '../security/logger';
import { sanitizePageValue } from '../security/sanitize';
import { withoutPersonalData } from '../security/personalData';
import { HUMAN_VERIFICATION_CONDITIONS } from './selectors';
import { checkAuthentication, waitForAuthenticated } from './authState';
import { submitExistingSessionForm } from './continueSubmit';
import { anyPresent } from './selectors/discovery';
import { allText, listSearchRoots } from './selectors/frames';
import {
  InterstitialButton,
  InterstitialClassification,
  InterstitialSnapshot,
  classifyInterstitial,
} from './interstitial';
import type { ReadymodeSession } from './session';

/**
 * Acting on the administrator session notice.
 *
 * The decision itself lives in `interstitial.ts` and is pure. This module only
 * gathers the snapshot, enforces the guards, and clicks at most once.
 */

/** One attempt per session, ever. Set before the click, so a throw still burns it. */
const attempted = new WeakSet<ReadymodeSession>();

/** Test seam. */
export function resetTakeoverGuard(session: ReadymodeSession): void {
  attempted.delete(session);
}

const MAX_BUTTONS_READ = 40;

/** Reads the page without touching it. */
export async function captureInterstitial(page: Page): Promise<InterstitialSnapshot> {
  const buttons: InterstitialButton[] = [];

  for (const root of listSearchRoots(page)) {
    let locator;
    try {
      locator = root.locator(
        'button, input[type="submit"], input[type="button"], [role="button"], a.btn, a.button',
      );
    } catch {
      continue;
    }

    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < Math.min(count, MAX_BUTTONS_READ); index += 1) {
      const element = locator.nth(index);
      const label =
        (await element.innerText().catch(() => '')) ||
        // A submit button's `value` is its label, not user data.
        (await element.getAttribute('value').catch(() => '')) ||
        '';
      buttons.push({
        label: sanitizePageValue(label, 80),
        visible: await element.isVisible().catch(() => false),
      });
    }
  }

  let host = '';
  try {
    host = new URL(page.url()).host;
  } catch {
    host = '';
  }

  const bodyText = withoutPersonalData(sanitizePageValue(await allText(page), 4000));

  return {
    url: sanitizePageValue(page.url(), 300),
    host,
    title: withoutPersonalData(sanitizePageValue(await page.title().catch(() => ''), 200)),
    bodyText,
    buttons,
    hasPasswordField: await hasPasswordField(page),
    hasCaptcha: await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 800),
    // The signed-in shell, not merely something a page might have. The old
    // check matched a nav element, which a login page also carries, so a login
    // page could read as "the dashboard is present".
    dashboardSignalPresent: (await checkAuthentication(page, 800)).authenticated,
  };
}

async function hasPasswordField(page: Page): Promise<boolean> {
  for (const root of listSearchRoots(page)) {
    const count = await root
      .locator('input[type="password"]')
      .count()
      .catch(() => 0);
    if (count > 0) return true;
  }
  return false;
}

export interface TakeoverOutcome {
  classification: InterstitialClassification;
  clicked: boolean;
  dashboardVerified: boolean;
  explanation: string;
}

/**
 * Inspects whatever Readymode is showing and, only for the administrator
 * session notice, clicks Continue exactly once.
 */
export async function handleInterstitial(
  session: ReadymodeSession,
  expectedHost: string,
): Promise<TakeoverOutcome> {
  const { page } = session;

  if (attempted.has(session)) {
    return {
      classification: 'unknown',
      clicked: false,
      dashboardVerified: false,
      explanation: 'The session notice was already handled once in this session.',
    };
  }

  const snapshot = await captureInterstitial(page);
  const verdict = classifyInterstitial(snapshot);

  // Nine of the ten classifications leave here without touching anything.
  if (!verdict.mayClickContinue) {
    return {
      classification: verdict.classification,
      clicked: false,
      dashboardVerified: snapshot.dashboardSignalPresent,
      explanation: verdict.explanation,
    };
  }

  // Exact host equality — a lookalike domain must not satisfy this.
  if (!expectedHost || snapshot.host !== expectedHost) {
    logger.warn(
      { expectedHost, actualHost: snapshot.host },
      'Refusing to continue: the notice is not on the configured Readymode domain',
    );
    return {
      classification: 'unknown',
      clicked: false,
      dashboardVerified: false,
      explanation: 'The notice was not on the configured Readymode domain, so it was not actioned.',
    };
  }

  await recordEvent({
    organizationId: session.organizationId,
    type: 'readymode.existing_session_warning_found',
    message: 'Readymode reported that this administrator is already signed in elsewhere.',
    data: { host: snapshot.host, matched: verdict.matched },
  });

  // Every plausible shape of the control, in order. The notice renders it as a
  // purple control whose element type is not guaranteed — a button, a link
  // styled as one, or a submit input — and matching only <button> is why it was
  // never clicked.
  console.log('[Readymode Auth] existing_session_warning_found');

  await recordEvent({
    organizationId: session.organizationId,
    type: 'readymode.existing_session_warning_found',
    message: 'Readymode reported that this administrator is already signed in elsewhere.',
    data: { host: snapshot.host, matched: verdict.matched },
  });

  // Burn the attempt before acting: a submission that throws must not be retried.
  attempted.add(session);

  /**
   * Submit the form rather than click the control.
   *
   * The notice is the login form re-rendered with `logout_other_sessions`
   * already set to `on`, and Continue is an `<input type="submit">` inside it.
   * The page is asking for a POST, not a mouse event — and a click has four
   * ways to fail at something the form can simply be asked to do.
   */
  const submission = await submitExistingSessionForm(page);

  await recordEvent({
    organizationId: session.organizationId,
    type: 'readymode.continue_control_found',
    message: submission.formFound
      ? `The existing-session form was found (${submission.formMethod ?? 'unknown'} to ${submission.formActionPath ?? 'the same path'}).`
      : 'No form containing the Continue control was found.',
    data: {
      formFound: submission.formFound,
      // Field names only. One of them holds the password; its value is never
      // read, logged or stored.
      hiddenFields: submission.hiddenFieldNames,
      attempts: submission.attempts.map((attempt) => attempt.method),
    },
  });

  if (!submission.attempted) {
    return {
      classification: 'unknown',
      clicked: false,
      dashboardVerified: false,
      explanation: submission.error ?? 'The existing-session form could not be found.',
    };
  }

  console.log('[Readymode Auth] continue submitted', {
    method: submission.method,
    authenticated: submission.authenticated,
  });

  await recordEvent({
    organizationId: session.organizationId,
    type: 'readymode.continue_clicked',
    message: submission.method
      ? `The existing-session form was submitted via ${submission.method}.`
      : 'Every way of submitting the existing-session form failed.',
    data: {
      method: submission.method,
      attempts: submission.attempts,
    },
  });

  // A verification prompt appearing after the click is still never solved.
  if (await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 1500)) {
    return {
      classification: 'human_verification',
      clicked: true,
      dashboardVerified: false,
      explanation: 'Readymode asked for human verification after continuing.',
    };
  }

  // After pressing Continue, the dashboard has to be proved by the signed-in
  // shell. A page still showing the login form never counts, however long it is
  // waited for.
  // The submission already waited for and confirmed the signed-in shell.
  const confirmation = submission.authenticated
    ? { authenticated: true, marker: submission.authenticatedMarker }
    : await waitForAuthenticated(page, 15_000);
  const dashboardVerified = confirmation.authenticated;

  console.log(`[Readymode Auth] dashboard confirmed=${dashboardVerified} marker=${confirmation.marker ?? 'none'}`);

  if (dashboardVerified) {
    await recordEvent({
      organizationId: session.organizationId,
      type: 'readymode.authenticated_dashboard_confirmed',
      message: `The authenticated interface was confirmed by the ${confirmation.marker}.`,
      data: { marker: confirmation.marker },
    });
  }

  return {
    classification: 'admin_session_takeover',
    clicked: submission.submitted,
    dashboardVerified,
    explanation: dashboardVerified
      ? 'Continued past the administrator session notice and reached the dashboard.'
      : 'Continued past the administrator session notice, but the dashboard was not confirmed.',
  };
}
