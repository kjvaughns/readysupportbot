import { describe, expect, it } from 'vitest';
import { proposeSelectors } from '../src/readymode/discovery/propose';
import { rootStats } from '../src/readymode/discovery/evidence';
import type { InterfaceEvidence, RootEvidence } from '../src/readymode/discovery/evidence';
import { ALL_CONTROLS, LOGIN_CONTROLS } from '../src/readymode/selectors';

/**
 * Empty evidence used to be indistinguishable from a bare interface. These
 * cover the difference between "nothing was there", "the collector failed" and
 * "it was not on screen this run".
 */

function root(overrides: Partial<RootEvidence> = {}): RootEvidence {
  return {
    rootName: 'page',
    rootUrl: 'https://rm.test/',
    isMain: true,
    title: '',
    childFrameUrls: [],
    nav: [],
    buttons: [],
    inputs: [],
    selects: [],
    checkboxes: [],
    links: [],
    forms: [],
    tables: [],
    clickables: [],
    headings: [],
    truncated: [],
    ...overrides,
  };
}

function evidence(roots: RootEvidence[]): InterfaceEvidence {
  return {
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    baseUrl: 'https://rm.test/',
    pages: [{ step: 'login', pageUrl: 'https://rm.test/', pageTitle: '', roots, screenshotPath: null, panelState: null }],
    redactions: { personalDataDropped: 0, passwordFieldsSeen: 0, truncatedCategories: [] },
  };
}

describe('root accounting', () => {
  it('separates roots that failed from roots that were simply empty', () => {
    const stats = rootStats(
      evidence([
        root({ rootName: 'page' }),
        root({ rootName: 'frame:a', error: 'stableAttributes is not iterable' }),
      ]),
    );

    expect(stats).toEqual({ total: 2, failed: 1, succeeded: 1 });
  });

  it('reports every root failing, which is what a broken collector looks like', () => {
    const stats = rootStats(
      evidence([root({ error: 'boom' }), root({ rootName: 'frame:a', error: 'boom' })]),
    );

    expect(stats.succeeded).toBe(0);
    expect(stats.failed).toBe(2);
  });
});

describe('controls that were not observable', () => {
  it('reports the login controls separately when the session was already signed in', () => {
    const skip: Record<string, string> = {};
    for (const control of Object.values(LOGIN_CONTROLS)) {
      skip[control.name] = 'Not observable in this run: the session was already signed in.';
    }

    const outcome = proposeSelectors(evidence([root()]), ALL_CONTROLS, { skip });

    const notObservable = outcome.notObservable.map((entry) => entry.control);
    expect(notObservable).toContain('login.username');
    expect(notObservable).toContain('login.password');
    expect(notObservable).toContain('login.submit');

    // And they are not double-counted as missing.
    const unproposed = outcome.unproposed.map((entry) => entry.control);
    expect(unproposed).not.toContain('login.username');
  });

  it('still accounts for every control exactly once', () => {
    const outcome = proposeSelectors(evidence([root()]), ALL_CONTROLS, {
      skip: { 'login.username': 'not shown' },
    });

    const seen = [
      ...outcome.proposals.map((entry) => entry.control),
      ...outcome.unproposed.map((entry) => entry.control),
      ...outcome.notObservable.map((entry) => entry.control),
    ];

    expect(seen).toHaveLength(ALL_CONTROLS.length);
    expect(new Set(seen).size).toBe(ALL_CONTROLS.length);
  });

  it('treats a control with no skip reason as genuinely unresolved', () => {
    const outcome = proposeSelectors(evidence([root()]), ALL_CONTROLS);

    expect(outcome.notObservable).toEqual([]);
    expect(outcome.unproposed.length).toBe(ALL_CONTROLS.length);
    // The count a caller should display, rather than deriving it wrongly.
    expect(outcome.unproposed.length).toBeGreaterThan(0);
  });
});
