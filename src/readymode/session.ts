import type { Page } from 'playwright-core';
import { env } from '../config/env.js';
import { errorFor } from '../domain/errors.js';
import * as browserSessions from '../db/repositories/browserSessions.js';
import * as settings from '../db/repositories/settings.js';
import { moduleLogger } from '../util/logger.js';
import { nowIso } from '../util/time.js';
import { confirmPage, goToRoute, isVisibleIfConfigured, locate } from './browser.js';
import type { ReadymodeSession } from './browser.js';
import { getRoute, isConfigured, isRouteConfigured, UNKNOWN } from './selectors.js';
import type { AuthStatus } from './port.js';

/**
 * Readymode authentication.
 *
 * The order is: reuse, then check, then sign in only if we must. The stored
 * Browserbase context normally means we are already signed in, and the
 * credentials are read from the environment only on the rare occasion a real
 * sign-in is needed.
 *
 * The hard rule in this file: if Readymode asks for a CAPTCHA, a code, or any
 * other verification step, ReadySupport stops and asks a human. It does not
 * attempt to solve, bypass, or work around any of it. That is not a limitation
 * to be engineered away — those controls exist for a reason and a bot defeating
 * them would be the security problem, not the solution.
 */

const log = moduleLogger('readymode-session');

export type ProbeResult = AuthStatus['state'];

/**
 * Work out what Readymode is showing us.
 *
 * Verification is checked first. A page can show a sign-in form *and* a
 * CAPTCHA, and treating that as "just expired" would mean trying to type
 * credentials into a challenge.
 */
export async function probe(page: Page): Promise<{ state: ProbeResult; detail?: string }> {
  // All five markers are looked for at once. Checking them one after another
  // would mean waiting out a full timeout for each absent one, and four of the
  // five are absent on any given page — that is seconds added to every job for
  // no information. The priority below is applied to the results, not to the
  // order they are fetched in.
  const [captcha, mfa, dashboard, login, expired] = await Promise.all([
    isVisibleIfConfigured(page, 'auth.captcha.marker', 2_000),
    isVisibleIfConfigured(page, 'auth.mfa.marker', 2_000),
    isVisibleIfConfigured(page, 'page.dashboard.marker', 5_000),
    isVisibleIfConfigured(page, 'page.login.marker', 2_000),
    isVisibleIfConfigured(page, 'auth.expired.marker', 2_000),
  ]);

  // Verification wins over everything. A page can show a sign-in form *and* a
  // CAPTCHA, and treating that as "just expired" would mean typing credentials
  // into a challenge.
  if (captcha) {
    return { state: 'VERIFICATION_REQUIRED', detail: 'Readymode is showing a CAPTCHA challenge.' };
  }
  if (mfa) {
    return { state: 'VERIFICATION_REQUIRED', detail: 'Readymode is asking for a verification code.' };
  }

  if (dashboard) return { state: 'AUTHENTICATED' };

  if (login) return { state: 'EXPIRED', detail: 'Readymode is showing the sign-in page.' };
  if (expired) return { state: 'EXPIRED', detail: 'Readymode says the session has expired.' };

  return {
    state: 'UNKNOWN',
    detail: 'The page did not match the sign-in page or the dashboard.',
  };
}

/** The selectors and routes the authentication path itself depends on. */
export function authSelectorsConfigured(): { ok: boolean; missing: string[] } {
  const needed = ['page.dashboard.marker', 'page.login.marker'];
  const missing = needed.filter((id) => !isConfigured(id));
  if (!isRouteConfigured('route.dashboard')) missing.push('route.dashboard');
  return { ok: missing.length === 0, missing };
}

/**
 * Check whether the stored session still works, without signing in.
 */
export async function checkAuthentication(session: ReadymodeSession): Promise<AuthStatus> {
  const configured = authSelectorsConfigured();
  if (!configured.ok) {
    return {
      state: 'UNKNOWN',
      detail:
        'The parts of the Readymode interface needed to tell signed-in from signed-out have not been mapped yet. ' +
        'Run the discovery step.',
      checkedAt: nowIso(),
    };
  }

  await goToRoute(session.page, getRoute('route.dashboard').path);
  const result = await probe(session.page);

  await browserSessions.update(session.recordId, {
    authState: result.state,
    lastCheckedAt: nowIso(),
    verificationDetected: result.state === 'VERIFICATION_REQUIRED',
  });

  return {
    state: result.state,
    ...(result.detail ? { detail: result.detail } : {}),
    checkedAt: nowIso(),
    reusedSession: true,
  };
}

/**
 * Sign in with the stored credentials.
 *
 * Stops immediately and reports VERIFICATION_REQUIRED if a challenge appears
 * at any point — before typing, and again after submitting.
 */
