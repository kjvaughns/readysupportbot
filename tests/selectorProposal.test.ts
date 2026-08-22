import { describe, expect, it } from 'vitest';
import { proposeSelectors, promotable } from '../src/readymode/discovery/propose';
import { InterfaceEvidence, RootEvidence } from '../src/readymode/discovery/evidence';
import { ALL_CONTROLS, AGENT_CONTROLS, LOGIN_CONTROLS } from '../src/readymode/selectors';

/**
 * A proposal must be justified by evidence, and must identify exactly one
 * element. Everything else is reported as unproposed — never filled in with
 * something plausible.
 */

function root(overrides: Partial<RootEvidence> = {}): RootEvidence {
  return {
    rootName: 'frame:body',
    rootUrl: 'https://rm.test/body',
    isMain: false,
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

function evidence(roots: RootEvidence[], step = 'login'): InterfaceEvidence {
  return {
    schemaVersion: 1,
    capturedAt: '2026-01-01T00:00:00.000Z',
    baseUrl: 'https://rm.test/',
    pages: [{ step, pageUrl: 'https://rm.test/', pageTitle: 'Readymode', roots, screenshotPath: null, panelState: null }],
    redactions: { personalDataDropped: 0, passwordFieldsSeen: 0, truncatedCategories: [] },
  };
}

const passwordInput = {
  ordinal: 1,
  tag: 'input',
  name: 'password',
  type: 'password',
  required: true,
  readOnly: false,
  sensitive: true,
  visible: true,
  labelText: 'Password',
  attrs: {},
};

describe('proposing selectors from evidence', () => {
  it('proposes a password field from its name', () => {
    const outcome = proposeSelectors(evidence([root({ inputs: [passwordInput as never] })]), [
      LOGIN_CONTROLS.password,
    ]);

    const proposal = outcome.proposals.find((entry) => entry.control === 'login.password');
    expect(proposal).toBeTruthy();
    expect(proposal!.confidence).toBeGreaterThanOrEqual(60);
    expect(proposal!.rootName).toBe('frame:body');
  });

  it('prefers a stable data attribute over a name', () => {
    const outcome = proposeSelectors(
      evidence([
        root({
          inputs: [{ ...passwordInput, attrs: { 'data-testid': 'pwd' } } as never],
        }),
      ]),
      [LOGIN_CONTROLS.password],
    );

    const proposal = outcome.proposals[0];
    expect(proposal.tier).toBe('stable-attribute');
    expect(proposal.strategy).toEqual({ type: 'testId', value: 'pwd' });
  });

  it('refuses to propose when two identical elements exist', () => {
    const outcome = proposeSelectors(
      evidence([
        root({
          inputs: [passwordInput as never, { ...passwordInput, ordinal: 2 } as never],
        }),
      ]),
      [LOGIN_CONTROLS.password],
    );

    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.unproposed[0].reason).toMatch(/uniquely/i);
  });

  it('refuses to propose when the same element appears in two frames', () => {
    const outcome = proposeSelectors(
      evidence([
        root({ rootName: 'frame:a', inputs: [passwordInput as never] }),
        root({ rootName: 'frame:b', inputs: [passwordInput as never] }),
      ]),
      [LOGIN_CONTROLS.password],
    );

    expect(outcome.proposals).toHaveLength(0);
  });

  it('never proposes a destructive button as the save control', () => {
    const outcome = proposeSelectors(
      evidence([
        root({
          buttons: [
            {
              ordinal: 1,
              tag: 'button',
              kind: 'button',
              label: 'Delete Agent',
              disabled: false,
              visible: true,
              attrs: {},
            } as never,
          ],
        }),
      ]),
      [AGENT_CONTROLS.saveButton, AGENT_CONTROLS.deactivate],
    );

    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.unproposed.map((entry) => entry.control)).toContain('agents.save');
    expect(outcome.unproposed.map((entry) => entry.control)).toContain('agents.deactivate');
  });

  it('penalizes an element that is not visible below the usable threshold', () => {
    const outcome = proposeSelectors(
      evidence([root({ inputs: [{ ...passwordInput, visible: false } as never] })]),
      [LOGIN_CONTROLS.password],
    );

    const proposal = outcome.proposals[0];
    expect(proposal.confidence).toBeLessThan(60);
    expect(promotable(proposal)).toBe(false);
  });

  it('accounts for every control, with nothing silently dropped', () => {
    const outcome = proposeSelectors(evidence([root()]), ALL_CONTROLS);
    const named = new Set([
      ...outcome.proposals.map((entry) => entry.control),
      ...outcome.unproposed.map((entry) => entry.control),
    ]);

    for (const control of ALL_CONTROLS) {
      expect(named.has(control.name)).toBe(true);
    }
  });

  it('proposes nothing at all from empty evidence', () => {
    const outcome = proposeSelectors(evidence([]), ALL_CONTROLS);
    expect(outcome.proposals).toHaveLength(0);
    expect(outcome.unproposed).toHaveLength(ALL_CONTROLS.length);
  });

  it('never promotes a structural css path', () => {
    expect(
      promotable({
        control: 'agents.save',
        strategy: { type: 'css', value: 'div > button' },
        tier: 'css-path',
        confidence: 100,
        pageStep: 'x',
        rootName: 'main',
        rootUrl: '',
        evidence: { category: 'button', ordinal: 1, matchedOn: [], excerpt: '' },
      }),
    ).toBe(false);
  });
});
