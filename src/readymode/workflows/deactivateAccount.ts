import { describeAccountRef, type DeactivateAccountAction } from '../../domain/actions.js';
import { errorFor } from '../../domain/errors.js';
import { findOne, openAgentAtIndex, readAgentDetail } from '../agents.js';
import { isVisible, locate } from '../browser.js';
import { getSelector, UNKNOWN } from '../selectors.js';
import { requirePage } from '../session.js';
import { runWorkflow } from '../workflowRunner.js';
import type { StateChange, WorkflowContext, WorkflowResult } from '../port.js';

/**
 * Deactivating an account.
 *
 * The most consequential thing this system does, and the only one that needs a
 * second person to sign off — that rule is enforced before the job ever
 * reaches here, in the approvals service and again by a database trigger.
 *
 * What this workflow adds is the same discipline as the others: confirm the
 * account is the right one and is not already deactivated, act, then reload and
 * confirm it really is deactivated now. An unverifiable result is a failure,
 * not a qualified success, because "I think I deactivated someone" is not an
 * acceptable thing to tell an administrator.
 */

export const DEACTIVATE_SELECTORS = [
  'page.agents.marker',
  'agents.search.input',
  'agents.results.row',
  'page.agentDetail.marker',
  'agent.detail.activeState',
  'deactivate.trigger.button',
] as const;

export const DEACTIVATE_ROUTES = ['route.agents'] as const;

export async function deactivateAccount(
  action: DeactivateAccountAction,
  context: WorkflowContext,
): Promise<WorkflowResult<StateChange>> {
  return runWorkflow<StateChange>({
    name: 'deactivate account',
    selectorIds: DEACTIVATE_SELECTORS,
    routeIds: DEACTIVATE_ROUTES,
    context,

    async run({ page, dryRun }) {
      const describe = describeAccountRef(action.target);

      const { index } = await findOne(page, action.target, describe);
      await openAgentAtIndex(page, index);
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");

      const before = await readAgentDetail(page);
      const who = before.fullName ?? before.username ?? describe;

      if (before.active === false) {
        throw errorFor('PRECONDITION_FAILED', {
          message: `${who}'s account is already deactivated, so there was nothing to do.`,
        });
      }

      if (before.active === undefined) {
        // Not knowing the current state means not being able to prove the
        // change afterwards. Stopping is better than acting blind on the one
        // action that is hardest to undo.
        throw errorFor('VERIFICATION_FAILED', {
          message:
            `I could not read whether ${who}'s account is currently active, so I stopped rather than deactivate it. ` +
            'The account status field may need re-mapping.',
        });
      }

      if (dryRun) {
        return {
          data: { before, after: before },
          verified: false,
          notes: [`Test mode: ${who}'s account is active and would have been deactivated. Nothing was submitted.`],
          evidenceLabel: 'deactivate-dry-run',
        };
      }

      await locate(page, 'deactivate.trigger.button').first().click();

      if (getSelector('deactivate.confirm.button').value !== UNKNOWN) {
        if (await isVisible(page, 'deactivate.confirm.button', 5_000)) {
          await locate(page, 'deactivate.confirm.button').first().click();
        }
      }

      if (getSelector('deactivate.success.marker').value !== UNKNOWN) {
        const confirmed = await isVisible(page, 'deactivate.success.marker', 10_000);
        if (!confirmed) {
          throw errorFor('VERIFICATION_FAILED', {
            message: `I asked Readymode to deactivate ${who} but it did not confirm. Check the account before trying again.`,
          });
        }
      }

      await page.reload({ waitUntil: 'domcontentloaded' });
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");
      const after = await readAgentDetail(page);

      if (after.active !== false) {
        throw errorFor('VERIFICATION_FAILED', {
          message:
            `Readymode does not show ${who}'s account as deactivated after the change. ` +
            'I have not tried again — check the account first.',
          details: { active: after.active },
        });
      }

      return {
        data: { before, after },
        verified: true,
        evidenceLabel: 'deactivate-account',
      };
    },
  });
}
