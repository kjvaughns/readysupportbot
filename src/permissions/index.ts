import { ActionType, Permission, Role, ROLES } from '../types';
import { PermissionError } from '../security/errors';

/**
 * Role to permission mapping. Roles are additive from the bottom up: a Viewer
 * can read, Support can operate, Administrators can change configuration, and
 * Owners additionally manage connections and membership.
 */
const VIEWER_PERMISSIONS: Permission[] = [
  'check_agent_status',
  'check_license_usage',
  'view_activity',
];

const SUPPORT_PERMISSIONS: Permission[] = [
  ...VIEWER_PERMISSIONS,
  'create_accounts',
  'clear_licenses',
  'reset_passwords',
  'configure_states',
  'configure_campaigns',
  'configure_queues',
];

const ADMINISTRATOR_PERMISSIONS: Permission[] = [
  ...SUPPORT_PERMISSIONS,
  'deactivate_accounts',
  'manage_members',
];

const OWNER_PERMISSIONS: Permission[] = [...ADMINISTRATOR_PERMISSIONS, 'manage_connections'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: OWNER_PERMISSIONS,
  administrator: ADMINISTRATOR_PERMISSIONS,
  support: SUPPORT_PERMISSIONS,
  viewer: VIEWER_PERMISSIONS,
};

/** Ranking used for "at least this role" checks. */
const ROLE_RANK: Record<Role, number> = {
  owner: 4,
  administrator: 3,
  support: 2,
  viewer: 1,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

export function requirePermission(role: Role, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new PermissionError(
      `Your role (${role}) cannot ${permission.replace(/_/g, ' ')}.`,
    );
  }
}

export function atLeast(role: Role, minimum: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

/** Picks the most capable role when a Discord user holds several mapped roles. */
export function highestRole(roles: Role[]): Role | null {
  if (roles.length === 0) return null;
  return roles.reduce((best, role) => (ROLE_RANK[role] > ROLE_RANK[best] ? role : best));
}

/** The permission each supported action requires. */
export const ACTION_PERMISSIONS: Record<ActionType, Permission | null> = {
  CREATE_ACCOUNT: 'create_accounts',
  CREATE_ACCOUNTS: 'create_accounts',
  CLEAR_LICENSE: 'clear_licenses',
  RESET_PASSWORD: 'reset_passwords',
  DEACTIVATE_ACCOUNT: 'deactivate_accounts',
  AGENT_STATUS: 'check_agent_status',
  LICENSE_USAGE: 'check_license_usage',
  ASSIGN_CAMPAIGNS: 'configure_campaigns',
  ASSIGN_QUEUES: 'configure_queues',
  VIEW_STATES: 'check_agent_status',
  SET_STATES: 'configure_states',
  ADD_STATES: 'configure_states',
  REMOVE_STATES: 'configure_states',
  COPY_STATE_CONFIGURATION: 'configure_states',
  SET_DEFAULT_STATES: 'configure_states',
  RECENT_ACTIONS: 'view_activity',
  CONNECTION_STATUS: 'view_activity',
  HELP: null,
  UNSUPPORTED: null,
};

export function requireActionPermission(role: Role, action: ActionType): void {
  const permission = ACTION_PERMISSIONS[action];
  if (permission) requirePermission(role, permission);
}

/** Actions that write to Readymode and therefore always need confirmation. */
export const MODIFYING_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'CREATE_ACCOUNT',
  'CREATE_ACCOUNTS',
  'CLEAR_LICENSE',
  'RESET_PASSWORD',
  'DEACTIVATE_ACCOUNT',
  'ASSIGN_CAMPAIGNS',
  'ASSIGN_QUEUES',
  'SET_STATES',
  'ADD_STATES',
  'REMOVE_STATES',
  'COPY_STATE_CONFIGURATION',
  'SET_DEFAULT_STATES',
]);

export function isModifyingAction(action: ActionType): boolean {
  return MODIFYING_ACTIONS.has(action);
}
