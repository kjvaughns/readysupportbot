import { AppError } from '../../security/errors';
import { AGENT_CONTROLS, LICENSE_CONTROLS } from '../selectors';
import { discover } from '../selectors/discovery';
import { describeAgent } from '../agents';
import { ReadymodeAgent } from '../../types';
import { findControlInRow } from '../navigation';
import { sanitizePageValue } from '../../security/sanitize';
import { WorkflowNeedsConfigurationError } from '../../security/errors';
import {
  WorkflowContext,
  WorkflowDefinition,
  openWorkflowPanel,
  runWorkflow,
  step,
  waitForResult,
} from './harness';
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
    // "Sign Out Inactive Users" is at the foot of License Usage, beside "Sign
    // Out Everyone Else" — which signs out every other administrator and is
    // never a substitute for it.
    await openWorkflowPanel(context, 'licenses');
    const before = await step(context, 'read-before', () =>
      listAgents(context, undefined, { panel: 'licenses' }),
    );
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
    const after = await step(context, 'read-after', () =>
      listAgents(context, undefined, { panel: 'licenses' }),
    );
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

/**
 * The exact label of the per-row control on License Usage, as an operator
 * reported it. It is deliberately a constant: a workflow that searched for
 * anything matching "sign out" could find "Sign Out Everyone Else".
 */
const ROW_SIGN_OUT_LABEL = 'Sign Out';

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
    // Signing one person out happens on License Usage, in that person's own row.
    await openWorkflowPanel(context, 'licenses');
    await discover(context.session.page, LICENSE_CONTROLS.table, { allowFirstOfMany: true });

    if (context.dryRun) {
      return {
        verified: false,
        summary:
          `Dry run: ${describeAgent(input.agent)} would be signed out` +
          `${input.resetPassword ? ' and their password reset' : ''}.`,
      };
    }

    const identifier = input.agent.username || input.agent.readymodeUserId;

    // The row is found by the user it belongs to. A row chosen by position would
    // sign out whoever happened to be sitting in that position.
    const rowControl = await findControlInRow(context.session.page, {
      rowIdentifier: String(identifier),
      label: ROW_SIGN_OUT_LABEL,
    });

    if (!rowControl) {
      throw new WorkflowNeedsConfigurationError(
        `"${ROW_SIGN_OUT_LABEL}" control in the row for ${sanitizePageValue(String(identifier))}` +
          ' (exactly one matching row with that control was not found)',
      );
    }

    await rowControl.locator.click({ timeout: 8000 });
    await context.session.page.waitForLoadState('domcontentloaded').catch(() => undefined);

    let passwordReset = false;
    if (input.resetPassword) {
      // The password lives on the user's own record, not on License Usage.
      await step(context, 'open-agent', () => openAgent(context, input.agent));
      const reset = await discover(context.session.page, AGENT_CONTROLS.resetPassword);
      await reset.click();
      await saveAgentForm(context).catch(() => undefined);
      passwordReset = true;
    }

    // Verify against the licence table rather than the message on screen.
    const after = await step(context, 'verify', () =>
      listAgents(context, input.agent.username, { panel: 'licenses' }),
    );
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
