import { config } from '../config';
import { getStore } from '../database';
import { recordEvent } from '../audit';
import { Action, actionSchema } from '../openai/schema';
import { isModifyingAction } from '../permissions';
import { getActionRoles, checkActionAccess } from '../permissions/overrides';
import { answerTroubleshooting } from '../knowledge/troubleshooting';
import { approvalRequirement, awaitingSinceFrom, submitApproval } from '../approvals';
import { assertTransition } from '../queue';
import {
  ChangePreview,
  describeAction,
  executeAction,
  previewChange,
} from '../readymode/executor';
import { credentialSummary } from '../readymode/credentials';
import { AutomationRequest, RequestStatus, Role } from '../types';
import {
  AmbiguousAgentError,
  AppError,
  AuthenticationRequiredError,
  toSafeMessage,
} from '../security/errors';
import { dedupeKey } from '../security/ids';
import { logger } from '../security/logger';
import { escapeDiscord } from '../security/sanitize';
import { notifyAuthenticationRequired, notifySecondApprovalNeeded } from '../notifications';
import { recentActivity, describeEvent } from '../audit';
import { ResolvedDiscordContext } from './context';
import {
  confirmationButtons,
  confirmationMessage,
  failureMessage,
  HELP_TEXT,
  successMessage,
} from './replies';

/**
 * Request lifecycle shared by mentions, replies and slash commands.
 *
 * Read-only requests run straight away. Anything that modifies Readymode is
 * shown for confirmation first, with the exact before-and-after, and only runs
 * once the required approvals are in.
 */

const DEDUPE_WINDOW_MS = 60_000;

export interface FlowReply {
  content: string;
  components?: ReturnType<typeof confirmationButtons>[];
  requestId?: string;
  reference?: string;
}

export async function handleAction(input: {
  context: ResolvedDiscordContext;
  action: Action;
  messageId?: string | null;
}): Promise<FlowReply> {
  const { context, action } = input;

  if (action.action === 'HELP') return { content: HELP_TEXT };
  if (action.action === 'UNSUPPORTED') {
    return { content: escapeDiscord(action.reason) };
  }

  // Permission plus any per-action minimum role the organization configured.
  const access = checkActionAccess(
    context.role,
    action.action,
    await getActionRoles(context.organizationId),
  );
  if (!access.allowed) {
    await recordEvent({
      organizationId: context.organizationId,
      type: 'permission.denied',
      message: `A ${context.role} attempted ${action.action}.`,
      data: { discordUserId: context.discordUserId, reason: access.reason },
    });
    return { content: access.reason };
  }

  if (action.action === 'TROUBLESHOOT') {
    const answer = answerTroubleshooting(action.topic, action.question);
    return { content: escapeDiscord(answer.body).slice(0, 1900) };
  }

  if (action.action === 'CONNECTION_STATUS') return connectionStatusReply(context);
  if (action.action === 'RECENT_ACTIONS') return recentActionsReply(context, action.limit);

  const store = getStore();

  // Duplicate requests inside a short window collapse onto the first one.
  const key = dedupeKey({
    organizationId: context.organizationId,
    actorId: context.discordUserId,
    actionType: action.action,
    payload: action,
  });

  const duplicate = await store.findRecentByDedupeKey(
    context.organizationId,
    key,
    DEDUPE_WINDOW_MS,
  );
  if (duplicate && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(duplicate.status)) {
    await recordEvent({
      organizationId: context.organizationId,
      requestId: duplicate.id,
      type: 'request.duplicate',
      message: `A duplicate of ${duplicate.reference} was ignored.`,
    });
    return {
      content: `That request is already in progress as ${duplicate.reference}.`,
      requestId: duplicate.id,
      reference: duplicate.reference,
    };
  }

  const request = await store.createRequest({
    organizationId: context.organizationId,
    actionType: action.action,
    payload: { action },
    status: 'PENDING',
    requestedByDiscordUserId: context.discordUserId,
    guildId: context.guildId,
    channelId: context.channelId,
    messageId: input.messageId ?? null,
    dedupeKey: key,
  });

  await recordEvent({
    organizationId: context.organizationId,
    requestId: request.id,
    type: 'request.created',
    message: `${request.reference}: ${describeAction(action)}.`,
    data: { actionType: action.action, role: context.role },
  });

  if (!isModifyingAction(action.action)) {
    return runNow(request, action, context);
  }

  // Modifying: build the confirmation from the current Readymode configuration.
  let preview: ChangePreview;
  try {
    preview = await previewChange(action, {
      organizationId: context.organizationId,
      requestId: request.id,
      reference: request.reference,
      actorDiscordUserId: context.discordUserId,
      dryRun: true,
    });
  } catch (error) {
    return failure(request, error, context.organizationId);
  }

  const awaitingSince = new Date().toISOString();
  assertTransition(request.status, 'AWAITING_APPROVAL');
  await store.updateRequest(request.id, {
    status: 'AWAITING_APPROVAL',
    payload: { action, awaitingSince, preview },
  });

  const requirement = approvalRequirement(action);

  await recordEvent({
    organizationId: context.organizationId,
    requestId: request.id,
    type: 'request.awaiting_approval',
    message: `${request.reference} is waiting for confirmation.`,
    data: { required: requirement.required },
  });

  return {
    content: confirmationMessage({
      action,
      preview,
      needsSecondApprover: requirement.required === 2,
      dryRun: config.dryRun,
    }),
    components: [confirmationButtons(request.id)],
    requestId: request.id,
    reference: request.reference,
  };
}

