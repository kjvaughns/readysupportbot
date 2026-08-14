import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mocked integration tests for every Readymode workflow.
 *
 * "Mocked" means the things outside this machine are stubbed — Browserbase,
 * the evidence bucket, the database. The browser is real, the page is real,
 * and the code under test is the production path in full.
 *
 * Nothing here touches a live Readymode account. The app the browser drives is
 * a synthetic fixture that exists only in this repository.
 */

vi.mock('../../src/readymode/evidence.js', () => ({
  capture: vi.fn(async () => undefined),
  signedUrl: vi.fn(async () => undefined),
}));

vi.mock('../../src/db/repositories/browserSessions.js', () => ({
  open: vi.fn(async () => ({ id: 'session-row' })),
  update: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  findMostRecent: vi.fn(async () => null),
  closeOrphaned: vi.fn(async () => 0),
}));

vi.mock('../../src/db/repositories/settings.js', () => ({
  get: vi.fn(async () => ({ state: 'AUTHENTICATED', checkedAt: null, detail: null })),
  set: vi.fn(async () => undefined),
  patch: vi.fn(async () => undefined),
  isQueuePaused: vi.fn(async () => false),
  pauseQueue: vi.fn(async () => undefined),
  resumeQueue: vi.fn(async () => undefined),
  recordFailure: vi.fn(async () => 1),
  recordSuccess: vi.fn(async () => undefined),
}));

const { checkAgentStatus } = await import('../../src/readymode/workflows/checkAgentStatus.js');
const { checkLicenseUsage } = await import('../../src/readymode/workflows/checkLicenseUsage.js');
const { clearLicense } = await import('../../src/readymode/workflows/clearLicense.js');
const { createAccount } = await import('../../src/readymode/workflows/createAccount.js');
const { deactivateAccount } = await import('../../src/readymode/workflows/deactivateAccount.js');
const { resetPassword } = await import('../../src/readymode/workflows/resetPassword.js');
const { closeBrowser, installEmptySelectors, startHarness, workflowContext } = await import(
  './workflowHarness.js'
);

type Harness = Awaited<ReturnType<typeof startHarness>>;

let harness: Harness;

async function categoryOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no-error';
  } catch (error) {
    return (error as { category?: string }).category ?? 'not-a-readysupport-error';
  }
}

beforeEach(async () => {
  harness = await startHarness();
});

afterEach(async () => {
  await harness.stop();
});

afterAll(async () => {
  await closeBrowser();
});

describe('refusing to run without a mapped interface', () => {
  it('stops before opening a page when selectors are unmapped', async () => {
    installEmptySelectors();

    const category = await categoryOf(
      clearLicense(
        { action: 'CLEAR_LICENSE', target: { username: 'jbrown' }, overrideActiveCall: false },
        workflowContext(),
      ),
    );

    expect(category).toBe('SELECTOR_NOT_CONFIGURED');
    // The check happens before any browser session is opened at all.
    expect(harness.opened).toHaveLength(0);
  });
});

