import { ReadymodeAgent } from '../../types';
import { AppError } from '../../security/errors';
import { sanitizePageValue } from '../../security/sanitize';
import { NewAccount } from '../../openai/schema';
import { describeAgent } from '../agents';
import { AGENT_CONTROLS, LICENSE_CONTROLS, ROUTES } from '../selectors';
import { discover, tryDiscover } from '../selectors/discovery';
import { WorkflowContext, WorkflowDefinition, navigate, runWorkflow, step, waitForResult } from './harness';
import { listAgents, openAgent, pageText, saveAgentForm } from './pageOperations';

/**
 * Account and license workflows.
 *
 * Each one reads the current Readymode state first, performs only the approved
 * change, and then verifies the outcome by reading it back.
 */

export interface CreateAccountInput {
  account: NewAccount;
}

export interface CreateAccountOutput extends Record<string, unknown> {
  verified: boolean;
  summary: string;
  username: string;
  created: boolean;
}

export const createAccountWorkflow: WorkflowDefinition<CreateAccountInput, CreateAccountOutput> = {
  name: 'accounts.create',
  describe: (input) => `Create the Readymode account for ${sanitizePageValue(input.account.fullName)}`,

  async run(context, input) {
    const username = input.account.username ?? suggestUsername(input.account.fullName);

    // Reading first means a duplicate is detected before anything is created.
    const existing = await step(context, 'check-existing', () => listAgents(context, username));
    if (existing.some((agent) => agent.username.toLowerCase() === username.toLowerCase())) {
      throw new AppError(
        'account_exists',
        `A Readymode account with the username ${username} already exists. Nothing was created.`,
        409,
      );
    }

    if (context.dryRun) {
      return {
        verified: false,
        summary: `Dry run: an account for ${sanitizePageValue(input.account.fullName)} (${username}) would be created.`,
        username,
        created: false,
      };
    }

    const { page } = context.session;
    await navigate(context, ROUTES.agents);
    const createButton = await discover(page, AGENT_CONTROLS.createButton);
    await createButton.click();

    await fillIfPresent(context, /full name|name/i, input.account.fullName);
    await fillIfPresent(context, /user\s*name|login/i, username);
    if (input.account.email) await fillIfPresent(context, /email/i, input.account.email);

    const saved = await step(context, 'save', () => saveAgentForm(context));
    if (!saved) {
      throw new AppError(
        'save_not_confirmed',
        'Readymode did not confirm the new account was saved, so it was not verified.',
        503,
      );
    }

    const after = await step(context, 'verify', () => listAgents(context, username));
    const created = after.find((agent) => agent.username.toLowerCase() === username.toLowerCase());
    if (!created) {
      throw new AppError(
        'verification_failed',
        'The new account could not be found after saving, so the result was not verified.',
        409,
      );
    }

    return {
      verified: true,
      summary: `Account created for ${sanitizePageValue(input.account.fullName)} (${username}).`,
      username,
      created: true,
    };
  },
};

export interface AgentActionInput {
  agent: ReadymodeAgent;
}

export const clearLicenseWorkflow: WorkflowDefinition<
  AgentActionInput,
  Record<string, unknown> & { verified: boolean; summary: string }
> = {
  name: 'licenses.clear',
  describe: (input) => `Clear the license held by ${describeAgent(input.agent)}`,

  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));

    if (context.dryRun) {
      return {
        verified: false,
        summary: `Dry run: the license for ${describeAgent(input.agent)} would be cleared.`,
      };
    }

    const control = await discover(context.session.page, AGENT_CONTROLS.clearLicense);
    await control.click();

    const cleared = await waitForResult(
      context.session.page,
      async () => {
        const text = (await pageText(context.session.page)).toLowerCase();
        return /licen[cs]e (cleared|released|available)|not logged in/.test(text);
      },
      { what: 'license cleared confirmation', timeoutMs: 12_000 },
    );

    if (!cleared) {
      throw new AppError(
        'verification_failed',
        'Readymode did not confirm the license was cleared. No further attempt was made.',
        409,
      );
    }

    return { verified: true, summary: `License cleared for ${describeAgent(input.agent)}.` };
  },
};

export const resetPasswordWorkflow: WorkflowDefinition<
  AgentActionInput,
  Record<string, unknown> & { verified: boolean; summary: string }
> = {
  name: 'accounts.reset_password',
  describe: (input) => `Reset the password for ${describeAgent(input.agent)}`,

  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));

    if (context.dryRun) {
      return {
        verified: false,
        summary: `Dry run: the password for ${describeAgent(input.agent)} would be reset.`,
      };
    }

    const control = await discover(context.session.page, AGENT_CONTROLS.resetPassword);
    await control.click();

    const done = await waitForResult(
      context.session.page,
      async () => {
        const text = (await pageText(context.session.page)).toLowerCase();
        return /password (reset|updated|changed|sent)/.test(text);
      },
      { what: 'password reset confirmation', timeoutMs: 12_000 },
    );

    if (!done) {
      throw new AppError(
        'verification_failed',
        'Readymode did not confirm the password reset, so it was not verified.',
        409,
      );
    }

    // The new password is never read from the page, logged, or sent to Discord.
    return {
      verified: true,
      summary: `Password reset for ${describeAgent(input.agent)}. Readymode delivered the new password through its own channel.`,
    };
  },
};

