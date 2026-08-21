import { getStore } from '../database';
import { ActionType, Role, ROLES } from '../types';
import { ACTION_PERMISSIONS, atLeast, hasPermission } from './index';
import { PermissionError } from '../security/errors';

/**
 * Per-action role requirements, configurable per organization.
 *
 * The built-in role-to-permission table is the floor. An Owner can raise the bar
 * for a specific action — for example requiring an Administrator to create
 * accounts, even though Support normally may — without a code change.
 *
 * Overrides can only ever be stricter. Lowering an action below what its
 * permission already requires would let a role do something its permission set
 * does not grant, so it is refused.
 */

const SETTINGS_KEY = 'action_minimum_roles';

export type ActionRoleOverrides = Partial<Record<ActionType, Role>>;

/**
 * Defaults for the actions that most often need tightening. Everything absent
 * here falls back to the role-to-permission table.
 */
export const DEFAULT_ACTION_ROLES: ActionRoleOverrides = {
  // Signing someone out, or resetting their password to free a seat, interrupts
  // a person who is working. Administrators by default.
  FORCE_LOGOUT: 'administrator',
  RESET_PASSWORD: 'administrator',
  DEACTIVATE_ACCOUNT: 'administrator',
};

export async function getActionRoles(organizationId: string): Promise<ActionRoleOverrides> {
  const stored = await getStore()
    .getSetting<ActionRoleOverrides>(organizationId, SETTINGS_KEY)
    .catch(() => null);

  return { ...DEFAULT_ACTION_ROLES, ...(stored ?? {}) };
}

export async function setActionRole(
  organizationId: string,
  action: ActionType,
  role: Role | null,
): Promise<ActionRoleOverrides> {
  const current = await getStore()
    .getSetting<ActionRoleOverrides>(organizationId, SETTINGS_KEY)
    .catch(() => null);

  const next: ActionRoleOverrides = { ...(current ?? {}) };
  if (role === null) delete next[action];
  else next[action] = role;

  await getStore().setSetting(organizationId, SETTINGS_KEY, next);
  return { ...DEFAULT_ACTION_ROLES, ...next };
}

export function isRoleValue(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * The full check: the action's permission must be held, and any configured
 * minimum role must be met.
 */
export function checkActionAccess(
  role: Role,
  action: ActionType,
  overrides: ActionRoleOverrides,
): { allowed: true } | { allowed: false; reason: string } {
  const permission = ACTION_PERMISSIONS[action];

  if (permission && !hasPermission(role, permission)) {
    return {
      allowed: false,
      reason: `Your role (${role}) cannot ${permission.replace(/_/g, ' ')}.`,
    };
  }

  const minimum = overrides[action];
  if (minimum && !atLeast(role, minimum)) {
    return {
      allowed: false,
      reason: `${action.toLowerCase().replace(/_/g, ' ')} is restricted to ${minimum} and above in this organization.`,
    };
  }

  return { allowed: true };
}

export async function requireActionAccess(
  organizationId: string,
  role: Role,
  action: ActionType,
): Promise<void> {
  const result = checkActionAccess(role, action, await getActionRoles(organizationId));
  if (!result.allowed) throw new PermissionError(result.reason);
}