describe('CHECK_AGENT_STATUS', () => {
  it('reads one agent and reports what the page shows', async () => {
    const result = await checkAgentStatus(
      { action: 'CHECK_AGENT_STATUS', target: { username: 'sgarcia' } },
      workflowContext(),
    );

    expect(result.verified).toBe(true);
    expect(result.data.fullName).toBe('Sarah Garcia');
    expect(result.data.licenseInUse).toBe(true);
    expect(result.data.onCall).toBe(true);
    expect(result.data.active).toBe(true);
  });

  it('finds an agent by email as well as username', async () => {
    const result = await checkAgentStatus(
      { action: 'CHECK_AGENT_STATUS', target: { email: 'john.brown@example.test' } },
      workflowContext(),
    );

    expect(result.data.username).toBe('jbrown');
  });

  it('stops on an ambiguous name and hands back the candidates', async () => {
    try {
      await checkAgentStatus(
        { action: 'CHECK_AGENT_STATUS', target: { fullName: 'Marcus Smith' } },
        workflowContext(),
      );
      expect.unreachable('should have refused to choose');
    } catch (error) {
      const failure = error as { category: string; details: Record<string, unknown> };
      expect(failure.category).toBe('AMBIGUOUS_MATCH');

      const candidates = failure.details['candidates'] as Array<{ key: string; label: string }>;
      expect(candidates).toHaveLength(2);
      expect(candidates.map((candidate) => candidate.key)).toEqual(['id:1003', 'id:1004']);
    }
  });

  it('reports nothing found rather than picking something close', async () => {
    expect(
      await categoryOf(
        checkAgentStatus({ action: 'CHECK_AGENT_STATUS', target: { username: 'nobody' } }, workflowContext()),
      ),
    ).toBe('NO_MATCH');
  });

  it('closes its browser session', async () => {
    await checkAgentStatus({ action: 'CHECK_AGENT_STATUS', target: { username: 'jbrown' } }, workflowContext());
    expect(harness.opened[0]?.closed).toBe(true);
    expect(harness.opened[0]?.status).toBe('CLOSED');
  });
});

describe('CHECK_LICENSE_USAGE', () => {
  it('lists everyone holding a license', async () => {
    const result = await checkLicenseUsage({ action: 'CHECK_LICENSE_USAGE' }, workflowContext());

    expect(result.data.holders.map((holder) => holder.fullName)).toEqual([
      'John Brown',
      'Sarah Garcia',
      'Marcus Smith',
    ]);
    expect(result.data.totalInUse).toBe(3);
    expect(result.data.totalAvailable).toBe(5);
  });

  it('reads who is on a call', async () => {
    const result = await checkLicenseUsage({ action: 'CHECK_LICENSE_USAGE' }, workflowContext());
    const sarah = result.data.holders.find((holder) => holder.fullName === 'Sarah Garcia');

    expect(sarah?.onCall).toBe(true);
    expect(result.data.holders.find((holder) => holder.fullName === 'John Brown')?.onCall).toBe(false);
  });

  it('narrows to one license type', async () => {
    const result = await checkLicenseUsage(
      { action: 'CHECK_LICENSE_USAGE', licenseType: 'Premium' },
      workflowContext(),
    );

    expect(result.data.holders.map((holder) => holder.fullName)).toEqual(['Marcus Smith']);
  });

  it('reports an empty list rather than failing when nobody holds one', async () => {
    await harness.stop();
    harness = await startHarness({
      agents: [
        {
          id: '9001',
          username: 'idle',
          email: 'idle@example.test',
          fullName: 'Idle Person',
          role: 'Agent',
          licenseType: 'Standard',
          team: '',
          campaign: '',
          queue: '',
          active: true,
          licenseInUse: false,
          loggedIn: false,
          onCall: false,
        },
      ],
    });

    const result = await checkLicenseUsage({ action: 'CHECK_LICENSE_USAGE' }, workflowContext());
    expect(result.data.holders).toHaveLength(0);
  });
});

