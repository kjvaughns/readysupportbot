import { env } from '../config/env.js';
import {
  structuredActionSchema,
  type ActionType,
  type StructuredAction,
} from '../domain/actions.js';
import { errorFor, toReadySupportError, type ReadySupportError } from '../domain/errors.js';
import * as requests from '../db/repositories/requests.js';
import * as accounts from '../db/repositories/accounts.js';
import * as settings from '../db/repositories/settings.js';
import type { AutomationRequestRow } from '../db/types.js';
import * as audit from '../audit/audit.js';
import * as vault from '../security/secretVault.js';
import * as notifier from '../notify/notifier.js';
import { assertWasApproved } from '../approvals/service.js';
import type {
  ReadymodeAccount,
  ReadymodeService,
  WorkflowContext,
  WorkflowResult,
} from '../readymode/port.js';
import { moduleLogger } from '../util/logger.js';
import { withTimeout } from '../util/time.js';

/**
 * Running one approved request.
 *
 * This is where a validated, approved, queued intention becomes a browser
 * action. It is deliberately the only place that calls the Readymode service
 * for a mutating action, so the checks below cannot be bypassed by adding a
 * new command.
 */

const log = moduleLogger('executor');

/** What the Discord layer needs in order to report the outcome. */
export interface ExecutionOutcome {
  request: AutomationRequestRow;
  action: StructuredAction;
  succeeded: boolean;
  /** Present on success. Shape depends on the action. */
  result?: WorkflowResult<unknown>;
  /** Present on failure. Already classified and safe to show. */
  error?: ReadySupportError;
  /**
   * True when a credential was produced and is waiting in the vault for
   * ephemeral delivery. The password itself is never on this object.
   */
  hasCredential: boolean;
}

/** Per-action kill switches, checked at execution rather than at request time. */
function isActionEnabled(action: ActionType): boolean {
  const config = env();
  switch (action) {
    case 'CREATE_ACCOUNT':
      return config.ENABLE_CREATE_ACCOUNT;
    case 'CLEAR_LICENSE':
      return config.ENABLE_CLEAR_LICENSE;
    case 'RESET_PASSWORD':
      return config.ENABLE_RESET_PASSWORD;
    case 'DEACTIVATE_ACCOUNT':
      return config.ENABLE_DEACTIVATE_ACCOUNT;
    default:
      // Read-only actions are always available.
      return true;
  }
}

/**
 * Rebuild the structured action from the stored row.
 *
 * The row was sanitized on write, so any password it once carried is gone.
 * That is deliberate: a provided password lives in the in-memory vault, and if
 * the process restarted while the job was queued it is simply not there any
 * more, and a fresh one is generated instead. A password is never recovered
 * from storage because it is never in storage.
 */
function rehydrate(request: AutomationRequestRow): StructuredAction {
  const parsed = structuredActionSchema.safeParse({ ...request.input, action: request.action });

  if (!parsed.success) {
    throw errorFor('VALIDATION_FAILED', {
      message:
        'The stored details for this request are no longer valid, so I did not run it. Please submit it again.',
      details: { issues: parsed.error.issues.map((issue) => issue.message) },
    });
  }

  const action = parsed.data;

  if (action.action === 'CREATE_ACCOUNT' || action.action === 'RESET_PASSWORD') {
    const provided = vault.take(vault.keys.providedPassword(request.id));
    if (provided) {
      return { ...action, temporaryPassword: provided };
    }
  }

  return action;
}

/** Remember what we saw, so future matching has a directory to work against. */
async function rememberAccount(account: ReadymodeAccount | undefined): Promise<string | null> {
  if (!account) return null;
  try {
    const row = await accounts.record({
      readymodeUserId: account.readymodeUserId ?? null,
      username: account.username ?? null,
      email: account.email ?? null,
      fullName: account.fullName ?? null,
      agentRole: account.agentRole ?? null,
      licenseType: account.licenseType ?? null,
      team: account.team ?? null,
      campaign: account.campaign ?? null,
      queue: account.queue ?? null,
      active: account.active ?? null,
      licenseInUse: account.licenseInUse ?? null,
      snapshot: { ...account },
    });
    return row.id;
  } catch (cause) {
    // The cache is advisory. Failing to update it must not fail a job that
    // already succeeded in Readymode.
    log.warn({ err: cause }, 'Could not update the cached account directory');
    return null;
  }
}