export async function confirmRequest(input: {
  requestId: string;
  context: ResolvedDiscordContext;
}): Promise<FlowReply> {
  const store = getStore();
  const request = await store.getRequest(input.requestId);

  if (!request || request.organizationId !== input.context.organizationId) {
    return { content: 'That request no longer exists.' };
  }

  const action = readAction(request);
  if (!action) return { content: 'That request could not be read back. Send it again.' };

  const decision = await submitApproval({
    request,
    action,
    approver: {
      discordUserId: input.context.discordUserId,
      role: input.context.role as Role,
    },
    awaitingSince: awaitingSinceFrom(request),
  });

  if (decision.status === 'rejected') {
    if (/expired/i.test(decision.reason)) {
      await store.updateRequest(request.id, { status: 'CANCELLED', error: 'Approval expired.' });
    }
    return { content: decision.reason, reference: request.reference };
  }

  if (decision.status === 'awaiting_second') {
    await notifySecondApprovalNeeded(
      request.organizationId,
      request.reference,
      describeAction(action),
    );
    return {
      content: `Recorded. ${request.reference} still needs a second Owner or Administrator to confirm.`,
      components: [confirmationButtons(request.id)],
      reference: request.reference,
    };
  }

  const approved = await store.updateRequest(request.id, { status: 'APPROVED' });
  return runNow(approved, action, input.context);
}

export async function cancelRequest(input: {
  requestId: string;
  context: ResolvedDiscordContext;
}): Promise<FlowReply> {
  const store = getStore();
  const request = await store.getRequest(input.requestId);
  if (!request || request.organizationId !== input.context.organizationId) {
    return { content: 'That request no longer exists.' };
  }
  if (['COMPLETED', 'RUNNING'].includes(request.status)) {
    return { content: `${request.reference} is already ${request.status.toLowerCase()}.` };
  }

  await store.updateRequest(request.id, { status: 'CANCELLED' });
  await recordEvent({
    organizationId: request.organizationId,
    requestId: request.id,
    type: 'request.cancelled',
    message: `${request.reference} was cancelled.`,
    data: { discordUserId: input.context.discordUserId },
  });

  return { content: `${request.reference} was cancelled. Nothing was changed.` };
}

export async function editRequestHint(requestId: string): Promise<FlowReply> {
  const request = await getStore().getRequest(requestId);
  if (!request) return { content: 'That request no longer exists.' };
  await getStore().updateRequest(requestId, { status: 'CANCELLED' });
  return {
    content: `${request.reference} was cancelled so you can change it. Send the corrected request and I will show a new confirmation.`,
  };
}

