import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ControlStatus,
  capabilityForAction,
  capabilityStatuses,
} from '../src/readymode/selectors/capabilities';
import { MODIFYING_ACTIONS } from '../src/permissions';

/**
 * The rule these protect: a guessed selector may be used to read Readymode, but
 * never to change it.
 */

function status(overrides: Partial<ControlStatus> & { control: string }): ControlStatus {
  return {
    required: true,
    state: 'verified',
    source: 'approved_profile',
    visibleMatches: 1,
    attachedMatches: 1,
    ...overrides,
  };
}

describe('capability rollup', () => {
  it('marks a licence clear usable when its control came from an approved profile', () => {
    const [capability] = capabilityStatuses([
      status({ control: 'agents.clear_license' }),
    ]).filter((entry) => entry.capability === 'clear_license');

    expect(capability.usable).toBe(true);
  });

  it('refuses a licence clear when the control only matched a built-in guess', () => {
    const [capability] = capabilityStatuses([
      status({ control: 'agents.clear_license', source: 'builtin' }),
    ]).filter((entry) => entry.capability === 'clear_license');

    expect(capability.usable).toBe(false);
    expect(capability.missing).toContain('agents.clear_license');
    expect(capability.blockedReason).toMatch(/built-in guesses/i);
  });

  it('allows signing in on built-in selectors, because it changes nothing', () => {
    const [login] = capabilityStatuses([
      status({ control: 'login.username', source: 'builtin' }),
      status({ control: 'login.password', source: 'builtin' }),
      status({ control: 'login.submit', source: 'builtin' }),
    ]).filter((entry) => entry.capability === 'login');

    expect(login.usable).toBe(true);
  });

  it('refuses when a control was found but was ambiguous', () => {
    const [capability] = capabilityStatuses([
      status({ control: 'agents.deactivate', state: 'ambiguous', source: 'none' }),
    ]).filter((entry) => entry.capability === 'deactivate');

    expect(capability.usable).toBe(false);
  });

  it('treats the state controls as satisfied by either shape', () => {
    const withSelect = capabilityStatuses([
      status({ control: 'states.section' }),
      status({ control: 'states.multiselect' }),
    ]).find((entry) => entry.capability === 'states');
    expect(withSelect?.usable).toBe(true);

    const withCheckboxes = capabilityStatuses([
      status({ control: 'states.section' }),
      status({ control: 'states.checkboxes' }),
    ]).find((entry) => entry.capability === 'states');
    expect(withCheckboxes?.usable).toBe(true);

    const withNeither = capabilityStatuses([status({ control: 'states.section' })]).find(
      (entry) => entry.capability === 'states',
    );
    expect(withNeither?.usable).toBe(false);
  });

  it('reports nothing as usable when no controls were found', () => {
    const capabilities = capabilityStatuses([]);
    expect(capabilities.every((entry) => !entry.usable)).toBe(true);
  });
});

describe('action to capability mapping', () => {
  it('gates every modifying action that drives a browser behind a capability', () => {
    // SET_DEFAULT_STATES is stored in the database and never touches Readymode.
    const browserActions = [...MODIFYING_ACTIONS].filter(
      (action) => action !== 'SET_DEFAULT_STATES',
    );

    for (const action of browserActions) {
      const capability = capabilityForAction(action);
      expect(capability, `${action} has no capability`).not.toBeNull();
      expect(capability!.allowBuiltin, `${action} must not run on guesses`).toBe(false);
    }
  });

  it('does not gate read-only status checks behind evidence', () => {
    expect(capabilityForAction('AGENT_STATUS')?.allowBuiltin).toBe(true);
    expect(capabilityForAction('LICENSE_USAGE')?.allowBuiltin).toBe(true);
  });

  it('covers the eleven capability groups the connection test reports', () => {
    expect(CAPABILITIES.map((entry) => entry.id)).toEqual([
      'login',
      'agent_search',
      'agent_results',
      'create_account',
      'clear_license',
      'password_reset',
      'deactivate',
      'states',
      'campaigns',
      'queues',
      'save',
    ]);
  });
});
