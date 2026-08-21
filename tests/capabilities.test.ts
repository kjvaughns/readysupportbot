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

describe('where a capability is verified', () => {
  it('names the screen its controls live on', () => {
    // Checking for a per-row "Sign Out" while the session sits on the dashboard
    // finds nothing and would conclude the capability is unusable — which is
    // true of the dashboard and says nothing about License Usage.
    const byId = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));

    expect(byId.get('force_logout')?.panel).toBe('licenses');
    expect(byId.get('bulk_license_clear')?.panel).toBe('licenses');
    expect(byId.get('create_account')?.panel).toBe('users');
    expect(byId.get('agent_search')?.panel).toBe('users');
  });

  it('leaves the screen unset where the controls are on a record, not a screen', () => {
    const byId = new Map(CAPABILITIES.map((capability) => [capability.id, capability]));
    // States, campaigns and queues are assigned on an individual agent's
    // record, which the workflow opens by matching the person.
    expect(byId.get('states')?.panel).toBeUndefined();
    expect(byId.get('campaigns')?.panel).toBeUndefined();
  });
});

describe('evidence is not authorization', () => {
  it('refuses a change resolved only from the recorded inspection', () => {
    const [capability] = capabilityStatuses([
      status({ control: 'agents.force_logout', source: 'interface_map' }),
    ]).filter((entry) => entry.capability === 'force_logout');

    // The inspection is a good claim about the interface. It is not somebody
    // with authority saying to act on this account.
    expect(capability.usable).toBe(false);
    expect(capability.blockedReason).toMatch(/no Owner has approved/i);
  });

  it('refuses a change resolved only from the committed file', () => {
    const [capability] = capabilityStatuses([
      status({ control: 'agents.force_logout', source: 'observed_file' }),
    ]).filter((entry) => entry.capability === 'force_logout');

    expect(capability.usable).toBe(false);
  });

  it('allows a read on any source that found the control', () => {
    for (const source of ['interface_map', 'observed_file', 'builtin'] as const) {
      const [capability] = capabilityStatuses([
        status({ control: 'agents.rows', source }),
      ]).filter((entry) => entry.capability === 'agent_results');

      expect(capability.usable, source).toBe(true);
    }
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

  it('covers every capability group the connection test reports', () => {
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
      'playlists',
      'bulk_license_clear',
      'force_logout',
      'save',
    ]);
  });

  it('will not log out inactive users on a guessed selector', () => {
    const [bulk] = capabilityStatuses([
      status({ control: 'users.log_out_inactive', source: 'builtin' }),
    ]).filter((entry) => entry.capability === 'bulk_license_clear');

    expect(bulk.usable).toBe(false);
  });
});
