import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TTL_MS,
  approvalRequirement,
  evaluateApproval,
  isApprovalExpired,
  remainingApprovalMs,
  requiresSecondApprover,
} from '../src/approvals';
import { Action } from '../src/openai/schema';
import { AutomationApproval, AutomationRequest } from '../src/types';

const setStates: Action = {
  action: 'SET_STATES',
  target: { kind: 'self' },
  states: ['TX', 'VA', 'OH'],
};

const deactivate: Action = {
  action: 'DEACTIVATE_ACCOUNT',
  target: { kind: 'username', username: 'mwebb' },
};

const bulkCreate: Action = {
  action: 'CREATE_ACCOUNTS',
  accounts: [{ fullName: 'Ada Lovelace' }, { fullName: 'Alan Turing' }],
};

function request(overrides: Partial<AutomationRequest> = {}): AutomationRequest {
  const now = new Date().toISOString();
  return {
    id: 'req-1',
    reference: 'RS 1048',
    organizationId: 'org-1',
    status: 'AWAITING_APPROVAL',
    actionType: 'SET_STATES',
    payload: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as AutomationRequest;
}

function approval(overrides: Partial<AutomationApproval> = {}): AutomationApproval {
  return {
    id: 'a1',
    requestId: 'req-1',
    organizationId: 'org-1',
    approverDiscordUserId: '900',
    approverRole: 'support',
    sequence: 1,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as AutomationApproval;
}

describe('approval requirements', () => {
  it('needs one confirmation for an ordinary change', () => {
    expect(requiresSecondApprover(setStates)).toBe(false);
    expect(approvalRequirement(setStates).required).toBe(1);
  });

  it('needs a second approver for deactivation', () => {
    expect(requiresSecondApprover(deactivate)).toBe(true);
    expect(approvalRequirement(deactivate).required).toBe(2);
  });

  it('needs a second approver for bulk account creation', () => {
    expect(requiresSecondApprover(bulkCreate)).toBe(true);
    expect(requiresSecondApprover({ action: 'CREATE_ACCOUNTS', accounts: [{ fullName: 'Solo Agent' }] })).toBe(
      false,
    );
  });

  it('treats a default-state change as a bulk change', () => {
    expect(requiresSecondApprover({ action: 'SET_DEFAULT_STATES', states: ['TX'] })).toBe(true);
  });
});

describe('approval expiry', () => {
  it('expires ten minutes after the confirmation was shown', () => {
    expect(APPROVAL_TTL_MS).toBe(600_000);
    const shown = new Date('2026-01-01T00:00:00Z').toISOString();

    expect(isApprovalExpired(shown, Date.parse('2026-01-01T00:09:59Z'))).toBe(false);
    expect(isApprovalExpired(shown, Date.parse('2026-01-01T00:10:01Z'))).toBe(true);
    expect(remainingApprovalMs(shown, Date.parse('2026-01-01T00:05:00Z'))).toBe(300_000);
    expect(remainingApprovalMs(shown, Date.parse('2026-01-01T01:00:00Z'))).toBe(0);
  });

  it('rejects an expired confirmation', () => {
    const decision = evaluateApproval({
      request: request(),
      action: setStates,
      approver: { discordUserId: '900', role: 'support' },
      existingApprovals: [],
      awaitingSince: new Date(Date.now() - APPROVAL_TTL_MS - 1000).toISOString(),
    });

    expect(decision.status).toBe('rejected');
    if (decision.status === 'rejected') expect(decision.reason).toMatch(/expired/i);
  });
});

describe('approval decisions', () => {
  const awaitingSince = new Date().toISOString();

  it('approves a single-confirmation change', () => {
    const decision = evaluateApproval({
      request: request(),
      action: setStates,
      approver: { discordUserId: '900', role: 'support' },
      existingApprovals: [],
      awaitingSince,
    });
    expect(decision).toEqual({ status: 'approved', approvals: 1 });
  });

  it('holds a deactivation after the first approval', () => {
    const decision = evaluateApproval({
      request: request({ actionType: 'DEACTIVATE_ACCOUNT' }),
      action: deactivate,
      approver: { discordUserId: '900', role: 'administrator' },
      existingApprovals: [],
      awaitingSince,
    });
    expect(decision).toEqual({ status: 'awaiting_second', approvals: 1, needed: 2 });
  });

  it('completes a deactivation with a second Administrator', () => {
    const decision = evaluateApproval({
      request: request({ actionType: 'DEACTIVATE_ACCOUNT' }),
      action: deactivate,
      approver: { discordUserId: '901', role: 'owner' },
      existingApprovals: [approval({ approverRole: 'administrator' })],
      awaitingSince,
    });
    expect(decision.status).toBe('approved');
  });

  it('refuses a second approval from someone below Administrator', () => {
    const decision = evaluateApproval({
      request: request({ actionType: 'DEACTIVATE_ACCOUNT' }),
      action: deactivate,
      approver: { discordUserId: '902', role: 'support' },
      existingApprovals: [approval({ approverRole: 'administrator' })],
      awaitingSince,
    });
    expect(decision.status).toBe('rejected');
  });

  it('refuses the same person approving twice', () => {
    const decision = evaluateApproval({
      request: request({ actionType: 'DEACTIVATE_ACCOUNT' }),
      action: deactivate,
      approver: { discordUserId: '900', role: 'administrator' },
      existingApprovals: [approval({ approverDiscordUserId: '900', approverRole: 'administrator' })],
      awaitingSince,
    });
    expect(decision.status).toBe('rejected');
    if (decision.status === 'rejected') expect(decision.reason).toMatch(/already approved/i);
  });

  it('refuses an approver who lacks permission for the action', () => {
    const decision = evaluateApproval({
      request: request(),
      action: setStates,
      approver: { discordUserId: '905', role: 'viewer' },
      existingApprovals: [],
      awaitingSince,
    });
    expect(decision.status).toBe('rejected');
    if (decision.status === 'rejected') expect(decision.reason).toMatch(/permission/i);
  });

  it('refuses a request that is no longer waiting', () => {
    const decision = evaluateApproval({
      request: request({ status: 'COMPLETED' }),
      action: setStates,
      approver: { discordUserId: '900', role: 'support' },
      existingApprovals: [],
      awaitingSince,
    });
    expect(decision.status).toBe('rejected');
  });
});