async function runNow(
  request: AutomationRequest,
  action: Action,
  context: ResolvedDiscordContext,
): Promise<FlowReply> {
  const store = getStore();

  try {
    assertTransition(request.status, 'RUNNING');
    await store.updateRequest(request.id, { status: 'RUNNING' });
    await recordEvent({
      organizationId: request.organizationId,
      requestId: request.id,
      type: 'request.started',
      message: `${request.reference} started.`,
    });

    const result = await executeAction(action, {
      organizationId: request.organizationId,
      requestId: request.id,
      reference: request.reference,
      actorDiscordUserId: context.discordUserId,
    });

    await store.updateRequest(request.id, {
      status: 'COMPLETED',
      result: {
        summary: result.summary,
        verified: result.verified,
        dryRun: result.dryRun,
        ...(result.details ?? {}),
      },
    });

    return {
      content: successMessage({ action, result, reference: request.reference }),
      requestId: request.id,
      reference: request.reference,
    };
  } catch (error) {
    return failure(request, error, request.organizationId);
  }
}

async function failure(
  request: AutomationRequest,
  error: unknown,
  organizationId: string,
): Promise<FlowReply> {
  const store = getStore();
  const status: RequestStatus =
    error instanceof AuthenticationRequiredError ? 'AUTHENTICATION_REQUIRED' : 'FAILED';

  const current = await store.getRequest(request.id);
  const from = current?.status ?? request.status;

  try {
    assertTransition(from, status);
    await store.updateRequest(request.id, { status, error: toSafeMessage(error) });
  } catch {
    // The request already reached a terminal state; keep the original outcome.
  }

  if (error instanceof AuthenticationRequiredError) {
    await notifyAuthenticationRequired(
      organizationId,
      request.reference,
      error.safeMessage,
    );
  }

  if (!(error instanceof AppError)) {
    logger.error({ err: error, requestId: request.id }, 'Request failed unexpectedly');
  }

  if (error instanceof AmbiguousAgentError) {
    const candidates = (error.details?.candidates ?? []) as Array<{
      username: string;
      fullName?: string | null;
    }>;
    const lines = candidates
      .slice(0, 10)
      .map((candidate) => `- ${candidate.fullName ?? candidate.username} (${candidate.username})`);
    return {
      content: failureMessage(
        request.reference,
        [error.safeMessage, ...lines].join('\n'),
      ),
      reference: request.reference,
    };
  }

  return {
    content: failureMessage(request.reference, toSafeMessage(error)),
    reference: request.reference,
  };
}

function readAction(request: AutomationRequest): Action | null {
  const raw = (request.payload as Record<string, unknown>)?.action;
  const parsed = actionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function connectionStatusReply(context: ResolvedDiscordContext): Promise<FlowReply> {
  const store = getStore();
  const connection = await store.getConnection(context.organizationId);
  const credentials = await credentialSummary(context.organizationId);

  const lines = ['Readymode connection status:'];
  lines.push(`Credentials stored: ${credentials.configured ? 'yes' : 'no'}`);
  if (credentials.username) lines.push(`Administrator: ${escapeDiscord(credentials.username)}`);
  lines.push(`Status: ${connection?.status ?? 'not connected'}`);
  if (connection?.lastVerifiedAt) lines.push(`Last verified: ${connection.lastVerifiedAt}`);
  if (connection?.lastError) lines.push(`Last error: ${escapeDiscord(connection.lastError)}`);
  if (config.dryRun) lines.push('Dry run is on, so no changes are saved in Readymode.');

  return { content: lines.join('\n') };
}

async function recentActionsReply(
  context: ResolvedDiscordContext,
  limit: number,
): Promise<FlowReply> {
  const events = await recentActivity(context.organizationId, limit);
  if (events.length === 0) return { content: 'No ReadySupport activity has been recorded yet.' };

  return {
    content: ['Recent ReadySupport activity:', ...events.map((event) => escapeDiscord(describeEvent(event)))]
      .join('\n')
      .slice(0, 1900),
  };
}
