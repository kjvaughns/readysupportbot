import { config } from '../config';
import { getStore } from '../database';
import { recordEvent } from '../audit';
import { jobQueue, laneKey } from '../queue';
import {
  AmbiguousAgentError,
  AppError,
  AuthenticationRequiredError,
  ControlsUnverifiedError,
  NotFoundError,
} from '../security/errors';
import { LinkedAgent, ReadymodeAgent, WorkflowResult } from '../types';
import { Action, AgentTarget } from '../openai/schema';
import { AgentMatch, describeAgent, describeMatchFailure, matchAgent } from './agents';
import { applyStateOperation, diffStates, formatStates } from './states';
import { ReadymodeSession, withSession } from './session';
import { ALL_CONTROLS } from './selectors';
import { discoveryReport } from './selectors/discovery';
import { capabilityForAction } from './selectors/capabilities';
import { WorkflowContext } from './workflows/harness';
import { listAgents, openAgent, readAssignedStates } from './workflows/pageOperations';
import {
  runAgentStatusWorkflow,
  runClearLicenseWorkflow,
  runCreateAccountWorkflow,
  runDeactivateAccountWorkflow,
  runLicenseUsageWorkflow,
  runResetPasswordWorkflow,
} from './workflows/accounts';
import { runAssignCampaignsWorkflow, runAssignQueuesWorkflow } from './workflows/assignments';
import { runStateWorkflow, runViewStatesWorkflow } from './workflows/states';

/**
 * Maps a validated action onto a predefined workflow and runs it inside one
 * browser session. The model never reaches this layer: only the closed action
 * union does, and every browser step is code written ahead of time.
 */

export interface ExecutionContext {
  organizationId: string;
  requestId: string;
  reference: string;
  actorDiscordUserId?: string | null;
  dryRun?: boolean;
}

async function linkedAgentsFor(
  organizationId: string,
  discordUserId?: string | null,
): Promise<LinkedAgent[]> {
  if (!discordUserId) return [];
  return getStore().listLinkedAgentsForDiscordUser(organizationId, discordUserId);
}

async function resolveTarget(
  workflowContext: WorkflowContext,
  target: AgentTarget,
  actorDiscordUserId?: string | null,
): Promise<ReadymodeAgent> {
  const query = queryFor(target);
  const agents = await listAgents(workflowContext, query);
  const linkedAgents = await linkedAgentsFor(
    workflowContext.organizationId,
    target.kind === 'discord_user' ? target.discordUserId : actorDiscordUserId,
  );

  const match = matchAgent(target, {
    agents,
    linkedAgents,
    requesterDiscordUserId: actorDiscordUserId ?? null,
  });

  return assertUnique(match, workflowContext.organizationId, workflowContext.requestId);
}

function queryFor(target: AgentTarget): string | undefined {
  switch (target.kind) {
    case 'username':
      return target.username;
    case 'email':
      return target.email;
    case 'name':
      return target.name;
    case 'readymode_user_id':
      return target.readymodeUserId;
    default:
      return undefined;
  }
}

async function assertUnique(
  match: AgentMatch,
  organizationId: string,
  requestId: string,
): Promise<ReadymodeAgent> {
  if (match.status === 'unique') return match.agent;

  if (match.status === 'ambiguous') {
    await recordEvent({
      organizationId,
      requestId,
      type: 'agent.ambiguous',
      message: 'More than one Readymode account matched the request.',
      data: { candidates: match.candidates.map((agent) => agent.username) },
    });
    throw new AmbiguousAgentError(
      match.candidates.map((agent) => ({
        readymodeUserId: agent.readymodeUserId,
        username: agent.username,
        fullName: agent.fullName ?? null,
      })),
    );
  }

  await recordEvent({
    organizationId,
    requestId,
    type: 'agent.not_found',
    message: 'No unique Readymode account matched the request.',
  });
  throw new NotFoundError(describeMatchFailure(match));
}

function workflowContext(
  session: ReadymodeSession,
  context: ExecutionContext,
): WorkflowContext {
  return {
    organizationId: context.organizationId,
    requestId: context.requestId,
    reference: context.reference,
    session,
    dryRun: context.dryRun ?? config.dryRun,
    actorDiscordUserId: context.actorDiscordUserId ?? null,
  };
}

/**
 * Runs an action. Browser work is queued per Readymode account so two requests
 * never drive the same account at once.
 */
export async function executeAction(
  action: Action,
  context: ExecutionContext,
): Promise<WorkflowResult> {
  // Actions that never touch a browser run directly.
  if (action.action === 'SET_DEFAULT_STATES') {
    return setDefaultStates(action.states, context);
  }

  const key = laneKey(context.organizationId);
  if (jobQueue.isPaused(key)) {
    throw new AuthenticationRequiredError(
      `Readymode work is paused: ${jobQueue.pauseReason(key) ?? 'reconnection required'}.`,
    );
  }

  return jobQueue.enqueue(key, context.requestId, async () => {
    try {
      return await withSession(context.organizationId, async (session) => {
        await assertCapabilityVerified(action, session, context);
        return dispatch(action, workflowContext(session, context), context);
      });
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        jobQueue.pause(key, 'Readymode requires human verification.');
      }
      throw error;
    }
  });
}


