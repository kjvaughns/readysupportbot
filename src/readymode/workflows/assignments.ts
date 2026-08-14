import { ReadymodeAgent } from '../../types';
import { AppError } from '../../security/errors';
import { sanitizePageValue } from '../../security/sanitize';
import { describeAgent } from '../agents';
import { CAMPAIGN_CONTROLS, QUEUE_CONTROLS } from '../selectors';
import { discover } from '../selectors/discovery';
import { WorkflowContext, WorkflowDefinition, runWorkflow, step } from './harness';
import { openAgent, reopenAgent, saveAgentForm } from './pageOperations';

/**
 * Campaign and queue assignment.
 *
 * Both use the same shape: open the agent, read what is assigned now, tick only
 * what was approved, save, reload, and confirm the result matches.
 */

export interface AssignmentInput {
  agent: ReadymodeAgent;
  names: string[];
}

interface AssignmentOutput extends Record<string, unknown> {
  verified: boolean;
  summary: string;
  assigned: string[];
  previous: string[];
}

function assignmentWorkflow(
  kind: 'campaigns' | 'queues',
): WorkflowDefinition<AssignmentInput, AssignmentOutput> {
  const controls = kind === 'campaigns' ? CAMPAIGN_CONTROLS : QUEUE_CONTROLS;
  const label = kind === 'campaigns' ? 'campaigns' : 'queues';

  return {
    name: `${kind}.assign`,
    describe: (input) =>
      `Assign ${label} ${input.names.map((name) => sanitizePageValue(name)).join(', ')} to ${describeAgent(input.agent)}`,

    async run(context, input) {
      await step(context, 'open-agent', () => openAgent(context, input.agent));

      const section = await discover(context.session.page, controls.section);
      const previous = await readChecked(section);

      if (context.dryRun) {
        return {
          verified: false,
          summary: `Dry run: ${label} would become ${input.names.join(', ')} for ${describeAgent(input.agent)}.`,
          assigned: input.names,
          previous,
        };
      }

      const wanted = new Set(input.names.map((name) => name.trim().toLowerCase()));
      const checkboxes = section.locator('input[type="checkbox"]');
      const count = await checkboxes.count();
      const seen = new Set<string>();

      for (let index = 0; index < count; index += 1) {
        const checkbox = checkboxes.nth(index);
        const name = (await labelFor(checkbox)).toLowerCase();
        if (!name) continue;
        seen.add(name);

        const shouldCheck = wanted.has(name);
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (shouldCheck === isChecked) continue;
        if (shouldCheck) await checkbox.check({ timeout: 5000 });
        else await checkbox.uncheck({ timeout: 5000 });
      }

      const missing = [...wanted].filter((name) => !seen.has(name));
      if (missing.length > 0) {
        throw new AppError(
          'assignment_not_available',
          `These ${label} do not exist in Readymode, so nothing was saved: ${missing.join(', ')}.`,
          409,
        );
      }

      const saved = await step(context, 'save', () => saveAgentForm(context));
      if (!saved) {
        throw new AppError('save_not_confirmed', 'Readymode did not confirm the save.', 503);
      }

      await step(context, 'reopen', () => reopenAgent(context, input.agent));
      const verifiedSection = await discover(context.session.page, controls.section);
      const assigned = await readChecked(verifiedSection);

      const expected = [...wanted].sort();
      const actual = assigned.map((name) => name.toLowerCase()).sort();
      if (expected.join('|') !== actual.join('|')) {
        throw new AppError(
          'verification_failed',
          `The saved ${label} do not match the request. Readymode now shows: ${assigned.join(', ') || 'none'}.`,
          409,
        );
      }

      return {
        verified: true,
        summary: `${describeAgent(input.agent)} is now assigned to ${label}: ${assigned.join(', ') || 'none'}.`,
        assigned,
        previous,
      };
    },
  };
}

async function readChecked(section: {
  locator: (selector: string) => {
    count: () => Promise<number>;
    nth: (index: number) => any;
  };
}): Promise<string[]> {
  const checkboxes = section.locator('input[type="checkbox"]');
  const count = await checkboxes.count();
  const values: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!(await checkbox.isChecked().catch(() => false))) continue;
    const name = await labelFor(checkbox);
    if (name) values.push(name);
  }
  return values;
}

async function labelFor(checkbox: any): Promise<string> {
  const aria = (await checkbox.getAttribute('aria-label').catch(() => null)) ?? '';
  if (aria) return sanitizePageValue(aria, 80);
  const value = (await checkbox.getAttribute('value').catch(() => null)) ?? '';
  const parentText = await checkbox
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  return sanitizePageValue(parentText || value, 80);
}

export const assignCampaignsWorkflow = assignmentWorkflow('campaigns');
export const assignQueuesWorkflow = assignmentWorkflow('queues');

export const runAssignCampaignsWorkflow = (context: WorkflowContext, input: AssignmentInput) =>
  runWorkflow(assignCampaignsWorkflow, context, input);
export const runAssignQueuesWorkflow = (context: WorkflowContext, input: AssignmentInput) =>
  runWorkflow(assignQueuesWorkflow, context, input);