/** Pull the account a result concerns, whatever shape the result has. */
function accountFrom(data: unknown): ReadymodeAccount | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;

  if ('after' in record) return record['after'] as ReadymodeAccount;
  if ('account' in record) return record['account'] as ReadymodeAccount;
  if ('username' in record || 'readymodeUserId' in record) return record as ReadymodeAccount;
  return undefined;
}

/** The credential a result carries, if any. Never returned to the caller. */
function credentialFrom(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const value = (data as Record<string, unknown>)['temporaryPassword'];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Strip the credential out of a result before it is stored or logged, leaving
 * a marker that one existed. The plaintext goes to the vault for ephemeral
 * delivery and nowhere else.
 */
function forStorage(result: WorkflowResult<unknown>): Record<string, unknown> {
  const data = result.data;

  const cleaned =
    data && typeof data === 'object'
      ? Object.fromEntries(
          Object.entries(data as Record<string, unknown>).filter(([key]) => key !== 'temporaryPassword'),
        )
      : { value: data };

  return {
    ...cleaned,
    verified: result.verified,
    dryRun: result.dryRun,
    ...(result.notes?.length ? { notes: result.notes } : {}),
    ...(result.evidence.finalUrl ? { finalUrl: result.evidence.finalUrl } : {}),
  };
}

async function runWorkflow(
  service: ReadymodeService,
  action: StructuredAction,
  context: WorkflowContext,
): Promise<WorkflowResult<unknown>> {
  switch (action.action) {
    case 'CREATE_ACCOUNT':
      return service.createAccount(action, context);
    case 'CLEAR_LICENSE':
      return service.clearLicense(action, context);
    case 'RESET_PASSWORD':
      return service.resetPassword(action, context);
    case 'DEACTIVATE_ACCOUNT':
      return service.deactivateAccount(action, context);
    case 'CHECK_LICENSE_USAGE':
      return service.checkLicenseUsage(action, context);
    case 'CHECK_AGENT_STATUS':
      return service.checkAgentStatus(action, context);
    case 'LIST_RECENT_ACTIONS':
      // Answered from the audit log by the Discord layer; it never reaches
      // the queue.
      throw errorFor('UNKNOWN', {
        message: 'That request does not need a Readymode session.',
      });
  }
}

/**
 * Execute a claimed request. Always resolves — failures are classified and
 * returned rather than thrown, because the caller has to record and report
 * every outcome, not just the happy one.
 */
export async function execute(
  request: AutomationRequestRow,
  service: ReadymodeService,
): Promise<ExecutionOutcome> {
  const startedAt = new Date().toISOString();
  let action: StructuredAction | undefined;

  try {
    // Nothing runs that was not confirmed. The queue only claims APPROVED
    // rows, but this asks the approvals table directly rather than trusting a
    // status column that a bug could set.
    await assertWasApproved(request);

    action = rehydrate(request);

    if (!isActionEnabled(action.action)) {
      throw errorFor('ACTION_DISABLED', {
        message:
          `${action.action.toLowerCase().replaceAll('_', ' ')} is switched off right now. ` +
          'An administrator has to enable it once its Readymode steps have been verified.',
      });
    }

    await audit.recordForRequest(request, 'EXECUTION_STARTED', {
      executedAt: startedAt,
      status: 'RUNNING',
      metadata: { driver: service.name, dryRun: request.dry_run },
    });

    const context: WorkflowContext = {
      requestId: request.id,
      reference: request.reference,
      dryRun: request.dry_run,
    };

    const result = await withTimeout(
      runWorkflow(service, action, context),
      env().WORKFLOW_TIMEOUT_MS,
      `${action.action} workflow`,
    );

    // A mutating workflow that could not confirm its own change is a failure,
    // not a success with a caveat.
    if (!result.dryRun && !result.verified && isMutatingResult(action.action)) {
      throw errorFor('VERIFICATION_FAILED', {
        details: { action: action.action },
      });
    }

    const credential = credentialFrom(result.data);
    if (credential) {
      vault.put(vault.keys.deliverablePassword(request.id), credential);
    }

    const account = accountFrom(result.data);
    const accountId = await rememberAccount(account);

    const completed = await requests.update(
      request.id,
      {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        result: forStorage(result),
        targetAccountId: accountId,
        ...(result.evidence.screenshotPath ? { screenshotPath: result.evidence.screenshotPath } : {}),
        errorCategory: null,
        errorMessage: null,
      },
      'RUNNING',
    );

    await audit.recordForRequest(completed, 'EXECUTION_VERIFIED', {
      executedAt: startedAt,
      status: 'COMPLETED',
      previousState: previousStateFrom(result.data),
      newState: newStateFrom(result.data),
      ...(result.evidence.screenshotPath ? { screenshotPath: result.evidence.screenshotPath } : {}),
      metadata: { verified: result.verified, dryRun: result.dryRun, driver: service.name },
    });
    await audit.recordForRequest(completed, 'EXECUTION_COMPLETED', {
      executedAt: startedAt,
      status: 'COMPLETED',
    });

    await settings.recordSuccess(completed.action, completed.reference);

    return {
      request: completed,
      action,
      succeeded: true,
      result,
      hasCredential: Boolean(credential),
    };
  } catch (cause) {
    const error = toReadySupportError(cause);
    const failed = await recordFailure(request, error, startedAt);

    return {
      request: failed,
      action: action ?? fallbackAction(request),
      succeeded: false,
      error,
      hasCredential: false,
    };
  }
}

function isMutatingResult(action: ActionType): boolean {
  return (
    action === 'CREATE_ACCOUNT' ||
    action === 'CLEAR_LICENSE' ||
    action === 'RESET_PASSWORD' ||
    action === 'DEACTIVATE_ACCOUNT'
  );
}

function previousStateFrom(data: unknown): unknown {
  if (data && typeof data === 'object' && 'before' in (data as Record<string, unknown>)) {
    return (data as Record<string, unknown>)['before'];
  }
  return null;
}

function newStateFrom(data: unknown): unknown {
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  if ('after' in record) return record['after'];
  if ('account' in record) {
    const account = record['account'];
    return account && typeof account === 'object'
      ? Object.fromEntries(Object.entries(account as Record<string, unknown>))
      : account;
  }
  return null;
}

/**
 * Record a failure and decide whether the queue should stop.
 *
 * An authentication problem pauses the queue rather than failing everything
 * behind it: those requests were valid, and they should run once someone
 * reconnects rather than have to be typed again.
 */
async function recordFailure(
  request: AutomationRequestRow,
  error: ReadySupportError,
  startedAt: string,
): Promise<AutomationRequestRow> {
  const authProblem = error.category === 'AUTH_EXPIRED' || error.category === 'VERIFICATION_REQUIRED';
  const status = authProblem ? 'AUTHENTICATION_REQUIRED' : 'FAILED';

  const updated = await requests.update(
    request.id,
    {
      status,
      errorCategory: error.category,
      errorMessage: error.userMessage,
      ...(authProblem ? {} : { completedAt: new Date().toISOString() }),
    },
    'RUNNING',
  );

  await audit.recordForRequest(updated, authProblem ? 'AUTHENTICATION_REQUIRED' : 'EXECUTION_FAILED', {
    executedAt: startedAt,
    status,
    errorCategory: error.category,
    errorMessage: error.userMessage,
    metadata: { details: error.details },
  });

  log.warn(
    { requestId: request.id, reference: request.reference, category: error.category },
    'Workflow failed',
  );

  if (authProblem) {
    await settings.pauseQueue(
      error.category === 'VERIFICATION_REQUIRED'
        ? 'Readymode asked for manual verification.'
        : 'The Readymode session expired.',
      'system',
    );
    await settings.set('readymode_auth_state', {
      state: error.category === 'VERIFICATION_REQUIRED' ? 'VERIFICATION_REQUIRED' : 'EXPIRED',
      checkedAt: new Date().toISOString(),
      detail: error.userMessage,
    });

    if (error.category === 'VERIFICATION_REQUIRED') {
      await notifier.alertVerificationRequired(error.userMessage);
    } else {
      await notifier.alertAuthenticationExpired(error.userMessage);
    }

    return updated;
  }

  const consecutive = await settings.recordFailure(error.category);
  if (consecutive >= 3) {
    await notifier.alertConsecutiveFailures(consecutive, error.userMessage);
  }

  if (error.category === 'SELECTOR_NOT_CONFIGURED' || error.category === 'INTERFACE_CHANGED') {
    await notifier.alertSelectorsBroken(request.action, error.userMessage);
  }

  return updated;
}

/**
 * When rehydration itself failed there is no parsed action, but the outcome
 * still has to name what was attempted.
 */
function fallbackAction(request: AutomationRequestRow): StructuredAction {
  return { action: 'LIST_RECENT_ACTIONS', limit: 1, status: 'ALL' } as StructuredAction & {
    action: 'LIST_RECENT_ACTIONS';
  };
}
