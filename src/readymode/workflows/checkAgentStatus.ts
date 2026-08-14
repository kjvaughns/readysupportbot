import { describeAccountRef, type CheckAgentStatusAction } from '../../domain/actions.js';
import { findOne, openAgentAtIndex, readAgentDetail } from '../agents.js';
import { requirePage } from '../session.js';
import { runWorkflow } from '../workflowRunner.js';
import type { ReadymodeAccount, WorkflowContext, WorkflowResult } from '../port.js';

/**
 * Report on one agent.
 *
 * Read-only, so there is no confirmation step and no dry-run distinction — it
 * changes nothing either way. It still goes through the same matcher as the
 * mutating workflows: reporting on the wrong John Brown is a smaller mistake
 * than deactivating him, but it is still a mistake, and one that would lead
 * somebody to act on the wrong answer.
 */

export const CHECK_AGENT_STATUS_SELECTORS = [
  'page.agents.marker',
  'agents.search.input',
  'agents.results.row',
  'page.agentDetail.marker',
] as const;

export const CHECK_AGENT_STATUS_ROUTES = ['route.agents'] as const;

export async function checkAgentStatus(
  action: CheckAgentStatusAction,
  context: WorkflowContext,
): Promise<WorkflowResult<ReadymodeAccount>> {
  return runWorkflow<ReadymodeAccount>({
    name: 'check agent status',
    selectorIds: CHECK_AGENT_STATUS_SELECTORS,
    routeIds: CHECK_AGENT_STATUS_ROUTES,
    context,

    async run({ page }) {
      const describe = describeAccountRef(action.target);

      const { index } = await findOne(page, action.target, describe);

      await openAgentAtIndex(page, index);
      await requirePage(page, 'page.agentDetail.marker', "the agent's page");

      const account = await readAgentDetail(page);

      return {
        data: account,
        // A read is verified by definition: this is what the page says.
        verified: true,
        evidenceLabel: 'agent-status',
      };
    },
  });
}
