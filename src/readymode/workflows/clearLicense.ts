import { describeAccountRef, type ClearLicenseAction } from '../../domain/actions.js';
import { errorFor } from '../../domain/errors.js';
import { findOne, openAgentAtIndex, readAgentDetail } from '../agents.js';
import { isVisible, locate } from '../browser.js';
import { getSelector, UNKNOWN } from '../selectors.js';
import { requirePage } from '../session.js';
import { runWorkflow } from '../workflowRunner.js';
import type { StateChange, WorkflowContext, WorkflowResult } from '../port.js';

/**
 * Releasing the license an agent is holding.
 *
 * Two guards before anything is clicked. If the agent is not holding a license
 * there is nothing to do, and doing it anyway would be a change nobody asked
 * for. And if they are on a call, clearing the license drops that call — a
 * real person mid-conversation with a customer — so the workflow stops and
 * makes an admin say so explicitly.
 *
 * Afterwards the page is reloaded and re-read. A "license cleared" banner is
 * Readymode's account of what happened; the reload is ours.
 */

export const CLEAR_LICENSE_SELECTORS = [
  'page.agents.marker',
  'agents.search.input',
  'agents.results.row',
  'page.agentDetail.marker',
  'agent.detail.licenseState',
  'clearLicense.trigger.button',
] as const;

export const CLEAR_LICENSE_ROUTES = ['route.agents'] as const;

export async function clearLicense(
  action: ClearLicenseAction,
  context: WorkflowContext,
): Promise<WorkflowResult<StateChange>> {
  return runWorkflow<StateChange>({
    name: 'clear license',
    selectorIds: CLEAR_LICENSE_SELECTORS,
    routeIds: CLEAR_LICENSE_ROUTES,
    context,

    async run({ page, dryRun }) {
      const describe = describeAccountRef(action.target);

      const { index } = await findOne(page, action.target, describe);
      await openAgentAtIndex(page, index);
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");

      const before = await readAgentDetail(page);
      const who = before.fullName ?? before.username ?? describe;

      if (before.licenseInUse === false) {
        throw errorFor('PRECONDITION_FAILED', {
          message: `${who} is not holding a license right now, so there was nothing to clear.`,
          details: { licenseInUse: false },
        });
      }

      if (before.onCall === true && !action.overrideActiveCall) {
        throw errorFor('PRECONDITION_FAILED', {
          message:
            `${who} is on a call right now. Clearing the license will drop that call. ` +
            'An owner or admin has to run this again with the on-a-call option to confirm.',
          details: { onCall: true, requiresAdminOverride: true },
        });
      }

      if (dryRun) {
        return {
          data: { before, after: before },
          verified: false,
          notes: [
            `Test mode: ${who} is holding a license and it would have been cleared, but nothing was submitted.`,
          ],
          evidenceLabel: 'clear-license-dry-run',
        };
      }

      await locate(page, 'clearLicense.trigger.button').first().click();

      // Some instances ask for confirmation, some do not. The dialog button is
      // optional in the registry for that reason.
      if (getSelector('clearLicense.confirm.button').value !== UNKNOWN) {
        if (await isVisible(page, 'clearLicense.confirm.button', 5_000)) {
          await locate(page, 'clearLicense.confirm.button').first().click();
        }
      }

      if (getSelector('clearLicense.success.marker').value !== UNKNOWN) {
        const confirmed = await isVisible(page, 'clearLicense.success.marker', 10_000);
        if (!confirmed) {
          throw errorFor('VERIFICATION_FAILED', {
            message: `I asked Readymode to clear the license from ${who} but it did not confirm. Check before trying again.`,
          });
        }
      }

      // Independent check: reload and read the state again.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");
      const after = await readAgentDetail(page);

      if (after.licenseInUse === true) {
        throw errorFor('VERIFICATION_FAILED', {
          message: `Readymode still shows a license assigned to ${who} after the change. I have not tried again — check the account first.`,
          details: { licenseInUse: true },
        });
      }

      if (after.licenseInUse === undefined) {
        throw errorFor('VERIFICATION_FAILED', {
          message:
            `I could not read the license state for ${who} after the change, so I cannot confirm it worked. ` +
            'Check the account in Readymode.',
        });
      }

      return {
        data: { before, after },
        verified: true,
        evidenceLabel: 'clear-license',
      };
    },
  });
}
