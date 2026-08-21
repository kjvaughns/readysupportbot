/**
 * Classification of whatever Readymode shows between submitting credentials and
 * reaching the dashboard.
 *
 * ReadySupport is authorized to click Continue for exactly one of these: the
 * notice that signing in will disconnect another administrator's session.
 * Everything else — a CAPTCHA, a multi-factor prompt, a suspension, an expired
 * password, a licence shortage, a destructive confirmation — must never be
 * clicked through.
 *
 * This module is pure and takes a plain snapshot, so the rule can be proven by
 * unit tests rather than trusted. The default is `unknown`, which does not
 * click: a phrasing this does not recognize fails closed.
 */

export type InterstitialClassification =
  | 'admin_session_takeover'
  | 'human_verification'
  | 'no_admin_license'
  | 'limited_admin_mode'
  | 'credentials_rejected'
  | 'account_suspended'
  | 'password_expired'
  | 'permission_denied'
  | 'destructive_confirmation'
  | 'unknown';

export interface InterstitialButton {
  label: string;
  visible: boolean;
}

/** Everything the classifier may see. Plain data — no page, no locators. */
export interface InterstitialSnapshot {
  url: string;
  host: string;
  title: string;
  bodyText: string;
  buttons: InterstitialButton[];
  hasPasswordField: boolean;
  hasCaptcha: boolean;
  dashboardSignalPresent: boolean;
}

export interface InterstitialVerdict {
  classification: InterstitialClassification;
  /** Which signals fired, for the audit record. */
  matched: string[];
  /** True only ever for admin_session_takeover. */
  mayClickContinue: boolean;
  explanation: string;
}

const CONTINUE_LABEL =
  /^\s*(?:continue|proceed|take\s?over|continue\s+anyway|yes,?\s*continue|log\s*in\s*anyway)\s*$/i;

/**
 * One definition per signal, used both by the case ladder below and by the
 * disqualifying re-check. Keeping a single copy is deliberate: when these were
 * written out twice, the two lists drifted and a page saying "this account has
 * been locked" was disqualified by one and not the other.
 */
const PATTERNS = {
  destructive: /permanently delete|cannot be undone|will be removed|delete all|purge|wipe/i,
  captcha: /captcha|prove you.?re (?:not a robot|human)|i'?m not a robot/i,
  multiFactor:
    /verification code|two[- ]factor|2fa|one[- ]time (?:code|password)|authenticator|security code|\botp\b/i,
  suspended:
    /suspend(?:ed)?|account (?:is |has been )?(?:locked|disabled)|locked out|disabled by an administrator/i,
  passwordExpired:
    /password (?:has )?expired|must change your password|update your password|password reset required/i,
  noLicense:
    /no (?:admin(?:istrator)? )?licen[cs]es? (?:are )?available|all (?:\w+ )?licen[cs]es (?:are )?in use|licen[cs]e limit|no seats available|out of licen[cs]es|no (?:admin|administrator) licen[cs]e/i,
  permission:
    /not authorized|access denied|permission denied|you do not have (?:access|permission)|forbidden/i,
  credentials:
    /invalid (?:username|password|credentials)|login failed|incorrect password|wrong password/i,
  limitedAdmin:
    /read[- ]only|limited (?:admin|access|mode)|view[- ]only|restricted (?:admin|mode)|reduced functionality/i,
} as const;

/** Wording that means another administrator session will be replaced. */
const TAKEOVER_SIGNALS: RegExp[] = [
  /already (?:logged|signed) ?in/i,
  /active session/i,
  /session (?:is )?in use/i,
  /another (?:session|location|browser|device|user|administrator|admin)/i,
  /(?:take|taking) over (?:the |this )?session/i,
  /will be (?:signed|logged) out/i,
  /disconnect(?:ed)? the other/i,
  /end the other session/i,
  /continue (?:here|anyway)/i,
];

/**
 * Signals that disqualify a takeover outright. Derived from the same patterns as
 * the case ladder, so the two can never disagree.
 */
const NEGATIVE_SIGNALS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'destructive', pattern: PATTERNS.destructive },
  { label: 'captcha', pattern: PATTERNS.captcha },
  { label: 'multi_factor', pattern: PATTERNS.multiFactor },
  { label: 'suspended', pattern: PATTERNS.suspended },
  { label: 'password_expired', pattern: PATTERNS.passwordExpired },
  { label: 'no_license', pattern: PATTERNS.noLicense },
  { label: 'permission', pattern: PATTERNS.permission },
  { label: 'credentials', pattern: PATTERNS.credentials },
];

