import type { Page } from 'playwright-core';
import { logger } from '../../security/logger';
import { recordEvent } from '../../audit';
import { WorkflowResult } from '../../types';
import {
  AppError,
  AuthenticationRequiredError,
  WorkflowNeedsConfigurationError,
} from '../../security/errors';
import { PANELS, PanelId, openPanel } from '../navigation';
import { anyPresent } from '../selectors/discovery';
import { HUMAN_VERIFICATION_CONDITIONS } from '../selectors';
import { captureScreenshot, ReadymodeSession } from '../session';

/**
 * Shared shape for every Readymode workflow.
 *
 * A workflow always: verifies where it is, navigates deliberately, finds one
 * unique target, reads the current state, performs only the approved change,
 * waits for the expected result, verifies that result independently, captures
 * evidence, and records an audit event. The reply to Discord is produced by the
 * caller from the returned result.
 */

export interface WorkflowContext {
  organizationId: string;
  requestId: string;
  reference: string;
  session: ReadymodeSession;
  /** When true the workflow reads and reports but never saves. */
  dryRun: boolean;
  actorDiscordUserId?: string | null;
}

export interface WorkflowDefinition<TInput, TOutput extends Record<string, unknown>> {
  name: string;
  /** Human sentence describing the change, used in audit records. */
  describe(input: TInput): string;
  run(context: WorkflowContext, input: TInput): Promise<TOutput & { verified: boolean; summary: string }>;
}

export async function step<T>(
  context: WorkflowContext,
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    logger.debug(
      { requestId: context.requestId, step: label, ms: Date.now() - started },
      'Workflow step complete',
    );
    return result;
  } catch (error) {
    logger.warn({ requestId: context.requestId, step: label, err: error }, 'Workflow step failed');
    throw error;
  }
}

/** Step 1 of every workflow: confirm the session is where it should be. */
export async function verifyCurrentPage(context: WorkflowContext): Promise<void> {
  const { page } = context.session;
  if (page.isClosed()) {
    throw new AppError('browser_closed', 'The browser session closed before the work started.', 503);
  }
  await assertNoHumanVerification(page);
}

/** CAPTCHA and multi-factor prompts stop the workflow. They are never solved. */
export async function assertNoHumanVerification(page: Page): Promise<void> {
  if (await anyPresent(page, HUMAN_VERIFICATION_CONDITIONS, 700)) {
    throw new AuthenticationRequiredError();
  }
}

/**
 * Opens an administrative panel and confirms it by its heading.
 *
 * This replaces navigating to a URL. Readymode Starter is a single-page
 * application: there is no `/admin/users` to go to, and the address stays at
 * `/#` whichever screen is open, so a URL can neither reach a screen nor prove
 * one arrived.
 */
export async function openWorkflowPanel(context: WorkflowContext, panel: PanelId): Promise<string> {
  const { page } = context.session;
  const result = await openPanel(page, panel);

  if (!result.opened) {
    throw new WorkflowNeedsConfigurationError(
      `"${PANELS[panel].label}" panel (${result.reason ?? 'it did not open'})`,
    );
  }

  await assertNoHumanVerification(page);
  return result.heading ?? PANELS[panel].headings[0];
}

/** Runs a workflow with evidence capture and audit logging around it. */
export async function runWorkflow<TInput, TOutput extends Record<string, unknown>>(
  definition: WorkflowDefinition<TInput, TOutput>,
  context: WorkflowContext,
  input: TInput,
): Promise<WorkflowResult> {
  await verifyCurrentPage(context);

  const description = definition.describe(input);
  let screenshotPath: string | null = null;

  try {
    const output = await definition.run(context, input);

    screenshotPath = await captureScreenshot(
      context.session.page,
      `${context.reference}-${definition.name}`,
    );

    await recordEvent({
      organizationId: context.organizationId,
      requestId: context.requestId,
      type: 'request.completed',
      message: `${context.reference}: ${description}`,
      data: {
        ...output,
        workflow: definition.name,
        dryRun: context.dryRun,
        verified: output.verified,
        screenshotPath,
      },
    });

    const { verified, summary, ...details } = output;
    return {
      ok: true,
      verified,
      summary,
      details: details as Record<string, unknown>,
      screenshotPath,
      dryRun: context.dryRun,
    };
  } catch (error) {
    screenshotPath = await captureScreenshot(
      context.session.page,
      `${context.reference}-${definition.name}-failed`,
    ).catch(() => null);

    await recordEvent({
      organizationId: context.organizationId,
      requestId: context.requestId,
      type:
        error instanceof AuthenticationRequiredError
          ? 'request.authentication_required'
          : 'request.failed',
      message: `${context.reference}: ${description} did not complete.`,
      data: {
        workflow: definition.name,
        screenshotPath,
        error: error instanceof Error ? error.message : String(error),
      },
    });

    throw error;
  }
}

/**
 * Waits for an expected condition and reports plainly when it does not appear,
 * rather than assuming the action worked.
 */
export async function waitForResult(
  page: Page,
  check: () => Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; what: string },
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 400;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await check()) return true;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}
