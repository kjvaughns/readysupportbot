/* eslint-disable no-console -- Deliberate, temporary deployment diagnostics.
 * Structural only: paths, methods, field names, status codes. Never a value.
 */
import type { Frame, Page } from 'playwright-core';
import { logger } from '../security/logger';
import { sanitizePageValue } from '../security/sanitize';
import { checkAuthentication, waitForAuthenticated } from './authState';
import { FormSubmitReport, submitContinueForm } from './continueSubmit.browser';

/**
 * Getting past the existing-session notice by submitting its form.
 *
 * The notice is the login form re-rendered with `logout_other_sessions` already
 * set to `on` and its submit control relabelled "Continue". It is an
 * `<input type="submit">`, so the page is asking for one thing: POST this form
 * again.
 *
 * Clicking was the wrong instrument. A click has to find a rectangle, have it
 * be on screen, have nothing overlapping it, and have the browser deliver the
 * event — four ways to fail at something the page can simply be asked to do.
 * `requestSubmit(submitter)` is what the browser itself does when a person
 * presses the button: validation runs, the submit event fires so any handler
 * Readymode attached still runs, and the submitter is included in the payload.
 *
 * A click remains as the last resort, for a Continue that turns out not to
 * belong to a form at all.
 */

export type SubmitMethod = 'requestSubmit' | 'formSubmit' | 'click';

export interface ContinueSubmitResult {
  attempted: boolean;
  submitted: boolean;
  method: SubmitMethod | null;
  /** Every method tried, in order, with what happened. */
  attempts: Array<{ method: SubmitMethod; error: string | null; movedOn: boolean }>;
  formFound: boolean;
  /** Names only. One of them is the password field; its value is never read. */
  hiddenFieldNames: string[];
  formMethod: string | null;
  formActionPath: string | null;
  /** True once the signed-in shell is confirmed. */
  authenticated: boolean;
  authenticatedMarker: string | null;
  error: string | null;
}

const CONTINUE_SELECTOR = 'input[type="submit"][value="Continue" i]';

/** The frame holding the Continue control, which may not be the main document. */
export async function findContinueFrame(page: Page): Promise<Frame | null> {
  for (const frame of page.frames()) {
    try {
      if ((await frame.locator(CONTINUE_SELECTOR).count()) > 0) return frame;
      if ((await frame.locator('form.login-form').count()) > 0) return frame;
    } catch {
      // A frame that cannot be queried is not the one.
    }
  }
  return null;
}

/**
 * Asks the notice's form to submit itself, and confirms the result.
 *
 * Tries the faithful mechanism first, then the blunt one, then a click. Each
 * attempt's error is recorded rather than swallowed, and each is followed by a
 * check for the signed-in shell — because a mechanism that "worked" without
 * reaching the interface has not worked.
 */
export async function submitExistingSessionForm(page: Page): Promise<ContinueSubmitResult> {
  const result: ContinueSubmitResult = {
    attempted: false,
    submitted: false,
    method: null,
    attempts: [],
    formFound: false,
    hiddenFieldNames: [],
    formMethod: null,
    formActionPath: null,
    authenticated: false,
    authenticatedMarker: null,
    error: null,
  };

  const frame = await findContinueFrame(page);
  if (!frame) {
    result.error = 'No Continue control and no login form were found in any frame.';
    console.log('[Readymode Auth] continue form not found in any frame');
    return result;
  }

  result.attempted = true;

  const run = async (method: SubmitMethod, preferLowLevel: boolean): Promise<boolean> => {
    let report: FormSubmitReport | null = null;
    let error: string | null = null;

    // Re-resolved every attempt: a submission navigates, and the previous
    // attempt's frame handle is detached by the time the next one runs.
    const current = (await findContinueFrame(page)) ?? frame;

    try {
      if (method === 'click') {
        // Only reached when the control belongs to no form at all.
        await current.locator(CONTINUE_SELECTOR).first().click({ timeout: 5000 });
      } else {
        report = await current.evaluate(submitContinueForm, preferLowLevel);
        if (report.error) error = report.error;
      }
    } catch (caught) {
      error = sanitizePageValue(caught instanceof Error ? caught.message : 'unknown', 200);
    }

    if (report) {
      result.formFound = report.formFound;
      result.hiddenFieldNames = report.hiddenFieldNames;
      result.formMethod = report.formMethod;
      result.formActionPath = report.formActionPath;
    }

    console.log(`[Readymode Auth] continue submit method=${method}`, {
      formFound: result.formFound,
      formMethod: result.formMethod,
      actionPath: result.formActionPath,
      // The names say what the form does. `logout_other_sessions` is the point
      // of this screen; no value behind any of them is read.
      hiddenFields: result.hiddenFieldNames,
      error,
    });

    // Give the POST time to land.
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await page.waitForTimeout(2500).catch(() => undefined);

    const stillOnNotice = await current
      .locator(CONTINUE_SELECTOR)
      .first()
      .isVisible()
      .catch(() => false);

    // Only wait for the shell when the notice actually went away. Waiting
    // fifteen seconds for a screen that plainly did not move is time spent
    // proving something already visible, three times over.
    const confirmed = stillOnNotice
      ? await checkAuthentication(page, 1200)
      : await waitForAuthenticated(page, 15_000);

    const movedOn = confirmed.authenticated || !stillOnNotice;
    result.attempts.push({ method, error, movedOn });

    if (confirmed.authenticated) {
      result.submitted = true;
      result.method = method;
      result.authenticated = true;
      result.authenticatedMarker = confirmed.marker;
      console.log(`[Readymode Auth] continue submitted via ${method}; confirmed by ${confirmed.marker}`);
      return true;
    }

    if (error) {
      logger.warn({ method, reason: error }, 'Continue submission failed');
    }

    return false;
  };

  // 1. As a person pressing it: validation, submit event, submitter included.
  if (await run('requestSubmit', false)) return result;

  // 2. Blunt: straight to the server, no submit event. The Continue input
  //    carries no name, so the payload is the same either way.
  if (await run('formSubmit', true)) return result;

  // 3. Only if the control belongs to no form at all.
  if (await run('click', false)) return result;

  const last = result.attempts[result.attempts.length - 1];
  result.error =
    last?.error ??
    'The form was submitted but the signed-in interface never appeared, so Readymode refused the continuation.';

  const finalState = await checkAuthentication(page, 1500);
  result.authenticated = finalState.authenticated;
  result.authenticatedMarker = finalState.marker;

  return result;
}
