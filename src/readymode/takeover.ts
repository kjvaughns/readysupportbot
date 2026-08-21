import type { Page } from 'playwright-core';
import { recordEvent } from '../audit';
import { logger } from '../security/logger';
import { sanitizePageValue } from '../security/sanitize';
import { withoutPersonalData } from '../security/personalData';
import { HUMAN_VERIFICATION_CONDITIONS, TAKEOVER_CONTROLS } from './selectors';
import { checkAuthentication } from './authState';
import { anyPresent, tryDiscover } from './selectors/discovery';
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

  const found = await tryDiscover(page, TAKEOVER_CONTROLS.continue, { timeoutMs: 1500 });
  if (!found.resolved) {
    return {
      classification: 'unknown',
      clicked: false,
      dashboardVerified: false,
      explanation: 'Exactly one visible Continue button was required, and it could not be identified.',
    };
  }

  // Burn the attempt before clicking: a click that throws must not be retried.
  attempted.add(session);

  await recordEvent({
    organizationId: session.organizationId,
    type: 'readymode.session_takeover',
    message: 'Continuing past the Readymode administrator session notice.',
    data: {
      host: snapshot.host,
      frame: found.resolved.rootName,
      strategy: found.resolved.strategy,
      matched: verdict.matched,
    },
  });

  await found.resolved.locator.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

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
  const dashboardVerified = (await checkAuthentication(page, 5000)).authenticated;

  return {
    classification: 'admin_session_takeover',
    clicked: true,
    dashboardVerified,
    explanation: dashboardVerified
      ? 'Continued past the administrator session notice and reached the dashboard.'
      : 'Continued past the administrator session notice, but the dashboard was not confirmed.',
  };
}
