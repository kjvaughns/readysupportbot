import { ActionType } from '../../types';

/**
 * Capabilities group the individual controls into the things a user actually
 * asks for, so the connection test can report "clearing a licence works" rather
 * than listing selector names.
 *
 * `allowBuiltin` is the safety line. Read-only capabilities may run on the
 * built-in candidate selectors, because the worst case is failing to find
 * something. Anything that writes to Readymode may not: it requires selectors
 * that came from the real interface, so a guess can never click Save.
 */

export type ControlSource = 'approved_profile' | 'observed_file' | 'builtin' | 'none';
export type ControlState = 'verified' | 'unverified' | 'ambiguous' | 'missing';

export interface ControlStatus {
  control: string;
  required: boolean;
  state: ControlState;
  source: ControlSource;
  strategy?: string;
  root?: string;
  rootUrl?: string;
  visibleMatches: number;
  attachedMatches: number;
  note?: string;
}

export type CapabilityId =
  | 'login'
  | 'agent_search'
  | 'agent_results'
  | 'create_account'
  | 'clear_license'
  | 'password_reset'
  | 'deactivate'
  | 'states'
  | 'campaigns'
  | 'queues'
  | 'playlists'
  | 'bulk_license_clear'
  | 'force_logout'
  | 'save';

export interface CapabilityDefinition {
  id: CapabilityId;
  /** Used verbatim in the refusal message, so it reads as a sentence. */
  label: string;
  requiredControls: string[];
  /** Controls where any one of the set satisfies the requirement. */
  anyOfControls?: string[][];
  allowBuiltin: boolean;
  actionTypes: ActionType[];
}

export const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: 'login',
    label: 'sign in to Readymode',
    requiredControls: ['login.username', 'login.password', 'login.submit'],
    // Filling a login form changes nothing inside Readymode, and login is
    // already demonstrably working.
    allowBuiltin: true,
    actionTypes: [],
  },
  {
    id: 'agent_search',
    label: 'search for an agent',
    requiredControls: ['agents.search'],
    allowBuiltin: true,
    actionTypes: [],
  },
  {
    id: 'agent_results',
    label: 'read the agent list',
    requiredControls: ['agents.rows'],
    allowBuiltin: true,
    actionTypes: ['AGENT_STATUS', 'LICENSE_USAGE'],
  },
  {
    id: 'create_account',
    label: 'create an agent account',
    requiredControls: ['agents.create', 'agents.save'],
    allowBuiltin: false,
    actionTypes: ['CREATE_ACCOUNT', 'CREATE_ACCOUNTS'],
  },
  {
    id: 'clear_license',
    label: 'clear an agent licence',
    requiredControls: ['agents.clear_license'],
    allowBuiltin: false,
    actionTypes: ['CLEAR_LICENSE'],
  },
  {
    id: 'password_reset',
    label: 'reset an agent password',
    requiredControls: ['agents.reset_password'],
    allowBuiltin: false,
    actionTypes: ['RESET_PASSWORD'],
  },
  {
    id: 'deactivate',
    label: 'deactivate an agent account',
    requiredControls: ['agents.deactivate'],
    allowBuiltin: false,
    actionTypes: ['DEACTIVATE_ACCOUNT'],
  },
  {
    id: 'states',
    label: 'change which states an agent receives',
    requiredControls: ['states.section'],
    anyOfControls: [['states.multiselect', 'states.checkboxes']],
    allowBuiltin: false,
    actionTypes: ['SET_STATES', 'ADD_STATES', 'REMOVE_STATES', 'COPY_STATE_CONFIGURATION'],
  },
  {
    id: 'campaigns',
    label: 'assign campaigns',
    requiredControls: ['campaigns.section', 'campaigns.save'],
    allowBuiltin: false,
    actionTypes: ['ASSIGN_CAMPAIGNS'],
  },
  {
    id: 'queues',
    label: 'assign queues and playlists',
    requiredControls: ['queues.section', 'queues.save'],
    allowBuiltin: false,
    actionTypes: ['ASSIGN_QUEUES'],
  },
  {
    id: 'playlists',
    label: 'assign an agent to a playlist',
    requiredControls: ['playlists.section', 'playlists.save'],
    allowBuiltin: false,
    actionTypes: ['ASSIGN_PLAYLIST', 'REMOVE_PLAYLIST'],
  },
  {
    id: 'bulk_license_clear',
    label: 'log out inactive users',
    requiredControls: ['users.log_out_inactive'],
    allowBuiltin: false,
    actionTypes: ['CLEAR_ALL_LICENSES'],
  },
  {
    id: 'force_logout',
    label: 'sign a specific user out of Readymode',
    requiredControls: ['agents.force_logout'],
    allowBuiltin: false,
    actionTypes: ['FORCE_LOGOUT'],
  },
  {
    id: 'save',
    label: 'save a change to an agent',
    requiredControls: ['agents.save'],
    allowBuiltin: false,
    actionTypes: [],
  },
];

export interface CapabilityStatus {
  capability: CapabilityId;
  label: string;
  usable: boolean;
  controls: ControlStatus[];
  /** Controls that are not usable evidence for this capability. */
  missing: string[];
  blockedReason?: string;
}

function isUsable(status: ControlStatus | undefined, allowBuiltin: boolean): boolean {
  if (!status || status.state !== 'verified') return false;
  if (status.source === 'builtin' && !allowBuiltin) return false;
  return status.source !== 'none';
}

/** Rolls per-control results up into the capability report. */
export function capabilityStatuses(controls: ControlStatus[]): CapabilityStatus[] {
  const byName = new Map(controls.map((status) => [status.control, status]));

  return CAPABILITIES.map((capability) => {
    const involved = [
      ...capability.requiredControls,
      ...(capability.anyOfControls?.flat() ?? []),
    ];
    const statuses = involved
      .map((name) => byName.get(name))
      .filter((status): status is ControlStatus => Boolean(status));

    const missing = capability.requiredControls.filter(
      (name) => !isUsable(byName.get(name), capability.allowBuiltin),
    );

    for (const group of capability.anyOfControls ?? []) {
      if (!group.some((name) => isUsable(byName.get(name), capability.allowBuiltin))) {
        missing.push(group.join(' or '));
      }
    }

    const usable = missing.length === 0;
    const builtinBlocked =
      !capability.allowBuiltin &&
      capability.requiredControls.some((name) => byName.get(name)?.source === 'builtin');

    return {
      capability: capability.id,
      label: capability.label,
      usable,
      controls: statuses,
      missing,
      blockedReason: usable
        ? undefined
        : builtinBlocked
          ? 'These controls have only been matched by ReadySupport’s built-in guesses, which are not used for changes. Run interface discovery so they come from the real interface.'
          : 'These controls have not been identified in the real Readymode interface yet.',
    };
  });
}

export function capabilityForAction(action: ActionType): CapabilityDefinition | null {
  return CAPABILITIES.find((capability) => capability.actionTypes.includes(action)) ?? null;
}
