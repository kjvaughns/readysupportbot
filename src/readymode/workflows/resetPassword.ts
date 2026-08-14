import { describeAccountRef, type ResetPasswordAction } from '../../domain/actions.js';
import { errorFor } from '../../domain/errors.js';
import { generateTemporaryPassword } from '../../util/password.js';
import { findOne, openAgentAtIndex, readAgentDetail } from '../agents.js';
import { isVisible, isVisibleIfConfigured, locate } from '../browser.js';
import { getSelector, UNKNOWN } from '../selectors.js';
import { requirePage } from '../session.js';
import { runWorkflow } from '../workflowRunner.js';
import type { PasswordResetResult, WorkflowContext, WorkflowResult } from '../port.js';

/**
 * Setting a new temporary password.
 *
 * Verification here is necessarily weaker than for the other workflows, and it
 * is worth being honest about why: there is no way to read a password back out
 * of Readymode to confirm it took. What can be confirmed is that Readymode
 * accepted the change and did not report an error, and that is what this
 * checks. Anything stronger would mean signing in as the agent, which would
 * consume their license and is not something a support tool should do.
 *
 * The password itself is generated here, typed into the form, and returned in
 * memory. It is not written to the database, not logged, and blanked out of the
 * page before any screenshot.
 */

export const RESET_PASSWORD_SELECTORS = [
  'page.agents.marker',
  'agents.search.input',
  'agents.results.row',
  'page.agentDetail.marker',
  'resetPassword.trigger.button',
  'resetPassword.newPassword.input',
  'resetPassword.submit.button',
] as const;

export const RESET_PASSWORD_ROUTES = ['route.agents'] as const;

export async function resetPassword(
  action: ResetPasswordAction,
  context: WorkflowContext,
): Promise<WorkflowResult<PasswordResetResult>> {
  return runWorkflow<PasswordResetResult>({
    name: 'reset password',
    selectorIds: RESET_PASSWORD_SELECTORS,
    routeIds: RESET_PASSWORD_ROUTES,
    context,

    async run({ page, dryRun }) {
      const describe = describeAccountRef(action.target);

      const { index } = await findOne(page, action.target, describe);
      await openAgentAtIndex(page, index);
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");

      const account = await readAgentDetail(page);
      const who = account.fullName ?? account.username ?? describe;

      if (account.active === false) {
        throw errorFor('PRECONDITION_FAILED', {
          message: `${who}'s account is deactivated. Reactivate it first if they need to sign in again.`,
        });
      }

      const temporaryPassword = action.temporaryPassword ?? generateTemporaryPassword();
      const passwordSource: PasswordResetResult['passwordSource'] = action.temporaryPassword
        ? 'provided'
        : 'generated';

      if (dryRun) {
        return {
          data: { account, temporaryPassword, passwordSource },
          verified: false,
          notes: [`Test mode: ${who}'s password was not changed.`],
          evidenceLabel: 'reset-password-dry-run',
        };
      }

      await locate(page, 'resetPassword.trigger.button').first().click();
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);

      await locate(page, 'resetPassword.newPassword.input').first().fill(temporaryPassword);

      if (getSelector('resetPassword.confirmPassword.input').value !== UNKNOWN) {
        await locate(page, 'resetPassword.confirmPassword.input').first().fill(temporaryPassword);
      }

      await locate(page, 'resetPassword.submit.button').first().click();
      await page.waitForLoadState('networkidle').catch(() => undefined);

      if (await isVisibleIfConfigured(page, 'create.validationError.marker', 2_000)) {
        throw errorFor('PRECONDITION_FAILED', {
          message:
            `Readymode rejected the new password for ${who}. It may not meet the password rules on that account.`,
        });
      }

      if (getSelector('resetPassword.success.marker').value !== UNKNOWN) {
        const confirmed = await isVisible(page, 'resetPassword.success.marker', 10_000);
        if (!confirmed) {
          throw errorFor('VERIFICATION_FAILED', {
            message:
              `I submitted a new password for ${who} but Readymode did not confirm it. ` +
              'Check the account before trying again — it may have gone through.',
          });
        }
      }

      // Re-read the account so the audit record reflects the live state, and
      // so a reset that silently landed on the wrong page is caught.
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");
      const after = await readAgentDetail(page);

      return {
        data: { account: after, temporaryPassword, passwordSource },
        verified: true,
        evidenceLabel: 'reset-password',
      };
    },
  });
}
