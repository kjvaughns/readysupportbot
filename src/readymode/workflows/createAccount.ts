import type { Page } from 'playwright-core';
import type { CreateAccountAction } from '../../domain/actions.js';
import { errorFor } from '../../domain/errors.js';
import { generateTemporaryPassword } from '../../util/password.js';
import { normalizeForComparison } from '../../util/text.js';
import { goToRoute, isVisible, isVisibleIfConfigured, locate } from '../browser.js';
import { openAgentAtIndex, readAgentDetail, searchAgents } from '../agents.js';
import { getRoute, getSelector, UNKNOWN } from '../selectors.js';
import { requirePage } from '../session.js';
import { runWorkflow } from '../workflowRunner.js';
import type { CreatedAccount, WorkflowContext, WorkflowResult } from '../port.js';

/**
 * Creating an agent account.
 *
 * The sequence that matters: check for collisions *before* filling anything
 * in, fill the form, submit, then go back to the agent list and confirm the
 * account is really there. The last step is the one that makes this
 * trustworthy — a success banner is Readymode telling us it worked, and a
 * fresh search is us checking.
 *
 * The password never leaves this process except through an ephemeral Discord
 * reply. It is typed into the form, held in the returned object, and dropped
 * once delivered.
 */

export const CREATE_ACCOUNT_SELECTORS = [
  'page.agents.marker',
  'agents.search.input',
  'agents.results.row',
  'page.agentCreate.marker',
  'create.firstName.input',
  'create.lastName.input',
  'create.email.input',
  'create.username.input',
  'create.password.input',
  'create.role.select',
  'create.licenseType.select',
  'create.submit.button',
] as const;

export const CREATE_ACCOUNT_ROUTES = ['route.agents', 'route.agentCreate'] as const;

/**
 * Refuse if the email or username is already taken.
 *
 * Done as two separate searches rather than one, because Readymode's search
 * may match on either field and a combined query could return a row that
 * matches neither exactly.
 */
async function assertNotTaken(page: Page, action: CreateAccountAction): Promise<void> {
  const byEmail = await searchAgents(page, action.email);
  const emailClash = byEmail.some(
    (account) => account.email && normalizeForComparison(account.email) === normalizeForComparison(action.email),
  );

  if (emailClash) {
    throw errorFor('PRECONDITION_FAILED', {
      message: `An account already uses the email ${action.email}, so I did not create a second one.`,
      details: { field: 'email' },
    });
  }

  const byUsername = await searchAgents(page, action.username);
  const usernameClash = byUsername.some(
    (account) =>
      account.username && normalizeForComparison(account.username) === normalizeForComparison(action.username),
  );

  if (usernameClash) {
    throw errorFor('PRECONDITION_FAILED', {
      message: `The username ${action.username} is already taken, so I did not create the account.`,
      details: { field: 'username' },
    });
  }
}

/**
 * Set a dropdown by its visible option text.
 *
 * Falls back to filling, because some of these are comboboxes rather than
 * <select> elements and the registry cannot tell which without discovery.
 */
async function choose(page: Page, selectorId: string, value: string, fieldName: string): Promise<void> {
  if (getSelector(selectorId).value === UNKNOWN) {
    throw errorFor('SELECTOR_NOT_CONFIGURED', {
      message: `The ${fieldName} field on the Readymode form has not been mapped yet.`,
      details: { selector: selectorId, field: fieldName },
    });
  }

  const control = locate(page, selectorId).first();

  try {
    await control.selectOption({ label: value });
    return;
  } catch {
    // Not a <select>. Try it as a text control.
  }

  try {
    await control.fill(value);
  } catch (cause) {
    throw errorFor('INTERFACE_CHANGED', {
      message: `I could not set the ${fieldName} to "${value}" on the Readymode form, so I stopped without creating the account.`,
      cause,
      details: { selector: selectorId, field: fieldName },
    });
  }
}