/**
 * Refuses, before touching anything, when the controls this action needs have
 * not been observed in the real interface.
 *
 * Built-in candidate selectors are guesses. They are fine for reading, and they
 * are how discovery finds its way around, but they must never be what clicks
 * Save. This is the one place that decision is made, so it covers every action.
 */
async function assertCapabilityVerified(
  action: Action,
  session: ReadymodeSession,
  context: ExecutionContext,
): Promise<void> {
  const capability = capabilityForAction(action.action);
  if (!capability) return;

  const involved = new Set([
    ...capability.requiredControls,
    ...(capability.anyOfControls?.flat() ?? []),
  ]);
  const controls = ALL_CONTROLS.filter((control) => involved.has(control.name));
  if (controls.length === 0) return;

  const report = await discoveryReport(session.page, controls, { timeoutMs: 600 });
  const status = report.capabilities.find((entry) => entry.capability === capability.id);
  if (!status || status.usable) return;

  await recordEvent({
    organizationId: context.organizationId,
    requestId: context.requestId,
    type: 'readymode.controls_unverified',
    message: `${context.reference}: refused, because ReadySupport cannot verify how to ${capability.label}.`,
    data: { capability: capability.id, missing: status.missing },
  });

  throw new ControlsUnverifiedError(capability.label, status.missing);
}

async function dispatch(
  action: Action,
  wf: WorkflowContext,
  context: ExecutionContext,
): Promise<WorkflowResult> {
  switch (action.action) {
    case 'CREATE_ACCOUNT':
      return runCreateAccountWorkflow(wf, { account: action.account });

    case 'CREATE_ACCOUNTS': {
      const results: WorkflowResult[] = [];
      for (const account of action.accounts) {
        results.push(await runCreateAccountWorkflow(wf, { account }));
      }
      return {
        ok: results.every((result) => result.ok),
        verified: results.every((result) => result.verified),
        summary: results.map((result) => result.summary).join('\n'),
        details: { count: results.length },
        screenshotPath: results[results.length - 1]?.screenshotPath ?? null,
        dryRun: wf.dryRun,
      };
    }

    case 'CLEAR_LICENSE':
      return runClearLicenseWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
      });

    case 'RESET_PASSWORD':
      return runResetPasswordWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
      });

    case 'DEACTIVATE_ACCOUNT':
      return runDeactivateAccountWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
      });

    case 'AGENT_STATUS':
      return runAgentStatusWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
      });

    case 'LICENSE_USAGE':
      return runLicenseUsageWorkflow(wf);

    case 'ASSIGN_CAMPAIGNS':
      return runAssignCampaignsWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
        names: action.campaigns,
      });

    case 'ASSIGN_QUEUES':
      return runAssignQueuesWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
        names: action.queues,
      });

    case 'VIEW_STATES':
      return runViewStatesWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
      });

    case 'SET_STATES':
    case 'ADD_STATES':
    case 'REMOVE_STATES':
      return runStateWorkflow(wf, {
        agent: await resolveTarget(wf, action.target, context.actorDiscordUserId),
        operation: action.action,
        requestedStates: action.states,
      });

    case 'COPY_STATE_CONFIGURATION': {
      const source = await resolveTarget(wf, action.source, context.actorDiscordUserId);
      const destination = await resolveTarget(wf, action.target, context.actorDiscordUserId);

      await openAgent(wf, source);
      const sourceStates = await readAssignedStates(wf);

      return runStateWorkflow(wf, {
        agent: destination,
        operation: 'SET_STATES',
        requestedStates: sourceStates,
      });
    }

    default:
      throw new AppError('unsupported_action', 'That action is not supported.', 400);
  }
}

async function setDefaultStates(
  states: string[],
  context: ExecutionContext,
): Promise<WorkflowResult> {
  const store = getStore();
  const previous = await store.getDefaultStates(context.organizationId);
  const diff = diffStates(previous, states);

  if (!(context.dryRun ?? config.dryRun)) {
    await store.setDefaultStates(context.organizationId, states, context.actorDiscordUserId ?? null);
  }

  await recordEvent({
    organizationId: context.organizationId,
    requestId: context.requestId,
    type: 'states.defaults_changed',
    message: `Default states for new agents set to ${formatStates(states)}.`,
    data: { previousStates: diff.previous, newStates: diff.next, added: diff.added, removed: diff.removed },
  });

  return {
    ok: true,
    verified: !(context.dryRun ?? config.dryRun),
    summary: `Default states for new agents: ${formatStates(states)}`,
    details: { previousStates: diff.previous, newStates: diff.next },
    screenshotPath: null,
    dryRun: context.dryRun ?? config.dryRun,
  };
}

export interface ChangePreview {
  agentLabel?: string;
  currentStates?: string[];
  newStates?: string[];
  added?: string[];
  removed?: string[];
  changeType?: string;
  /** True when the current values came from the last verified snapshot. */
  fromCache?: boolean;
  lines: string[];
}

