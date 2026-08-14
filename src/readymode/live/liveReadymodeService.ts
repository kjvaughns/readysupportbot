import { toReadySupportError } from '../../domain/errors.js';
import { moduleLogger } from '../../util/logger.js';
import { nowIso } from '../../util/time.js';
import { openSession } from '../browser.js';
import { coverage } from '../selectors.js';
import { checkAuthentication as probeAuthentication, signIn } from '../session.js';
import { checkAgentStatus } from '../workflows/checkAgentStatus.js';
import { checkLicenseUsage } from '../workflows/checkLicenseUsage.js';
import { clearLicense } from '../workflows/clearLicense.js';
import { createAccount } from '../workflows/createAccount.js';
import { deactivateAccount } from '../workflows/deactivateAccount.js';
import { resetPassword } from '../workflows/resetPassword.js';
import type {
  AuthStatus,
  CreatedAccount,
  LicenseUsage,
  PasswordResetResult,
  ReadymodeAccount,
  ReadymodeService,
  StateChange,
  WorkflowContext,
  WorkflowResult,
} from '../port.js';
import type {
  CheckAgentStatusAction,
  CheckLicenseUsageAction,
  ClearLicenseAction,
  CreateAccountAction,
  DeactivateAccountAction,
  ResetPasswordAction,
} from '../../domain/actions.js';

/**
 * The live driver.
 *
 * Thin on purpose: each method is one predefined workflow, and the workflow
 * owns its own sequence, selectors and verification. There is no method here
 * that takes a free-form instruction, and no path by which a model's output
 * reaches the browser as anything other than validated parameters to one of
 * these six.
 */

const log = moduleLogger('readymode-live');

export class LiveReadymodeService implements ReadymodeService {
  readonly name = 'live' as const;

  constructor() {
    const map = coverage();
    if (map.configured < map.total) {
      log.warn(
        { configured: map.configured, total: map.total, overlayPath: map.overlayPath },
        'Some parts of the Readymode interface are not mapped yet. Workflows that need them will refuse to run.',
      );
    }
  }

  /**
   * Probe without signing in. Opens its own short session because the health
   * view can be asked at any time, including while the queue is idle.
   */
  async checkAuthentication(): Promise<AuthStatus> {
    let session;
    try {
      session = await openSession();
    } catch (cause) {
      const error = toReadySupportError(cause);
      return {
        state: 'UNKNOWN',
        detail: error.userMessage,
        checkedAt: nowIso(),
      };
    }

    try {
      return await probeAuthentication(session);
    } catch (cause) {
      const error = toReadySupportError(cause);
      return { state: 'UNKNOWN', detail: error.userMessage, checkedAt: nowIso() };
    } finally {
      await session.close();
    }
  }

  /**
   * Try to restore access with the stored credentials.
   *
   * Stops if Readymode asks for a CAPTCHA or a verification code. Those are
   * handed to a human, never worked around.
   */
  async reconnect(): Promise<AuthStatus> {
    let session;
    try {
      session = await openSession();
    } catch (cause) {
      const error = toReadySupportError(cause);
      return { state: 'UNKNOWN', detail: error.userMessage, checkedAt: nowIso() };
    }

    try {
      const existing = await probeAuthentication(session);
      if (existing.state === 'AUTHENTICATED') return existing;
      if (existing.state === 'VERIFICATION_REQUIRED') return existing;

      return await signIn(session);
    } catch (cause) {
      const error = toReadySupportError(cause);
      return { state: 'UNKNOWN', detail: error.userMessage, checkedAt: nowIso() };
    } finally {
      await session.close();
    }
  }

  async createAccount(
    action: CreateAccountAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<CreatedAccount>> {
    return createAccount(action, context);
  }

  async clearLicense(
    action: ClearLicenseAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<StateChange>> {
    return clearLicense(action, context);
  }

  async resetPassword(
    action: ResetPasswordAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<PasswordResetResult>> {
    return resetPassword(action, context);
  }

  async deactivateAccount(
    action: DeactivateAccountAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<StateChange>> {
    return deactivateAccount(action, context);
  }

  async checkLicenseUsage(
    action: CheckLicenseUsageAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<LicenseUsage>> {
    return checkLicenseUsage(action, context);
  }

  async checkAgentStatus(
    action: CheckAgentStatusAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<ReadymodeAccount>> {
    return checkAgentStatus(action, context);
  }

  /**
   * Nothing to release: each workflow opens and closes its own session, so
   * there is no long-lived browser to tear down. Sessions are per-job because
   * a browser held open for hours is a browser whose state nobody can account
   * for.
   */
  async shutdown(): Promise<void> {
    log.debug('Live driver shutdown: no persistent browser to close');
  }
}