export async function createAccount(
  action: CreateAccountAction,
  context: WorkflowContext,
): Promise<WorkflowResult<CreatedAccount>> {
  return runWorkflow<CreatedAccount>({
    name: 'create account',
    selectorIds: CREATE_ACCOUNT_SELECTORS,
    routeIds: CREATE_ACCOUNT_ROUTES,
    context,

    async run({ page, dryRun }) {
      const temporaryPassword = action.temporaryPassword ?? generateTemporaryPassword();
      const passwordSource: CreatedAccount['passwordSource'] = action.temporaryPassword
        ? 'provided'
        : 'generated';

      await assertNotTaken(page, action);

      await goToRoute(page, getRoute('route.agentCreate').path);
      await requirePage(page, 'page.agentCreate.marker', 'the new agent form');

      await locate(page, 'create.firstName.input').first().fill(action.firstName);
      await locate(page, 'create.lastName.input').first().fill(action.lastName);
      await locate(page, 'create.email.input').first().fill(action.email);
      await locate(page, 'create.username.input').first().fill(action.username);
      await locate(page, 'create.password.input').first().fill(temporaryPassword);

      if (getSelector('create.passwordConfirm.input').value !== UNKNOWN) {
        await locate(page, 'create.passwordConfirm.input').first().fill(temporaryPassword);
      }

      await choose(page, 'create.role.select', action.agentRole, 'agent role');
      await choose(page, 'create.licenseType.select', action.licenseType, 'license type');

      await fillOptionalChoice(page, 'create.team.select', action.team, 'team');
      await fillOptionalChoice(page, 'create.campaign.select', action.campaign, 'campaign');
      await fillOptionalChoice(page, 'create.queue.select', action.queue, 'queue');

      if (action.active === false && getSelector('create.active.toggle').value !== UNKNOWN) {
        await locate(page, 'create.active.toggle').first().uncheck().catch(() => undefined);
      }

      const account = {
        username: action.username,
        email: action.email,
        fullName: `${action.firstName} ${action.lastName}`,
        agentRole: action.agentRole,
        licenseType: action.licenseType,
        ...(action.team ? { team: action.team } : {}),
        ...(action.campaign ? { campaign: action.campaign } : {}),
        ...(action.queue ? { queue: action.queue } : {}),
        active: action.active ?? true,
        licenseInUse: false,
      };

      if (dryRun) {
        // Everything is filled in and valid. Stop here without submitting.
        return {
          data: { account, temporaryPassword, passwordSource },
          verified: false,
          notes: [
            'Test mode: the form was filled in and checked, but nothing was submitted, so no account exists.',
          ],
          evidenceLabel: 'create-account-dry-run',
        };
      }

      await locate(page, 'create.submit.button').first().click();
      // Bounded: the success marker and the follow-up search are the real
      // checks, so a page that never goes fully quiet must not stall the job.
      await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);

      // Readymode rejecting the form is a clean stop, not a failure to
      // investigate. Whatever it said is not repeated verbatim — a validation
      // banner is untrusted text.
      if (await isVisibleIfConfigured(page, 'create.validationError.marker', 2_000)) {
        throw errorFor('PRECONDITION_FAILED', {
          message:
            'Readymode rejected the new account details. Check the username, email and role against what it expects.',
        });
      }

      if (getSelector('create.success.marker').value !== UNKNOWN) {
        const confirmed = await isVisible(page, 'create.success.marker', 10_000);
        if (!confirmed) {
          throw errorFor('VERIFICATION_FAILED', {
            message:
              'I submitted the new account but Readymode did not confirm it. Check whether it was created before trying again.',
          });
        }
      }

      // Independent verification: go back to the list and look for it.
      const found = await searchAgents(page, action.username);
      const match = found.find(
        (candidate) =>
          candidate.username && normalizeForComparison(candidate.username) === normalizeForComparison(action.username),
      );

      if (!match) {
        throw errorFor('VERIFICATION_FAILED', {
          message:
            'I submitted the new account but could not find it in the agent list afterwards. ' +
            'Check Readymode before trying again.',
        });
      }

      // Read the created account back so the audit record holds what Readymode
      // actually stored rather than what we asked for.
      const index = found.indexOf(match);
      await openAgentAtIndex(page, index < 0 ? 0 : index);
      await requirePage(page, 'page.agentDetail.marker', "the new agent's page");
      const stored = await readAgentDetail(page);

      return {
        data: {
          account: { ...account, ...stored },
          temporaryPassword,
          passwordSource,
        },
        verified: true,
        evidenceLabel: 'create-account',
      };
    },
  });
}

/** An optional dropdown: skip when not supplied, fail when unmapped. */
async function fillOptionalChoice(
  page: Page,
  selectorId: string,
  value: string | undefined,
  fieldName: string,
): Promise<void> {
  if (value === undefined) return;
  await choose(page, selectorId, value, fieldName);
}
