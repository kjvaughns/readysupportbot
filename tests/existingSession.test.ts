import { describe, expect, it } from 'vitest';
import { classifyInterstitial } from '../src/readymode/interstitial';
import { TAKEOVER_CONTROLS, EXISTING_SESSION_CONTEXT } from '../src/readymode/selectors';
import { tryDiscover } from '../src/readymode/selectors/discovery';
import { checkAuthentication } from '../src/readymode/authState';
import { buildFakePage, mutationsIn } from './support/fakePage';
import type { FakeRootSpec } from './support/fakePage';

/**
 * The exact screen from the Browserbase recording.
 *
 * Readymode accepted the credentials and then showed this, on the login page,
 * with the password field still in the DOM:
 *
 *   "K.Vaughns is already logged in. If you choose to continue, you will log
 *    out all your other sessions."
 *
 * ReadySupport stopped here on every run. Two things were wrong. A guard
 * treated any visible password field as proof that a page was not a takeover —
 * reasonable in the abstract, and wrong for the one screen it had to handle,
 * because this notice renders on the login page. And the Continue control was
 * only ever looked for as a <button>, while Readymode styles it as a link.
 */

const NOTICE_TEXT =
  'K.Vaughns is already logged in. If you choose to continue, you will log out all your other sessions.';

const HEADING_CSS = [
  'h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption, .panel-title, .panelTitle, .ui-dialog-title',
];

/** The notice as recorded: on the login page, Continue rendered as a link. */
function existingSessionScreen(continueAs: 'link' | 'button' | 'submit'): FakeRootSpec[] {
  const continueControl =
    continueAs === 'link'
      ? { role: 'link', name: 'Continue', text: 'Continue', css: ['a:has-text("Continue")'], opens: 'dashboard' }
      : continueAs === 'button'
        ? { role: 'button', name: 'Continue', text: 'Continue', css: ['button:has-text("Continue")'], opens: 'dashboard' }
        : {
            name: 'Continue',
            text: 'Continue',
            css: ['input[type="submit"][value="Continue" i]'],
            opens: 'dashboard',
          };

  return [
    {
      name: 'page',
      url: 'https://apexfinancial.readymode.com/login_new/?then=/',
      title: 'Readymode Inc. CRM',
      bodyText: NOTICE_TEXT,
      elements: [
        { text: NOTICE_TEXT, name: NOTICE_TEXT },
        continueControl,
        { role: 'link', name: 'Cancel', text: 'Cancel' },
        // Still on the login page: the password field has not gone anywhere.
        { css: ['input[type="password"]'] },
        { css: ["input[placeholder='Username']"], placeholder: 'Username' },
      ],
    },
  ];
}

const DASHBOARD: FakeRootSpec[] = [
  {
    name: 'page',
    url: 'https://apexfinancial.readymode.com/-Dashboard',
    title: 'Readymode Inc. CRM',
    elements: [
      { text: 'Dashboard', name: 'Dashboard', css: HEADING_CSS },
      { css: ['#hotbar_search'], placeholder: 'Search..' },
      { css: ['#CCS_Session_Statebox'] },
    ],
  },
];

function noticeSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    url: 'https://apexfinancial.readymode.com/login_new/?then=/',
    host: 'apexfinancial.readymode.com',
    title: 'Readymode Inc. CRM',
    bodyText: NOTICE_TEXT,
    buttons: [
      { label: 'Continue', visible: true },
      { label: 'Cancel', visible: true },
    ],
    // The whole point: this notice appears on the login page.
    hasPasswordField: true,
    hasCaptcha: false,
    dashboardSignalPresent: false,
    ...overrides,
  };
}

describe('the recorded existing-session screen', () => {
  it('is classified as a session takeover, password field and all', () => {
    const verdict = classifyInterstitial(noticeSnapshot());

    expect(verdict.classification).toBe('admin_session_takeover');
    expect(verdict.mayClickContinue).toBe(true);
  });

  it('is never classified as a login error', () => {
    const verdict = classifyInterstitial(noticeSnapshot());
    expect(verdict.classification).not.toBe('credentials_rejected');
  });

  it('is not confused with a page that merely says "continue"', () => {
    const verdict = classifyInterstitial(
      noticeSnapshot({ bodyText: 'Welcome back. Continue to your dashboard.' }),
    );
    expect(verdict.mayClickContinue).toBe(false);
  });

  it('still refuses when a captcha is on the same screen', () => {
    const verdict = classifyInterstitial(noticeSnapshot({ hasCaptcha: true }));
    expect(verdict.classification).toBe('human_verification');
    expect(verdict.mayClickContinue).toBe(false);
  });

  it('carries the context text the control is identified by', () => {
    expect(EXISTING_SESSION_CONTEXT.test(NOTICE_TEXT)).toBe(true);
    expect(EXISTING_SESSION_CONTEXT.test('Welcome to Readymode.')).toBe(false);
  });
});

describe('finding the Continue control, whatever it is made of', () => {
  for (const shape of ['link', 'button', 'submit'] as const) {
    it(`resolves it when Readymode renders it as a ${shape}`, async () => {
      const { page } = buildFakePage(existingSessionScreen(shape));

      const found = await tryDiscover(page, TAKEOVER_CONTROLS.continue, { timeoutMs: 100 });

      expect(found.resolved, `Continue as a ${shape} was not found`).not.toBeNull();
    });
  }

  it('does not resolve Cancel', async () => {
    const { page } = buildFakePage(existingSessionScreen('link'));
    const found = await tryDiscover(page, TAKEOVER_CONTROLS.continue, { timeoutMs: 100 });

    const strategy = String(found.resolved?.strategy ?? '');
    expect(strategy.toLowerCase()).not.toContain('cancel');
  });
});

describe('the screen is cleared before discovery starts', () => {
  it('is not authenticated while the notice is on screen', async () => {
    const { page } = buildFakePage(existingSessionScreen('link'));

    const before = await checkAuthentication(page, 50);
    expect(before.authenticated).toBe(false);
    expect(before.loginFormPresent).toBe(true);
  });

  it('clicks Continue and reaches the authenticated dashboard', async () => {
    const notice = existingSessionScreen('link');
    const { page, log } = buildFakePage(notice, {
      screens: { notice, dashboard: DASHBOARD },
      start: 'notice',
    });

    // 1. The notice is recognized.
    expect(classifyInterstitial(noticeSnapshot()).mayClickContinue).toBe(true);

    // 2. The control is found and pressed.
    const found = await tryDiscover(page, TAKEOVER_CONTROLS.continue, { timeoutMs: 100 });
    expect(found.resolved).not.toBeNull();
    await found.resolved!.locator.click();

    // 3. The authenticated shell is confirmed — by a marker, not by the URL.
    const after = await checkAuthentication(page, 50);
    expect(after.authenticated).toBe(true);
    expect(after.marker).toBe('hotbar search');
    expect(after.loginFormPresent).toBe(false);

    // Exactly one click: pressing Continue, and nothing else.
    expect(mutationsIn(log)).toEqual(['click']);
  });

  it('would leave discovery on the login page if Continue were never pressed', async () => {
    // The failure this reproduces. Without the click, every administrative
    // route redirects here and the crawl captures the login form each time.
    const { page } = buildFakePage(existingSessionScreen('link'));

    const state = await checkAuthentication(page, 50);
    expect(state.authenticated).toBe(false);
  });
});