function haystack(snapshot: InterstitialSnapshot): string {
  return `${snapshot.title}\n${snapshot.bodyText}`;
}

function visibleContinueButtons(snapshot: InterstitialSnapshot): InterstitialButton[] {
  return snapshot.buttons.filter((button) => button.visible && CONTINUE_LABEL.test(button.label));
}

function verdict(
  classification: InterstitialClassification,
  matched: string[],
  explanation: string,
): InterstitialVerdict {
  return {
    classification,
    matched,
    // Computed in exactly one place, so no case can grant permission by accident.
    mayClickContinue: classification === 'admin_session_takeover',
    explanation,
  };
}

export function classifyInterstitial(snapshot: InterstitialSnapshot): InterstitialVerdict {
  const text = haystack(snapshot);

  // 1. Destructive confirmations, first: a Continue button next to "cannot be
  //    undone" is the most dangerous thing that could be misread as a takeover.
  const destructiveButton = snapshot.buttons.some(
    (button) => button.visible && /delete|remove|purge|erase|terminate/i.test(button.label),
  );
  if (PATTERNS.destructive.test(text) || destructiveButton) {
    return verdict(
      'destructive_confirmation',
      ['destructive'],
      'Readymode is asking to confirm a destructive action. ReadySupport will not confirm it.',
    );
  }

  // 2. Human verification. Never solved, never clicked past.
  if (snapshot.hasCaptcha) {
    return verdict('human_verification', ['captcha'], 'Readymode is showing a CAPTCHA. A person has to complete it.');
  }
  if (PATTERNS.multiFactor.test(text) || PATTERNS.captcha.test(text)) {
    return verdict(
      'human_verification',
      ['multi_factor'],
      'Readymode is asking for a verification code. A person has to complete it.',
    );
  }

  if (PATTERNS.suspended.test(text)) {
    return verdict('account_suspended', ['suspended'], 'The Readymode account appears to be locked or suspended.');
  }

  if (
    PATTERNS.passwordExpired.test(text) ||
    (snapshot.hasPasswordField && /new password|confirm password/i.test(text))
  ) {
    return verdict('password_expired', ['password_expired'], 'Readymode is requiring a password change.');
  }

  if (PATTERNS.noLicense.test(text)) {
    return verdict(
      'no_admin_license',
      ['no_license'],
      'No administrator licence is available. ReadySupport will not sign anyone out to free one.',
    );
  }

  if (PATTERNS.permission.test(text)) {
    return verdict('permission_denied', ['permission'], 'Readymode refused access to this administrator.');
  }

  if (PATTERNS.credentials.test(text)) {
    return verdict('credentials_rejected', ['credentials'], 'Readymode rejected the stored credentials.');
  }

  if (PATTERNS.limitedAdmin.test(text)) {
    return verdict(
      'limited_admin_mode',
      ['limited_admin'],
      'Readymode opened in Limited Admin Mode, where only License Usage is available.',
    );
  }

  // 3. The one case ReadySupport may act on.
  const takeoverMatches = TAKEOVER_SIGNALS.filter((pattern) => pattern.test(text));
  const continueButtons = visibleContinueButtons(snapshot);

  if (takeoverMatches.length > 0) {
    // Re-check every disqualifying signal explicitly rather than relying on the
    // order of the cases above.
    const blocking = NEGATIVE_SIGNALS.filter((signal) => signal.pattern.test(text)).map((signal) => signal.label);
    if (blocking.length > 0) {
      return verdict(
        'unknown',
        blocking,
        `The notice mentions another session but also ${blocking.join(', ')}. ReadySupport will not continue.`,
      );
    }
    if (snapshot.hasPasswordField) {
      return verdict('unknown', ['password_field'], 'The notice still shows a password field, so it is not a session takeover.');
    }
    if (continueButtons.length === 0) {
      return verdict('unknown', ['no_continue_button'], 'The notice mentions another session but has no Continue button.');
    }
    if (continueButtons.length > 1) {
      return verdict(
        'unknown',
        ['multiple_continue_buttons'],
        `The notice has ${continueButtons.length} Continue buttons, so the right one is ambiguous.`,
      );
    }

    return verdict(
      'admin_session_takeover',
      ['takeover'],
      'Readymode is warning that continuing will sign out another administrator session.',
    );
  }

  if (continueButtons.length > 0) {
    return verdict(
      'unknown',
      ['continue_without_takeover_wording'],
      'A Continue button is present but nothing says another administrator session would be replaced.',
    );
  }

  return verdict('unknown', [], 'ReadySupport did not recognize this Readymode page.');
}
