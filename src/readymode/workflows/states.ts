import { ReadymodeAgent } from '../../types';
import { AppError } from '../../security/errors';
import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { applyStateOperation, diffStates, formatStates, sortStates } from '../states';
import { describeAgent } from '../agents';
import { WorkflowContext, WorkflowDefinition, runWorkflow, step } from './harness';
import {
  openAgent,
  readAssignedStates,
  reopenAgent,
  saveAgentForm,
  writeAssignedStates,
} from './pageOperations';

/**
 * State configuration workflows.
 *
 * The change is computed from what Readymode currently holds, applied, saved,
 * and then verified by re-reading the agent from a fresh page load. A saved
 * result that does not match the request is reported as a failure, never as a
 * success.
 */

export type StateOperation = 'SET_STATES' | 'ADD_STATES' | 'REMOVE_STATES';

export interface StateWorkflowInput {
  agent: ReadymodeAgent;
  operation: StateOperation;
  requestedStates: string[];
}

export interface StateWorkflowOutput extends Record<string, unknown> {
  verified: boolean;
  summary: string;
  agent: string;
  previousStates: string[];
  assignedStates: string[];
  added: string[];
  removed: string[];
}

export const stateWorkflow: WorkflowDefinition<StateWorkflowInput, StateWorkflowOutput> = {
  name: 'states.apply',

  describe(input) {
    const verb =
      input.operation === 'ADD_STATES'
        ? 'Add'
        : input.operation === 'REMOVE_STATES'
          ? 'Remove'
          : 'Replace';
    return `${verb} states ${formatStates(input.requestedStates)} for ${describeAgent(input.agent)}`;
  },

  async run(context, input) {
    // 2–4: navigate to the exact agent and confirm one unique match.
    await step(context, 'open-agent', () => openAgent(context, input.agent));

    // 5: read the current configuration.
    const previousStates = await step(context, 'read-states', () => readAssignedStates(context));
    const target = applyStateOperation(input.operation, previousStates, input.requestedStates);
    const plannedDiff = diffStates(previousStates, target);

    if (context.dryRun) {
      return {
        verified: false,
        summary: `Dry run: no change was saved. ${describeChange(plannedDiff.previous, plannedDiff.next)}`,
        agent: describeAgent(input.agent),
        previousStates: plannedDiff.previous,
        assignedStates: plannedDiff.next,
        added: plannedDiff.added,
        removed: plannedDiff.removed,
      };
    }

    if (!plannedDiff.changed) {
      return {
        verified: true,
        summary: `No change was needed. Assigned states are already ${formatStates(previousStates)}.`,
        agent: describeAgent(input.agent),
        previousStates,
        assignedStates: previousStates,
        added: [],
        removed: [],
      };
    }

    // 6: perform only the approved change.
    const applied = await step(context, 'write-states', () => writeAssignedStates(context, target));
    if (!applied) {
      throw new AppError(
        'states_not_applicable',
        'Readymode does not offer every requested state on this agent, so nothing was saved.',
        409,
        { requested: sortStates(target) },
      );
    }

    // 7: save and wait for the expected result.
    const saved = await step(context, 'save', () => saveAgentForm(context));
    if (!saved) {
      throw new AppError(
        'save_not_confirmed',
        'Readymode did not confirm the save, so the change was not verified. Nothing further was attempted.',
        503,
      );
    }

    // 8: verify independently by reopening the agent.
    await step(context, 'reopen-agent', () => reopenAgent(context, input.agent));
    const verifiedStates = await step(context, 'verify-states', () => readAssignedStates(context));
    const finalDiff = diffStates(previousStates, verifiedStates);
    const matches =
      sortStates(verifiedStates).join(',') === sortStates(target).join(',');

    if (!matches) {
      throw new AppError(
        'verification_failed',
        `The saved states do not match the request. Readymode now shows ${formatStates(verifiedStates)}.`,
        409,
        { expected: sortStates(target), actual: sortStates(verifiedStates) },
      );
    }

    // 10: record the difference for the audit trail.
    await getStore().upsertStateConfiguration({
      organizationId: context.organizationId,
      readymodeUserId: input.agent.readymodeUserId,
      username: input.agent.username,
      states: verifiedStates,
      updatedBy: context.actorDiscordUserId ?? null,
    });

    await recordEvent({
      organizationId: context.organizationId,
      requestId: context.requestId,
      type: 'states.verified',
      message: `${context.reference}: states verified for ${describeAgent(input.agent)}.`,
      data: {
        previousStates: finalDiff.previous,
        newStates: finalDiff.next,
        added: finalDiff.added,
        removed: finalDiff.removed,
      },
    });

    return {
      verified: true,
      summary: describeChange(finalDiff.previous, finalDiff.next),
      agent: describeAgent(input.agent),
      previousStates: finalDiff.previous,
      assignedStates: finalDiff.next,
      added: finalDiff.added,
      removed: finalDiff.removed,
    };
  },
};

export interface ViewStatesInput {
  agent: ReadymodeAgent;
}

export const viewStatesWorkflow: WorkflowDefinition<
  ViewStatesInput,
  StateWorkflowOutput
> = {
  name: 'states.view',
  describe: (input) => `Read assigned states for ${describeAgent(input.agent)}`,
  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));
    const states = sortStates(await step(context, 'read-states', () => readAssignedStates(context)));

    return {
      verified: true,
      summary: `Assigned states: ${formatStates(states)}`,
      agent: describeAgent(input.agent),
      previousStates: states,
      assignedStates: states,
      added: [],
      removed: [],
    };
  },
};

function describeChange(previous: string[], next: string[]): string {
  const diff = diffStates(previous, next);
  const parts = [`Previous states: ${formatStates(diff.previous)}`, `New states: ${formatStates(diff.next)}`];
  if (diff.added.length > 0) parts.push(`Added: ${formatStates(diff.added)}`);
  if (diff.removed.length > 0) parts.push(`Removed: ${formatStates(diff.removed)}`);
  return parts.join('\n');
}

export function runStateWorkflow(context: WorkflowContext, input: StateWorkflowInput) {
  return runWorkflow(stateWorkflow, context, input);
}

export function runViewStatesWorkflow(context: WorkflowContext, input: ViewStatesInput) {
  return runWorkflow(viewStatesWorkflow, context, input);
}
