import { z } from 'zod';
import { ACTION_TYPES, type ActionType } from './actions.js';

/**
 * Internal bot roles. Deliberately independent of Discord role names — a
 * Discord server admin renaming a role must never change what the bot allows.
 * Authority comes from the bot_users table only.
 */
export const BOT_ROLES = ['OWNER', 'ADMIN', 'SUPPORT', 'VIEWER'] as const;
export type BotRole = (typeof BOT_ROLES)[number];
export const botRoleSchema = z.enum(BOT_ROLES);

/** Higher number wins when comparing authority. */
const RANK: Record<BotRole, number> = {
  VIEWER: 0,
  SUPPORT: 1,
  ADMIN: 2,
  OWNER: 3,
};

/**
 * The permission matrix. Explicit per role rather than inherited so that
 * reading this table tells you exactly what a role can do.
 */
const PERMISSIONS: Record<BotRole, ReadonlySet<ActionType>> = {
  OWNER: new Set<ActionType>(ACTION_TYPES),
  ADMIN: new Set<ActionType>([
    'CREATE_ACCOUNT',
    'CLEAR_LICENSE',
    'RESET_PASSWORD',
    'DEACTIVATE_ACCOUNT',
    'CHECK_LICENSE_USAGE',
    'CHECK_AGENT_STATUS',
    'LIST_RECENT_ACTIONS',
  ]),
  SUPPORT: new Set<ActionType>([
    'CREATE_ACCOUNT',
    'CLEAR_LICENSE',
    'RESET_PASSWORD',
    'CHECK_LICENSE_USAGE',
    'CHECK_AGENT_STATUS',
    'LIST_RECENT_ACTIONS',
  ]),
  VIEWER: new Set<ActionType>(['CHECK_LICENSE_USAGE', 'CHECK_AGENT_STATUS', 'LIST_RECENT_ACTIONS']),
};

/** Can this role request this action at all? */
export function can(role: BotRole, action: ActionType): boolean {
  return PERMISSIONS[role].has(action);
}

/** Every action the role may request, in declaration order. */
export function allowedActions(role: BotRole): ActionType[] {
  return ACTION_TYPES.filter((action) => can(role, action));
}

/** Only OWNER manages who else may use the bot. */
export function canManagePermissions(role: BotRole): boolean {
  return role === 'OWNER';
}

/**
 * VIEWER may list actions, but only their own. Everyone above sees the whole
 * audit history.
 */
export function canViewAllRequests(role: BotRole): boolean {
  return RANK[role] >= RANK.SUPPORT;
}

/** Roles permitted to act as the independent second approver. */
export function canApproveForOthers(role: BotRole): boolean {
  return RANK[role] >= RANK.ADMIN;
}

export function atLeast(role: BotRole, minimum: BotRole): boolean {
  return RANK[role] >= RANK[minimum];
}

export function rankOf(role: BotRole): number {
  return RANK[role];
}
