import { describe, expect, it } from 'vitest';
import { ACTION_TYPES } from '../../src/domain/actions.js';
import {
  allowedActions,
  atLeast,
  BOT_ROLES,
  can,
  canApproveForOthers,
  canManagePermissions,
  canViewAllRequests,
} from '../../src/domain/roles.js';
import { approvalRequirementFor, canApprove, canCancel, deliversCredentials } from '../../src/auth/permissions.js';
import type { Principal } from '../../src/auth/authorize.js';

function principal(role: (typeof BOT_ROLES)[number], id = 'user-1'): Principal {
  return { discordUserId: id, discordUsername: id, botUserId: `bot-${id}`, role };
}

describe('role permissions', () => {
  it('lets OWNER do everything', () => {
    for (const action of ACTION_TYPES) {
      expect(can('OWNER', action)).toBe(true);
    }
  });

  it('lets ADMIN do everything except manage permissions', () => {
    for (const action of ACTION_TYPES) {
      expect(can('ADMIN', action)).toBe(true);
    }
    expect(canManagePermissions('ADMIN')).toBe(false);
    expect(canManagePermissions('OWNER')).toBe(true);
  });

  it('stops SUPPORT deactivating accounts', () => {
    expect(can('SUPPORT', 'CREATE_ACCOUNT')).toBe(true);
    expect(can('SUPPORT', 'CLEAR_LICENSE')).toBe(true);
    expect(can('SUPPORT', 'RESET_PASSWORD')).toBe(true);
    expect(can('SUPPORT', 'DEACTIVATE_ACCOUNT')).toBe(false);
  });

  it('restricts VIEWER to reading', () => {
    expect(allowedActions('VIEWER')).toEqual([
      'CHECK_LICENSE_USAGE',
      'CHECK_AGENT_STATUS',
      'LIST_RECENT_ACTIONS',
    ]);

    for (const action of ['CREATE_ACCOUNT', 'CLEAR_LICENSE', 'RESET_PASSWORD', 'DEACTIVATE_ACCOUNT'] as const) {
      expect(can('VIEWER', action)).toBe(false);
    }
  });

  it('scopes the audit view: VIEWER sees only their own requests', () => {
    expect(canViewAllRequests('VIEWER')).toBe(false);
    expect(canViewAllRequests('SUPPORT')).toBe(true);
    expect(canViewAllRequests('ADMIN')).toBe(true);
    expect(canViewAllRequests('OWNER')).toBe(true);
  });

  it('limits who can approve on behalf of someone else', () => {
    expect(canApproveForOthers('VIEWER')).toBe(false);
    expect(canApproveForOthers('SUPPORT')).toBe(false);
    expect(canApproveForOthers('ADMIN')).toBe(true);
    expect(canApproveForOthers('OWNER')).toBe(true);
  });

  it('orders roles by authority', () => {
    expect(atLeast('OWNER', 'ADMIN')).toBe(true);
    expect(atLeast('SUPPORT', 'ADMIN')).toBe(false);
    expect(atLeast('ADMIN', 'ADMIN')).toBe(true);
  });
});

describe('approval requirements', () => {
  it('needs no confirmation for read-only actions', () => {
    for (const action of [
      { action: 'CHECK_LICENSE_USAGE' } as const,
      { action: 'CHECK_AGENT_STATUS', target: { username: 'a' } } as const,
      { action: 'LIST_RECENT_ACTIONS', limit: 5, status: 'ALL' } as const,
    ]) {
      expect(approvalRequirementFor(action as never).required).toBe(false);
    }
  });

  it('requires confirmation for every mutating action', () => {
    const requirement = approvalRequirementFor({
      action: 'CLEAR_LICENSE',
      target: { username: 'jbrown' },
      overrideActiveCall: false,
    });

    expect(requirement.required).toBe(true);
    expect(requirement.independent).toBe(false);
  });

  it('requires an independent approver for deactivation', () => {
    const requirement = approvalRequirementFor({
      action: 'DEACTIVATE_ACCOUNT',
      target: { username: 'jbrown' },
    });

    expect(requirement.required).toBe(true);
    expect(requirement.independent).toBe(true);
    expect(requirement.minimumRole).toBe('ADMIN');
  });
});

describe('who may approve', () => {
  const independent = { independent: true, minimumRole: 'ADMIN' } as const;
  const ordinary = { independent: false, minimumRole: 'SUPPORT' } as const;

  it('refuses to let the requester approve their own deactivation', () => {
    const decision = canApprove({
      approver: principal('OWNER', 'same-person'),
      requesterDiscordId: 'same-person',
      requirement: independent,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.message).toMatch(/second pair of eyes/i);
  });

  it('accepts a different admin for a deactivation', () => {
    expect(
      canApprove({
        approver: principal('ADMIN', 'someone-else'),
        requesterDiscordId: 'requester',
        requirement: independent,
      }).allowed,
    ).toBe(true);
  });

  it('refuses a different SUPPORT user for a deactivation', () => {
    const decision = canApprove({
      approver: principal('SUPPORT', 'someone-else'),
      requesterDiscordId: 'requester',
      requirement: independent,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.message).toMatch(/owner or an admin/i);
  });

  it('lets the requester confirm their own ordinary request', () => {
    expect(
      canApprove({
        approver: principal('SUPPORT', 'requester'),
        requesterDiscordId: 'requester',
        requirement: ordinary,
      }).allowed,
    ).toBe(true);
  });

  it('stops an unrelated SUPPORT user confirming somebody else request', () => {
    expect(
      canApprove({
        approver: principal('SUPPORT', 'bystander'),
        requesterDiscordId: 'requester',
        requirement: ordinary,
      }).allowed,
    ).toBe(false);
  });
});

describe('cancellation', () => {
  it('lets the requester cancel', () => {
    expect(
      canCancel({ actor: principal('VIEWER', 'requester'), requesterDiscordId: 'requester' }).allowed,
    ).toBe(true);
  });

  it('lets an admin cancel somebody else request', () => {
    expect(canCancel({ actor: principal('ADMIN', 'admin'), requesterDiscordId: 'requester' }).allowed).toBe(true);
  });

  it('stops a bystander cancelling', () => {
    expect(
      canCancel({ actor: principal('SUPPORT', 'bystander'), requesterDiscordId: 'requester' }).allowed,
    ).toBe(false);
  });
});

describe('credential delivery', () => {
  it('marks the two actions that produce a password', () => {
    expect(deliversCredentials('CREATE_ACCOUNT')).toBe(true);
    expect(deliversCredentials('RESET_PASSWORD')).toBe(true);
    expect(deliversCredentials('CLEAR_LICENSE')).toBe(false);
    expect(deliversCredentials('CHECK_AGENT_STATUS')).toBe(false);
  });
});