/**
 * Builds the confirmation shown before a change runs.
 *
 * State changes read the agent's current configuration so the confirmation
 * shows exactly what will change. When the browser cannot be reached, the last
 * verified snapshot is used and the reply says so.
 */
export async function previewChange(
  action: Action,
  context: ExecutionContext,
): Promise<ChangePreview> {
  if (
    action.action === 'SET_STATES' ||
    action.action === 'ADD_STATES' ||
    action.action === 'REMOVE_STATES'
  ) {
    const { agent, currentStates, fromCache } = await currentStateFor(
      action.target,
      context,
    );
    const next = applyStateOperation(action.action, currentStates, action.states);
    const diff = diffStates(currentStates, next);

    const changeType =
      action.action === 'SET_STATES'
        ? 'Replace current assignments'
        : action.action === 'ADD_STATES'
          ? 'Add to current assignments'
          : 'Remove from current assignments';

    return {
      agentLabel: agent,
      currentStates: diff.previous,
      newStates: diff.next,
      added: diff.added,
      removed: diff.removed,
      changeType,
      fromCache,
      lines: [
        `Agent: ${agent}`,
        `Current states: ${formatStates(diff.previous)}${fromCache ? ' (last verified snapshot)' : ''}`,
        `New states: ${formatStates(diff.next)}`,
        `Change type: ${changeType}`,
      ],
    };
  }

  if (action.action === 'SET_DEFAULT_STATES') {
    const previous = await getStore().getDefaultStates(context.organizationId);
    const diff = diffStates(previous, action.states);
    return {
      currentStates: diff.previous,
      newStates: diff.next,
      added: diff.added,
      removed: diff.removed,
      changeType: 'Set default states for new agents',
      lines: [
        `Current default states: ${formatStates(diff.previous)}`,
        `New default states: ${formatStates(diff.next)}`,
        'Change type: Default for newly created agents',
      ],
    };
  }

  return { lines: [describeAction(action)] };
}

async function currentStateFor(
  target: AgentTarget,
  context: ExecutionContext,
): Promise<{ agent: string; currentStates: string[]; fromCache: boolean }> {
  try {
    return await jobQueue.enqueue(laneKey(context.organizationId), `${context.requestId}:preview`, () =>
      withSession(context.organizationId, async (session) => {
        const wf = workflowContext(session, { ...context, dryRun: true });
        const agent = await resolveTarget(wf, target, context.actorDiscordUserId);
        await openAgent(wf, agent);
        const states = await readAssignedStates(wf);
        return { agent: describeAgent(agent), currentStates: states, fromCache: false };
      }),
    );
  } catch (error) {
    if (error instanceof AmbiguousAgentError || error instanceof NotFoundError) throw error;

    // The browser could not be reached. Fall back to the last verified snapshot
    // so the confirmation still shows what is known, clearly labelled.
    const cached = await cachedStates(target, context);
    if (cached) return { ...cached, fromCache: true };
    throw error;
  }
}

async function cachedStates(
  target: AgentTarget,
  context: ExecutionContext,
): Promise<{ agent: string; currentStates: string[] } | null> {
  const store = getStore();
  const linked = await linkedAgentsFor(
    context.organizationId,
    target.kind === 'discord_user' ? target.discordUserId : context.actorDiscordUserId,
  );

  const records = await store.listStateConfigurations(context.organizationId);
  const agents: ReadymodeAgent[] = records.map((record) => ({
    readymodeUserId: record.readymodeUserId,
    username: record.username ?? record.readymodeUserId,
    fullName: null,
    email: null,
    states: record.states,
  }));

  const match = matchAgent(target, {
    agents,
    linkedAgents: linked,
    requesterDiscordUserId: context.actorDiscordUserId ?? null,
  });

  if (match.status !== 'unique') return null;
  const record = records.find(
    (entry) => entry.readymodeUserId === match.agent.readymodeUserId,
  );
  return { agent: describeAgent(match.agent), currentStates: record?.states ?? [] };
}

export function describeAction(action: Action): string {
  switch (action.action) {
    case 'CREATE_ACCOUNT':
      return `Create an account for ${action.account.fullName}`;
    case 'CREATE_ACCOUNTS':
      return `Create ${action.accounts.length} accounts`;
    case 'CLEAR_LICENSE':
      return 'Clear an agent license';
    case 'RESET_PASSWORD':
      return 'Reset an agent password';
    case 'DEACTIVATE_ACCOUNT':
      return 'Deactivate an agent account';
    case 'ASSIGN_CAMPAIGNS':
      return `Assign campaigns: ${action.campaigns.join(', ')}`;
    case 'ASSIGN_QUEUES':
      return `Assign queues: ${action.queues.join(', ')}`;
    case 'COPY_STATE_CONFIGURATION':
      return 'Copy one agent state configuration onto another';
    case 'SET_DEFAULT_STATES':
      return `Set default states to ${formatStates(action.states)}`;
    default:
      return action.action.toLowerCase().replace(/_/g, ' ');
  }
}
