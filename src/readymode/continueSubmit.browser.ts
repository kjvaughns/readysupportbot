/// <reference lib="dom" />
/**
 * Browser-side submission of the existing-session form.
 *
 * The notice is not a custom widget. It is the login form itself, re-rendered
 * with `logout_other_sessions` already set to `on` and its submit control
 * relabelled:
 *
 *   <form method="post" class="login-form">
 *     <input type="submit" value="Continue" class="button primary primary-1 sign-in">
 *
 * So the page is asking to POST that form again. Asking the form to submit
 * itself is a more direct statement of that than moving a mouse to a rectangle
 * and hoping the click lands, and it cannot be defeated by an overlay, a
 * transform, or an element that is scrolled out of view.
 *
 * Returns structure only. Hidden field *names* are reported because they
 * explain what the form does; no field value is ever read — one of them is the
 * password.
 */

export interface FormSubmitReport {
  formFound: boolean;
  /** Which mechanism submitted it. */
  method: 'requestSubmit' | 'formSubmit' | null;
  /** Names only. `login_password` is among them; its value is never touched. */
  hiddenFieldNames: string[];
  formMethod: string | null;
  /** Path only — a query string can carry a token. */
  formActionPath: string | null;
  error: string | null;
}

/**
 * Submits the form the Continue control belongs to.
 *
 * `requestSubmit(submitter)` is what the browser does when a person presses the
 * button: it runs validation, fires the submit event so any handler Readymode
 * attached still runs, and includes the submitter in the payload. `submit()` is
 * the blunt fallback — it bypasses both.
 */
export function submitContinueForm(preferLowLevel: boolean): FormSubmitReport {
  const report: FormSubmitReport = {
    formFound: false,
    method: null,
    hiddenFieldNames: [],
    formMethod: null,
    formActionPath: null,
    error: null,
  };

  const submitter = document.querySelector(
    'input[type="submit"][value="Continue" i], button[type="submit"]',
  ) as HTMLInputElement | HTMLButtonElement | null;

  const form =
    (submitter?.form as HTMLFormElement | null) ??
    (document.querySelector('form.login-form') as HTMLFormElement | null) ??
    (document.querySelector('form[method="post" i]') as HTMLFormElement | null);

  if (!form) {
    report.error = 'No form containing a Continue control was found.';
    return report;
  }

  report.formFound = true;
  report.formMethod = (form.getAttribute('method') ?? 'get').toLowerCase();

  try {
    const action = form.getAttribute('action');
    report.formActionPath = action ? new URL(action, location.href).pathname : location.pathname;
  } catch {
    report.formActionPath = null;
  }

  // Names explain the form's purpose — `logout_other_sessions` is the whole
  // reason this screen exists. Values are never read.
  report.hiddenFieldNames = Array.from(form.querySelectorAll('input[type="hidden"]'))
    .map((field) => field.getAttribute('name') ?? '')
    .filter(Boolean)
    .slice(0, 20);

  try {
    if (!preferLowLevel && typeof form.requestSubmit === 'function') {
      // Named submitter when there is one, so the payload is what a real press
      // would produce.
      if (submitter) form.requestSubmit(submitter);
      else form.requestSubmit();
      report.method = 'requestSubmit';
      return report;
    }

    // The blunt version: no validation, no submit event, and the submitter is
    // not included. Harmless here — the Continue input carries no `name`, so a
    // real press would not have sent it either.
    HTMLFormElement.prototype.submit.call(form);
    report.method = 'formSubmit';
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message.slice(0, 200) : 'submission failed';
    return report;
  }
}


/**
 * Whether this page is the existing-session form, decided from its structure.
 *
 * The DOM states the form's purpose unambiguously: a hidden field named
 * `logout_other_sessions` set to `on`, and a submit control labelled Continue.
 * That is the whole meaning of the screen, written by the application itself.
 *
 * This exists because reading the prose was not reliable. The classifier had to
 * judge sentences, and the page carries a standing footer — "If you are not
 * authorized to access Readymode Inc.'s software..." — which it read as a
 * refusal, so the notice never got as far as being acted on. Structure does not
 * have that failure mode: either the field is in the form or it is not.
 */
export interface ExistingSessionForm {
  found: boolean;
  hasLogoutOtherSessions: boolean;
  hasContinueSubmit: boolean;
  /** Field names only — never a value. One of these holds the password. */
  hiddenFieldNames: string[];
  formMethod: string | null;
  formActionPath: string | null;
}

export function detectExistingSessionForm(): ExistingSessionForm {
  const result: ExistingSessionForm = {
    found: false,
    hasLogoutOtherSessions: false,
    hasContinueSubmit: false,
    hiddenFieldNames: [],
    formMethod: null,
    formActionPath: null,
  };

  const forms = Array.from(document.querySelectorAll('form'));

  for (const form of forms) {
    const logoutField = form.querySelector('input[name="logout_other_sessions"]') as HTMLInputElement | null;
    const continueSubmit = form.querySelector('input[type="submit"][value="Continue" i]');

    if (!logoutField && !continueSubmit) continue;

    // Reading this one value is unavoidable and safe: it is a switch the
    // application set, not anything a person typed.
    const enabled =
      logoutField !== null &&
      /^(?:on|1|true|yes)$/i.test(logoutField.getAttribute('value') ?? '');

    if (!enabled || !continueSubmit) continue;

    result.found = true;
    result.hasLogoutOtherSessions = true;
    result.hasContinueSubmit = true;
    result.formMethod = (form.getAttribute('method') ?? 'get').toLowerCase();

    try {
      const action = form.getAttribute('action');
      result.formActionPath = action ? new URL(action, location.href).pathname : location.pathname;
    } catch {
      result.formActionPath = null;
    }

    result.hiddenFieldNames = Array.from(form.querySelectorAll('input[type="hidden"]'))
      .map((field) => field.getAttribute('name') ?? '')
      .filter(Boolean)
      .slice(0, 20);

    return result;
  }

  return result;
}