export const deactivateAccountWorkflow: WorkflowDefinition<
  AgentActionInput,
  Record<string, unknown> & { verified: boolean; summary: string }
> = {
  name: 'accounts.deactivate',
  describe: (input) => `Deactivate the account for ${describeAgent(input.agent)}`,

  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));

    if (context.dryRun) {
      return {
        verified: false,
        summary: `Dry run: the account for ${describeAgent(input.agent)} would be deactivated.`,
      };
    }

    const control = await discover(context.session.page, AGENT_CONTROLS.deactivate);
    await control.click();

    const saved = await saveAgentForm(context).catch(() => true);
    if (!saved) {
      throw new AppError('save_not_confirmed', 'Readymode did not confirm the change.', 503);
    }

    const after = await step(context, 'verify', () => listAgents(context, input.agent.username));
    const match = after.find(
      (agent) => String(agent.readymodeUserId) === String(input.agent.readymodeUserId),
    );

    if (match?.active !== false) {
      throw new AppError(
        'verification_failed',
        'The account still reads as active after saving, so the change was not verified.',
        409,
      );
    }

    return { verified: true, summary: `Account deactivated for ${describeAgent(input.agent)}.` };
  },
};

export const agentStatusWorkflow: WorkflowDefinition<
  AgentActionInput,
  Record<string, unknown> & { verified: boolean; summary: string }
> = {
  name: 'agents.status',
  describe: (input) => `Check whether ${describeAgent(input.agent)} is logged in`,

  async run(context, input) {
    const matches = await step(context, 'search', () =>
      listAgents(context, input.agent.username || String(input.agent.readymodeUserId)),
    );
    const agent =
      matches.find((entry) => String(entry.readymodeUserId) === String(input.agent.readymodeUserId)) ??
      input.agent;

    const indicator = await tryDiscover(context.session.page, AGENT_CONTROLS.loggedInIndicator, {
      timeoutMs: 800,
      allowFirstOfMany: true,
    });
    const loggedIn = agent.loggedIn ?? Boolean(indicator.locator);

    return {
      verified: true,
      summary: `${describeAgent(agent)} is ${loggedIn ? 'logged in' : 'not logged in'}${
        agent.active === false ? ' and the account is inactive' : ''
      }.`,
      loggedIn,
      active: agent.active ?? true,
    };
  },
};

export const licenseUsageWorkflow: WorkflowDefinition<
  Record<string, never>,
  Record<string, unknown> & { verified: boolean; summary: string }
> = {
  name: 'licenses.usage',
  describe: () => 'Read which agents are currently using licenses',

  async run(context) {
    await navigate(context, ROUTES.licenses);
    await discover(context.session.page, LICENSE_CONTROLS.table, { allowFirstOfMany: true });

    const agents = await step(context, 'read-agents', () => listAgents(context));
    const inUse = agents.filter((agent) => agent.licenseInUse || agent.loggedIn);

    const lines = inUse.slice(0, 25).map((agent) => `- ${describeAgent(agent)}`);
    const summary =
      inUse.length === 0
        ? 'No agents are currently holding a license.'
        : [`${inUse.length} agent(s) are holding a license:`, ...lines].join('\n');

    return { verified: true, summary, count: inUse.length };
  },
};

async function fillIfPresent(
  context: WorkflowContext,
  label: RegExp,
  value: string,
): Promise<void> {
  const field = context.session.page.getByLabel(label);
  const count = await field.count().catch(() => 0);
  if (count === 1) await field.fill(value);
}

/** Deterministic username suggestion when the request does not supply one. */
export function suggestUsername(fullName: string): string {
  const parts = sanitizePageValue(fullName)
    .toLowerCase()
    .replace(/[^a-z\s-]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'agent';
  if (parts.length === 1) return parts[0].slice(0, 20);
  return `${parts[0][0]}${parts[parts.length - 1]}`.slice(0, 20);
}

export const runCreateAccountWorkflow = (context: WorkflowContext, input: CreateAccountInput) =>
  runWorkflow(createAccountWorkflow, context, input);
export const runClearLicenseWorkflow = (context: WorkflowContext, input: AgentActionInput) =>
  runWorkflow(clearLicenseWorkflow, context, input);
export const runResetPasswordWorkflow = (context: WorkflowContext, input: AgentActionInput) =>
  runWorkflow(resetPasswordWorkflow, context, input);
export const runDeactivateAccountWorkflow = (context: WorkflowContext, input: AgentActionInput) =>
  runWorkflow(deactivateAccountWorkflow, context, input);
export const runAgentStatusWorkflow = (context: WorkflowContext, input: AgentActionInput) =>
  runWorkflow(agentStatusWorkflow, context, input);
export const runLicenseUsageWorkflow = (context: WorkflowContext) =>
  runWorkflow(licenseUsageWorkflow, context, {} as Record<string, never>);
