import { describe, expect, it } from 'vitest';
import {
  InterstitialClassification,
  InterstitialSnapshot,
  classifyInterstitial,
} from '../src/readymode/interstitial';

/**
 * ReadySupport may click Continue for exactly one thing: the notice that says
 * signing in will disconnect another administrator's session.
 *
 * The adversarial block below is the test that matters. Every other
 * classification is re-run with a Continue button and takeover wording bolted
 * on, and each must still refuse. A CAPTCHA page with a Continue button, or a
 * "this cannot be undone" page with one, must never become clickable.
 */

function snapshot(overrides: Partial<InterstitialSnapshot> = {}): InterstitialSnapshot {
  return {
    url: 'https://rm.example.com/admin',
    host: 'rm.example.com',
    title: 'Readymode',
    bodyText: '',
    buttons: [],
    hasPasswordField: false,
    hasCaptcha: false,
    dashboardSignalPresent: false,
    ...overrides,
  };
}

const CONTINUE = { label: 'Continue', visible: true };

const FIXTURES: Record<Exclude<InterstitialClassification, 'admin_session_takeover'>, InterstitialSnapshot> = {
  human_verification: snapshot({
    bodyText: 'Please complete the verification code we sent to your device.',
  }),
  no_admin_license: snapshot({
    bodyText: 'All administrator licenses are in use. Try again later.',
  }),
  limited_admin_mode: snapshot({
    bodyText: 'You are signed in with read-only access. Only License Usage is available.',
  }),
  credentials_rejected: snapshot({ bodyText: 'Invalid username or password.' }),
  account_suspended: snapshot({ bodyText: 'This account has been locked. Contact your administrator.' }),
  password_expired: snapshot({ bodyText: 'Your password has expired and must be changed.' }),
  permission_denied: snapshot({ bodyText: 'Access denied. You do not have permission to view this page.' }),
  destructive_confirmation: snapshot({
    bodyText: 'This will permanently delete the campaign and cannot be undone.',
  }),
  unknown: snapshot({ bodyText: 'Something entirely unfamiliar is on this page.' }),
};

describe('interstitial classification', () => {
  it('recognizes the administrator session notice', () => {
    const verdict = classifyInterstitial(
      snapshot({
        bodyText: 'You are already logged in from another location. Continuing will sign out that session.',
        buttons: [CONTINUE],
      }),
    );

    expect(verdict.classification).toBe('admin_session_takeover');
    expect(verdict.mayClickContinue).toBe(true);
  });

  for (const [expected, fixture] of Object.entries(FIXTURES)) {
    it(`classifies ${expected} and refuses to continue`, () => {
      const verdict = classifyInterstitial(fixture);
      expect(verdict.classification).toBe(expected);
      expect(verdict.mayClickContinue).toBe(false);
    });
  }
});

describe('adversarial pages that look like a takeover but are not', () => {
  // 'unknown' is excluded on purpose: unrecognized text plus takeover wording
  // plus exactly one Continue button *is* the takeover notice, and recognizing
  // it there is correct rather than a false positive.
  const adversarial = Object.entries(FIXTURES).filter(([name]) => name !== 'unknown');

  for (const [name, fixture] of adversarial) {
    it(`never continues on a ${name} page that also offers Continue`, () => {
      const verdict = classifyInterstitial({
        ...fixture,
        bodyText: `${fixture.bodyText} You are already logged in from another location.`,
        buttons: [...fixture.buttons, CONTINUE],
      });

      expect(verdict.mayClickContinue).toBe(false);
    });
  }

  it('never continues when a CAPTCHA is present, whatever the wording', () => {
    const verdict = classifyInterstitial(
      snapshot({
        bodyText: 'You are already logged in from another location.',
        buttons: [CONTINUE],
        hasCaptcha: true,
      }),
    );
    expect(verdict.classification).toBe('human_verification');
    expect(verdict.mayClickContinue).toBe(false);
  });
});

describe('takeover preconditions', () => {
  const takeoverText = 'Your account is already logged in from another location.';

  it('refuses when there is no Continue button', () => {
    const verdict = classifyInterstitial(snapshot({ bodyText: takeoverText }));
    expect(verdict.classification).toBe('unknown');
    expect(verdict.matched).toContain('no_continue_button');
  });

  it('refuses when more than one Continue button is visible', () => {
    const verdict = classifyInterstitial(
      snapshot({ bodyText: takeoverText, buttons: [CONTINUE, { label: 'Continue', visible: true }] }),
    );
    expect(verdict.classification).toBe('unknown');
    expect(verdict.matched).toContain('multiple_continue_buttons');
  });

  it('refuses when the Continue button is not visible', () => {
    const verdict = classifyInterstitial(
      snapshot({ bodyText: takeoverText, buttons: [{ label: 'Continue', visible: false }] }),
    );
    expect(verdict.classification).toBe('unknown');
  });

  it('refuses when a password field is still on the page', () => {
    const verdict = classifyInterstitial(
      snapshot({ bodyText: takeoverText, buttons: [CONTINUE], hasPasswordField: true }),
    );
    expect(verdict.mayClickContinue).toBe(false);
  });

  it('refuses a Continue button with no takeover wording at all', () => {
    const verdict = classifyInterstitial(
      snapshot({ bodyText: 'Welcome to Readymode.', buttons: [CONTINUE] }),
    );
    expect(verdict.classification).toBe('unknown');
    expect(verdict.matched).toContain('continue_without_takeover_wording');
  });

  it('is pure — the snapshot is not modified', () => {
    const input = Object.freeze(
      snapshot({ bodyText: takeoverText, buttons: [CONTINUE] }),
    );
    const first = classifyInterstitial(input);
    const second = classifyInterstitial(input);
    expect(first).toEqual(second);
  });

  it('grants permission in exactly one classification', () => {
    const all: InterstitialSnapshot[] = [
      ...Object.values(FIXTURES),
      snapshot({ bodyText: takeoverText, buttons: [CONTINUE] }),
    ];
    const permitted = all
      .map((entry) => classifyInterstitial(entry))
      .filter((verdict) => verdict.mayClickContinue);

    expect(permitted).toHaveLength(1);
    expect(permitted[0].classification).toBe('admin_session_takeover');
  });
});
