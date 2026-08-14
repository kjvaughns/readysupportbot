import { describe, expect, it } from 'vitest';
import { MockReadymodeService } from '../../src/readymode/mock/mockReadymodeService.js';
import type { ReadySupportError } from '../../src/domain/errors.js';
import type { WorkflowContext } from '../../src/readymode/port.js';

/**
 * The mock driver has to behave like the live one in the ways that matter, or
 * local development teaches the wrong lessons. These check the parts that are
 * easy to get subtly wrong: refusing ambiguity, refusing to act on someone
 * mid-call, and stopping short in dry run.
 */

const context = (overrides: Partial<WorkflowContext> = {}): WorkflowContext => ({
  requestId: 'req-1',
  reference: 1000,
  dryRun: false,
  ...overrides,
});

async function categoryOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no-error';
  } catch (error) {
    return (error as ReadySupportError).category;
  }
}

describe('the mock Readymode driver', () => {
  it('refuses an ambiguous name instead of picking one', async () => {
    const service = new MockReadymodeService();

    expect(
      await categoryOf(
        service.checkAgentStatus({ action: 'CHECK_AGENT_STATUS', target: { fullName: 'Marcus Smith' } }, context()),
      ),
    ).toBe('AMBIGUOUS_MATCH');
  });

  it('resolves the same name once a username is given', async () => {
    const service = new MockReadymodeService();

    const result = await service.checkAgentStatus(
      { action: 'CHECK_AGENT_STATUS', target: { username: 'msmith2' } },
      context(),
    );

    expect(result.data.fullName).toBe('Marcus Smith');
    expect(result.data.agentRole).toBe('Supervisor');
  });

  it('will not clear a license from someone on a call without an override', async () => {
    const service = new MockReadymodeService();

    expect(
      await categoryOf(
        service.clearLicense(
          { action: 'CLEAR_LICENSE', target: { username: 'sgarcia' }, overrideActiveCall: false },
          context(),
        ),
      ),
    ).toBe('PRECONDITION_FAILED');

    // And the license is untouched.
    expect(service.listAccounts().find((a) => a.username === 'sgarcia')?.licenseInUse).toBe(true);
  });

  it('clears it when an admin has acknowledged the call', async () => {
    const service = new MockReadymodeService();

    const result = await service.clearLicense(
      { action: 'CLEAR_LICENSE', target: { username: 'sgarcia' }, overrideActiveCall: true },
      context(),
    );

    expect(result.data.before.licenseInUse).toBe(true);
    expect(result.data.after.licenseInUse).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('changes nothing in a dry run', async () => {
    const service = new MockReadymodeService();

    const result = await service.clearLicense(
      { action: 'CLEAR_LICENSE', target: { username: 'jbrown' }, overrideActiveCall: false },
      context({ dryRun: true }),
    );

    expect(result.dryRun).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.notes?.[0]).toMatch(/not cleared/i);
    expect(service.listAccounts().find((a) => a.username === 'jbrown')?.licenseInUse).toBe(true);
  });

  it('refuses a duplicate email and a duplicate username', async () => {
    const service = new MockReadymodeService();

    const base = {
      action: 'CREATE_ACCOUNT' as const,
      firstName: 'New',
      lastName: 'Person',
      agentRole: 'Agent',
      licenseType: 'Standard',
      active: true,
    };

    expect(
      await categoryOf(
        service.createAccount({ ...base, email: 'john.brown@example.com', username: 'newperson' }, context()),
      ),
    ).toBe('PRECONDITION_FAILED');

    expect(
      await categoryOf(
        service.createAccount({ ...base, email: 'new.person@example.com', username: 'jbrown' }, context()),
      ),
    ).toBe('PRECONDITION_FAILED');
  });

  it('creates an account and returns a password without storing one', async () => {
    const service = new MockReadymodeService();

    const result = await service.createAccount(
      {
        action: 'CREATE_ACCOUNT',
        firstName: 'New',
        lastName: 'Person',
        email: 'new.person@example.com',
        username: 'nperson',
        agentRole: 'Agent',
        licenseType: 'Standard',
        active: true,
      },
      context(),
    );

    expect(result.data.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    expect(result.data.passwordSource).toBe('generated');
    expect(service.listAccounts().some((a) => a.username === 'nperson')).toBe(true);

    // Nothing in the stored directory carries the password.
    expect(JSON.stringify(service.listAccounts())).not.toContain(result.data.temporaryPassword);
  });

  it('refuses to deactivate an account that is already deactivated', async () => {
    const service = new MockReadymodeService();

    expect(
      await categoryOf(service.deactivateAccount({ action: 'DEACTIVATE_ACCOUNT', target: { username: 'dlee' } }, context())),
    ).toBe('PRECONDITION_FAILED');
  });

  it('lists only the agents actually holding a license', async () => {
    const service = new MockReadymodeService();

    const result = await service.checkLicenseUsage({ action: 'CHECK_LICENSE_USAGE' }, context());
    const usernames = result.data.holders.map((holder) => holder.username);

    expect(usernames).toEqual(['jbrown', 'sgarcia', 'msmith2']);
    expect(usernames).not.toContain('dlee');
  });

  it('narrows to one license type', async () => {
    const service = new MockReadymodeService();

    const result = await service.checkLicenseUsage(
      { action: 'CHECK_LICENSE_USAGE', licenseType: 'Premium' },
      context(),
    );

    expect(result.data.holders.map((holder) => holder.username)).toEqual(['msmith2']);
  });

  it('reports an expired session rather than acting on it', async () => {
    const service = new MockReadymodeService({ authState: 'EXPIRED' });

    expect(
      await categoryOf(service.checkAgentStatus({ action: 'CHECK_AGENT_STATUS', target: { username: 'jbrown' } }, context())),
    ).toBe('AUTH_EXPIRED');

    await service.reconnect();

    expect(
      await categoryOf(service.checkAgentStatus({ action: 'CHECK_AGENT_STATUS', target: { username: 'jbrown' } }, context())),
    ).toBe('no-error');
  });

  it('will not reconnect past a verification prompt', async () => {
    const service = new MockReadymodeService({ authState: 'VERIFICATION_REQUIRED' });

    const status = await service.reconnect();
    expect(status.state).toBe('VERIFICATION_REQUIRED');
  });
});
