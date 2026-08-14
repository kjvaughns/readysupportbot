import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Workflow behaviour against a mocked Readymode.
 *
 * Nothing here touches a real browser or a live Readymode account. The page
 * operations are replaced with a small fake so the decision logic — read, apply,
 * save, re-read, verify — can be exercised exactly.
 */

const fake = {
  assignedStates: ['TX', 'FL', 'GA'] as string[],
  written: null as string[] | null,
  saveConfirmed: true,
  /** What a re-read returns; defaults to whatever was written. */
  verifiedStates: null as string[] | null,
  opened: [] as string[],
};

vi.mock('../src/readymode/workflows/pageOperations', () => ({
  openAgent: vi.fn(async (_context: unknown, agent: any) => {
    fake.opened.push(agent.username);
  }),
  readAssignedStates: vi.fn(async () =>
    fake.written && fake.verifiedStates === null
      ? fake.written
      : (fake.verifiedStates ?? fake.assignedStates),
  ),
  writeAssignedStates: vi.fn(async (_context: unknown, target: string[]) => {
    fake.written = target;
    return true;
  }),
  saveAgentForm: vi.fn(async () => fake.saveConfirmed),
  reopenAgent: vi.fn(async () => undefined),
  listAgents: vi.fn(async () => []),
  pageText: vi.fn(async () => ''),
}));

import { MemoryStore, setStore } from '../src/database';
import { stateWorkflow, viewStatesWorkflow } from '../src/readymode/workflows/states';
import { writeAssignedStates } from '../src/readymode/workflows/pageOperations';
import { ReadymodeAgent } from '../src/types';

const agent: ReadymodeAgent = {
  readymodeUserId: '101',
  username: 'kvaughns',
  fullName: 'Kaeden Vaughns',
  email: 'kaeden@example.com',
};

let store: MemoryStore;

function context(dryRun = false) {
  return {
    organizationId: 'org-a',
    requestId: 'req-1',
    reference: 'RS 1048',
    dryRun,
    actorDiscordUserId: '900',
    // The fake page operations never touch this.
    session: { page: {} } as any,
  };
}

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  fake.assignedStates = ['TX', 'FL', 'GA'];
  fake.written = null;
  fake.verifiedStates = null;
  fake.saveConfirmed = true;
  fake.opened = [];
  vi.clearAllMocks();
});

describe('state workflow', () => {
  it('replaces the assignment and verifies the saved result', async () => {
    const result = await stateWorkflow.run(context(), {
      agent,
      operation: 'SET_STATES',
      requestedStates: ['TX', 'VA', 'OH'],
    });

    expect(result.verified).toBe(true);
    expect(result.previousStates).toEqual(['FL', 'GA', 'TX']);
    expect(result.assignedStates).toEqual(['OH', 'TX', 'VA']);
    expect(result.added).toEqual(['OH', 'VA']);
    expect(result.removed).toEqual(['FL', 'GA']);
    expect(fake.written).toEqual(['OH', 'TX', 'VA']);
  });

  it('adds states without dropping the existing ones', async () => {
    const result = await stateWorkflow.run(context(), {
      agent,
      operation: 'ADD_STATES',
      requestedStates: ['FL', 'VA'],
    });

    expect(result.assignedStates).toEqual(['FL', 'GA', 'TX', 'VA']);
    expect(result.added).toEqual(['VA']);
    expect(result.removed).toEqual([]);
  });

  it('removes only the named states', async () => {
    const result = await stateWorkflow.run(context(), {
      agent,
      operation: 'REMOVE_STATES',
      requestedStates: ['GA'],
    });

    expect(result.assignedStates).toEqual(['FL', 'TX']);
    expect(result.removed).toEqual(['GA']);
  });

  it('writes nothing in dry run mode', async () => {
    const result = await stateWorkflow.run(context(true), {
      agent,
      operation: 'SET_STATES',
      requestedStates: ['TX', 'VA', 'OH'],
    });

    expect(writeAssignedStates).not.toHaveBeenCalled();
    expect(fake.written).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.summary).toMatch(/Dry run/i);
    expect(result.assignedStates).toEqual(['OH', 'TX', 'VA']);
  });

  it('does nothing when the assignment already matches', async () => {
    const result = await stateWorkflow.run(context(), {
      agent,
      operation: 'SET_STATES',
      requestedStates: ['GA', 'FL', 'TX'],
    });

    expect(writeAssignedStates).not.toHaveBeenCalled();
    expect(result.verified).toBe(true);
    expect(result.summary).toMatch(/No change was needed/i);
  });

  it('fails when the save is not confirmed', async () => {
    fake.saveConfirmed = false;

    await expect(
      stateWorkflow.run(context(), {
        agent,
        operation: 'SET_STATES',
        requestedStates: ['VA'],
      }),
    ).rejects.toThrowError(/did not confirm the save/i);
  });

  it('fails when the verified states do not match the request', async () => {
    fake.verifiedStates = ['TX'];

    await expect(
      stateWorkflow.run(context(), {
        agent,
        operation: 'SET_STATES',
        requestedStates: ['VA', 'OH'],
      }),
    ).rejects.toThrowError(/do not match the request/i);
  });

  it('records the verified assignment and the difference', async () => {
    await stateWorkflow.run(context(), {
      agent,
      operation: 'SET_STATES',
      requestedStates: ['TX', 'VA', 'OH'],
    });

    const stored = await store.getStateConfiguration('org-a', '101');
    expect(stored?.states).toEqual(['OH', 'TX', 'VA']);

    const events = await store.listEvents('org-a', 10);
    const verified = events.find((event) => event.type === 'states.verified');
    expect(verified).toBeTruthy();
    expect(verified?.data).toMatchObject({
      previousStates: ['FL', 'GA', 'TX'],
      newStates: ['OH', 'TX', 'VA'],
      added: ['OH', 'VA'],
      removed: ['FL', 'GA'],
    });
  });

  it('reopens the agent before verifying, rather than trusting the form', async () => {
    const { reopenAgent } = await import('../src/readymode/workflows/pageOperations');
    await stateWorkflow.run(context(), {
      agent,
      operation: 'SET_STATES',
      requestedStates: ['VA'],
    });
    expect(reopenAgent).toHaveBeenCalledOnce();
  });
});

describe('view states workflow', () => {
  it('reads without changing anything', async () => {
    const result = await viewStatesWorkflow.run(context(), { agent });

    expect(writeAssignedStates).not.toHaveBeenCalled();
    expect(result.assignedStates).toEqual(['FL', 'GA', 'TX']);
    expect(result.summary).toBe('Assigned states: FL, GA, TX');
  });
});
