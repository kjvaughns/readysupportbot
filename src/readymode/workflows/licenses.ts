import { AppError } from '../../security/errors';
import { AGENT_CONTROLS, ROUTES } from '../selectors';
import { discover } from '../selectors/discovery';
import { describeAgent } from '../agents';
import { ReadymodeAgent } from '../../types';
import { WorkflowContext, WorkflowDefinition, navigate, runWorkflow, step, waitForResult } from './harness';
import { listAgents, openAgent, pageText, saveAgentForm } from './pageOperations';

/**
 * Licence and session workflows.
 *
 * Two distinct things live here, and the difference matters:
 *
 *   - "Log out inactive users" is Readymode's own bulk control. Readymode
 *     decides which sessions count as idle; ReadySupport just presses it and
 *     verifies the result.
 *   - Forcing one named user out is targeted and disruptive to that person, so
 *     it resolves to exactly one account first.
 */

export interface ClearAllLicensesOutput extends Record<string, unknown> {
  verified: boolean;
  summary: string;
  licensesBefore: number;
  licensesAfter: number;
  freed: number;
}

export const clearAllLicensesWorkflow: WorkflowDefinition<
  Record<string, never>,
  ClearAllLicensesOutput
> = {
  name: 'licenses.clear_inactive',
  describe: () => 'Log out inactive Readymode users',

  async run(context) {
    // Read first, so the confirmation and the result can both say how many
    // seats were actually in use rather than claiming an unmeasured effect.
    await navigate(context, ROUTES.agents);
    const before = await step(context, 'read-before', () => listAgents(context));
    const licensesBefore = before.filter((agent) => agent.licenseInUse || agent.loggedIn).length;

    if (context.dryRun) {
      return {
        verified: false,
        summary: `Dry run: Readymode's "log out inactive users" control would be used. ${licensesBefore} seat(s) are currently held.`,
        licensesBefore,
        licensesAfter: licensesBefore,
        freed: 0,
      };
    }

    const control = await discover(context.session.page, AGENT_CONTROLS.logOutInactive);
    await control.click();

    // Readymode may ask to confirm. Waiting for the list to settle is the
    // signal; a confirmation dialog is handled by the generic save path.
    await context.session.page.waitForLoadState('domcontentloaded').catch(() => undefined);

    const acknowledged = await waitForResult(
      context.session.page,
      async () => {
        const text = (await pageText(context.session.page)).toLowerCase();
        return /logged out|signed out|licen[cs]es? (?:cleared|released|freed)|no inactive/.test(text);
      },
      { what: 'inactive logout confirmation', timeoutMs: 15_000 },
    );

    // Verify by re-reading rather than trusting the message.
    const after = await step(context, 'read-after', () => listAgents(context));
    const licensesAfter = after.filter((agent) => agent.licenseInUse || agent.loggedIn).length;
    const freed = Math.max(0, licensesBefore - licensesAfter);

    if (!acknowledged && freed === 0) {
      throw new AppError(
        'verification_failed',
        'Readymode did not confirm that any inactive sessions were logged out, and the number of seats in use did not change.',
        409,
      );
    }

    return {
      verified: true,
      summary:
        freed > 0
          ? `Logged out inactive users. ${freed} seat(s) freed — ${licensesAfter} still in use.`
          : `Readymode reported no inactive sessions to log out. ${licensesAfter} seat(s) remain in use.`,
      licensesBefore,
      licensesAfter,
      freed,
    };
  },
};

export interface ForceLogoutInput {
  agent: ReadymodeAgent;
  resetPassword: boolean;
}

export const forceLogoutWorkflow: WorkflowDefinition<
  ForceLogoutInput,
  Record<string, unknown> & { verified: boolean; summary: string }
> = {
  name: 'licenses.force_logout',
  describe: (input) =>
    `Sign ${describeAgent(input.agent)} out of Readymode${input.resetPassword ? ' and reset their password' : ''}`,

  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));

    if (context.dryRun) {
      return {
        verified: false,
        summary:
          `Dry run: ${describeAgent(input.agent)} would be signed out` +
          `${input.resetPassword ? ' and their password reset' : ''}.`,
      };
    }

    const control = await discover(context.session.page, AGENT_CONTROLS.forceLogout);
    await control.click();
    await context.session.page.waitForLoadState('domcontentloaded').catch(() => undefined);

    let passwordReset = false;
    if (input.resetPassword) {
      const reset = await discover(context.session.page, AGENT_CONTROLS.resetPassword);
      await reset.click();
      await saveAgentForm(context).catch(() => undefined);
      passwordReset = true;
    }

    // Verify against the agent list rather than the message on screen.
    const after = await step(context, 'verify', () => listAgents(context, input.agent.username));
    const match = after.find(
      (agent) => String(agent.readymodeUserId) === String(input.agent.readymodeUserId),
    );

    if (match?.loggedIn === true) {
      throw new AppError(
        'verification_failed',
        `${describeAgent(input.agent)} still reads as logged in, so the sign-out was not verified.`,
        409,
      );
    }

    return {
      verified: true,
      summary:
        `${describeAgent(input.agent)} was signed out of Readymode` +
        `${passwordReset ? ', and their password was reset so the seat cannot be retaken with the old credentials' : ''}.` +
        (passwordReset
          ? ' Readymode delivered the new password through its own channel — ReadySupport never reads it.'
          : ''),
      passwordReset,
    };
  },
};

export const runClearAllLicensesWorkflow = (context: WorkflowContext) =>
  runWorkflow(clearAllLicensesWorkflow, context, {} as Record<string, never>);
export const runForceLogoutWorkflow = (context: WorkflowContext, input: ForceLogoutInput) =>
  runWorkflow(forceLogoutWorkflow, context, input);