export async function signIn(session: ReadymodeSession): Promise<AuthStatus> {
  const config = env();
  const { page } = session;

  const needed = ['login.username.input', 'login.password.input', 'login.submit.button', 'page.dashboard.marker'];
  const missing = needed.filter((id) => !isConfigured(id));
  if (missing.length > 0) {
    return {
      state: 'UNKNOWN',
      detail: `The sign-in form has not been mapped yet (missing: ${missing.join(', ')}). Run the discovery step.`,
      checkedAt: nowIso(),
    };
  }

  await goToRoute(page, isRouteConfigured('route.login') ? getRoute('route.login').path : new URL(config.READYMODE_LOGIN_URL).pathname);

  const before = await probe(page);
  if (before.state === 'VERIFICATION_REQUIRED') {
    await recordVerification(session, before.detail);
    return {
      state: 'VERIFICATION_REQUIRED',
      ...(before.detail ? { detail: before.detail } : {}),
      checkedAt: nowIso(),
    };
  }

  if (before.state === 'AUTHENTICATED') {
    return { state: 'AUTHENTICATED', checkedAt: nowIso(), reusedSession: true };
  }

  try {
    await locate(page, 'login.username.input').first().fill(config.READYMODE_ADMIN_USERNAME);
    // The password is read here and nowhere else. It is never logged, never
    // stored, and the field is emptied before any screenshot is taken.
    await locate(page, 'login.password.input').first().fill(config.READYMODE_ADMIN_PASSWORD);
    await locate(page, 'login.submit.button').first().click();
  } catch (cause) {
    throw errorFor('INTERFACE_CHANGED', {
      message: 'The Readymode sign-in page did not look the way I expected, so I stopped.',
      cause,
    });
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);

  const after = await probe(page);

  await browserSessions.update(session.recordId, {
    performedLogin: true,
    authState: after.state,
    lastCheckedAt: nowIso(),
    verificationDetected: after.state === 'VERIFICATION_REQUIRED',
  });

  if (after.state === 'VERIFICATION_REQUIRED') {
    await recordVerification(session, after.detail);
    return {
      state: 'VERIFICATION_REQUIRED',
      ...(after.detail ? { detail: after.detail } : {}),
      checkedAt: nowIso(),
    };
  }

  if (after.state === 'AUTHENTICATED') {
    log.info('Signed in to Readymode with stored credentials');
    return { state: 'AUTHENTICATED', checkedAt: nowIso(), reusedSession: false };
  }

  // Sign-in was rejected. Whatever Readymode said about it is not repeated
  // verbatim — a rejection banner is untrusted text and could name the account.
  const rejected = await isVisibleIfConfigured(page, 'login.error.marker', 2_000);
  return {
    state: 'EXPIRED',
    detail: rejected
      ? 'Readymode rejected the stored credentials.'
      : (after.detail ?? 'Sign-in did not land on the dashboard.'),
    checkedAt: nowIso(),
  };
}

async function recordVerification(session: ReadymodeSession, detail?: string): Promise<void> {
  log.warn({ detail }, 'Readymode asked for verification; stopping and handing over to a human');

  await browserSessions.update(session.recordId, {
    authState: 'VERIFICATION_REQUIRED',
    verificationDetected: true,
    errorCategory: 'VERIFICATION_REQUIRED',
    errorMessage: detail ?? 'Readymode asked for additional verification.',
  });

  await settings.set('readymode_auth_state', {
    state: 'VERIFICATION_REQUIRED',
    checkedAt: nowIso(),
    detail: detail ?? null,
  });
}

/**
 * Get to a usable, signed-in session — reusing the stored context if it still
 * works, signing in if it does not, and stopping if Readymode wants a human.
 *
 * Every workflow starts here.
 */
export async function ensureAuthenticated(session: ReadymodeSession): Promise<void> {
  const status = await checkAuthentication(session);

  if (status.state === 'AUTHENTICATED') {
    await settings.set('readymode_auth_state', {
      state: 'AUTHENTICATED',
      checkedAt: status.checkedAt,
      detail: null,
    });
    return;
  }

  if (status.state === 'VERIFICATION_REQUIRED') {
    throw errorFor('VERIFICATION_REQUIRED', { message: status.detail });
  }

  if (status.state === 'UNKNOWN' && !authSelectorsConfigured().ok) {
    throw errorFor('SELECTOR_NOT_CONFIGURED', { message: status.detail });
  }

  const signedIn = await signIn(session);

  if (signedIn.state === 'AUTHENTICATED') {
    await settings.set('readymode_auth_state', {
      state: 'AUTHENTICATED',
      checkedAt: signedIn.checkedAt,
      detail: null,
    });
    return;
  }

  if (signedIn.state === 'VERIFICATION_REQUIRED') {
    throw errorFor('VERIFICATION_REQUIRED', { message: signedIn.detail });
  }

  throw errorFor('AUTH_EXPIRED', {
    details: { detail: signedIn.detail },
  });
}

/**
 * The current page must be the one the workflow expects. Exported so each
 * workflow's first step reads the same.
 */
export async function requirePage(page: Page, markerId: string, description: string): Promise<void> {
  await confirmPage(page, markerId, description);
}

export { UNKNOWN };