describe('CLEAR_LICENSE', () => {
  const action = {
    action: 'CLEAR_LICENSE' as const,
    target: { username: 'jbrown' },
    overrideActiveCall: false,
  };

  it('clears the license and verifies it afterwards', async () => {
    const result = await clearLicense(action, workflowContext());

    expect(result.verified).toBe(true);
    expect(result.data.before.licenseInUse).toBe(true);
    expect(result.data.after.licenseInUse).toBe(false);

    // The fixture is stateful, so this proves the change actually landed
    // rather than being read from the pre-change page.
    expect(harness.fixture.find('jbrown')?.licenseInUse).toBe(false);
  });

  it('refuses when the agent is on a call', async () => {
    const category = await categoryOf(
      clearLicense({ ...action, target: { username: 'sgarcia' } }, workflowContext()),
    );

    expect(category).toBe('PRECONDITION_FAILED');
    expect(harness.fixture.find('sgarcia')?.licenseInUse).toBe(true);
    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('proceeds once an admin has acknowledged the call', async () => {
    const result = await clearLicense(
      { ...action, target: { username: 'sgarcia' }, overrideActiveCall: true },
      workflowContext(),
    );

    expect(result.verified).toBe(true);
    expect(harness.fixture.find('sgarcia')?.licenseInUse).toBe(false);
  });

  it('refuses when there is no license to clear', async () => {
    expect(
      await categoryOf(clearLicense({ ...action, target: { username: 'msmith' } }, workflowContext())),
    ).toBe('PRECONDITION_FAILED');
  });

  it('changes nothing in a dry run', async () => {
    const result = await clearLicense(action, workflowContext({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.verified).toBe(false);
    expect(result.notes?.[0]).toMatch(/would have been cleared/i);

    expect(harness.fixture.find('jbrown')?.licenseInUse).toBe(true);
    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('marks the session failed when it stops', async () => {
    await categoryOf(clearLicense({ ...action, target: { username: 'msmith' } }, workflowContext()));
    expect(harness.opened[0]?.status).toBe('FAILED');
  });
});

describe('CREATE_ACCOUNT', () => {
  const action = {
    action: 'CREATE_ACCOUNT' as const,
    firstName: 'Nora',
    lastName: 'Patel',
    email: 'nora.patel@example.test',
    username: 'npatel',
    agentRole: 'Agent',
    licenseType: 'Standard',
    team: 'Team A',
    campaign: 'Vantage',
    queue: 'Inbound',
    active: true,
  };

  it('creates the account and confirms it exists afterwards', async () => {
    const result = await createAccount(action, workflowContext());

    expect(result.verified).toBe(true);
    expect(result.data.account.username).toBe('npatel');
    expect(result.data.account.fullName).toBe('Nora Patel');
    expect(result.data.passwordSource).toBe('generated');
    expect(result.data.temporaryPassword.length).toBeGreaterThanOrEqual(16);

    expect(harness.fixture.find('npatel')?.email).toBe('nora.patel@example.test');
  });

  it('refuses a duplicate username before filling anything in', async () => {
    expect(
      await categoryOf(createAccount({ ...action, username: 'jbrown' }, workflowContext())),
    ).toBe('PRECONDITION_FAILED');

    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('refuses a duplicate email before filling anything in', async () => {
    expect(
      await categoryOf(createAccount({ ...action, email: 'john.brown@example.test' }, workflowContext())),
    ).toBe('PRECONDITION_FAILED');

    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('uses an administrator-supplied password when given one', async () => {
    const result = await createAccount(
      { ...action, temporaryPassword: 'Provided-Password-1' },
      workflowContext(),
    );

    expect(result.data.passwordSource).toBe('provided');
    expect(result.data.temporaryPassword).toBe('Provided-Password-1');
  });

  it('fills the form but submits nothing in a dry run', async () => {
    const result = await createAccount(action, workflowContext({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.verified).toBe(false);
    expect(harness.fixture.find('npatel')).toBeUndefined();
    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('stops when a supplied optional field has no mapped form control', async () => {
    // The requester asked for a queue, but that control is unmapped. Silently
    // creating the account without it would be worse than refusing.
    const { setRegistry, DEFAULT_SELECTORS, DEFAULT_ROUTES, applyOverlay } = await import(
      '../../src/readymode/selectors.js'
    );
    const { FIXTURE_OVERLAY } = await import('../fixtures/readymodeFixtureServer.js');

    const registry = {
      routes: structuredClone(DEFAULT_ROUTES),
      selectors: structuredClone(DEFAULT_SELECTORS),
      overlayPath: 'test',
      loadedAt: new Date().toISOString(),
    };
    const overlay = structuredClone(FIXTURE_OVERLAY) as { selectors: Record<string, unknown> };
    delete overlay.selectors['create.queue.select'];
    applyOverlay(overlay as never, registry);
    setRegistry({ routes: registry.routes, selectors: registry.selectors });

    expect(await categoryOf(createAccount(action, workflowContext()))).toBe('SELECTOR_NOT_CONFIGURED');
    expect(harness.fixture.find('npatel')).toBeUndefined();
  });
});

describe('RESET_PASSWORD', () => {
  const action = { action: 'RESET_PASSWORD' as const, target: { username: 'jbrown' } };

  it('sets a new password and confirms Readymode accepted it', async () => {
    const result = await resetPassword(action, workflowContext());

    expect(result.verified).toBe(true);
    expect(result.data.passwordSource).toBe('generated');
    expect(result.data.temporaryPassword.length).toBeGreaterThanOrEqual(16);

    const submission = harness.fixture.submissions.find((entry) => entry.kind === 'reset-password');
    expect(submission?.detail['username']).toBe('jbrown');
    // The fixture records the length, never the value — the same rule the
    // system follows everywhere else.
    expect(Number(submission?.detail['length'])).toBe(result.data.temporaryPassword.length);
  });

  it('refuses to reset a deactivated account', async () => {
    expect(await categoryOf(resetPassword({ ...action, target: { username: 'dlee' } }, workflowContext()))).toBe(
      'PRECONDITION_FAILED',
    );
    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('submits nothing in a dry run', async () => {
    const result = await resetPassword(action, workflowContext({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.data.temporaryPassword.length).toBeGreaterThanOrEqual(16);
    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('refuses an ambiguous target', async () => {
    expect(
      await categoryOf(resetPassword({ ...action, target: { fullName: 'Marcus Smith' } }, workflowContext())),
    ).toBe('AMBIGUOUS_MATCH');
  });
});

describe('DEACTIVATE_ACCOUNT', () => {
  const action = { action: 'DEACTIVATE_ACCOUNT' as const, target: { username: 'msmith' } };

  it('deactivates and verifies the account really is deactivated', async () => {
    const result = await deactivateAccount(action, workflowContext());

    expect(result.verified).toBe(true);
    expect(result.data.before.active).toBe(true);
    expect(result.data.after.active).toBe(false);
    expect(harness.fixture.find('msmith')?.active).toBe(false);
  });

  it('refuses an account that is already deactivated', async () => {
    expect(
      await categoryOf(deactivateAccount({ ...action, target: { username: 'dlee' } }, workflowContext())),
    ).toBe('PRECONDITION_FAILED');
  });

  it('submits nothing in a dry run', async () => {
    const result = await deactivateAccount(action, workflowContext({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(harness.fixture.find('msmith')?.active).toBe(true);
    expect(harness.fixture.submissions).toHaveLength(0);
  });

  it('stops rather than act when the account status cannot be read', async () => {
    // With the status field unmapped there is no way to prove the change
    // afterwards, so the most irreversible action refuses to start.
    const { setRegistry, DEFAULT_SELECTORS, DEFAULT_ROUTES, applyOverlay } = await import(
      '../../src/readymode/selectors.js'
    );
    const { FIXTURE_OVERLAY } = await import('../fixtures/readymodeFixtureServer.js');

    const registry = {
      routes: structuredClone(DEFAULT_ROUTES),
      selectors: structuredClone(DEFAULT_SELECTORS),
      overlayPath: 'test',
      loadedAt: new Date().toISOString(),
    };
    const overlay = structuredClone(FIXTURE_OVERLAY) as { selectors: Record<string, unknown> };
    delete overlay.selectors['agent.detail.activeState'];
    applyOverlay(overlay as never, registry);
    setRegistry({ routes: registry.routes, selectors: registry.selectors });

    expect(await categoryOf(deactivateAccount(action, workflowContext()))).toBe('SELECTOR_NOT_CONFIGURED');
    expect(harness.fixture.find('msmith')?.active).toBe(true);
  });
});
