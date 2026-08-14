import type { Page } from 'playwright-core';
import { toReadySupportError } from '../domain/errors.js';
import { moduleLogger } from '../util/logger.js';
import { openSession, type ReadymodeSession } from './browser.js';
import { capture } from './evidence.js';
import { assertConfigured } from './selectors.js';
import { ensureAuthenticated } from './session.js';
import type { Evidence, WorkflowContext, WorkflowResult } from './port.js';

/**
 * The shape every live workflow follows.
 *
 * Putting the sequence here rather than repeating it means each workflow is
 * only the part that is actually specific to it, and none of them can quietly
 * skip a step. The order is deliberate:
 *
 *   1. refuse to start if any selector this workflow needs is unmapped
 *   2. open a browser session against the persistent context
 *   3. make sure we are signed in — reusing the stored session where possible
 *   4. run the workflow's own steps, which end by re-reading Readymode and
 *      confirming the change independently rather than trusting a banner
 *   5. capture evidence
 *   6. close the session, whatever happened
 *
 * Nothing here retries. A workflow that failed halfway may have changed
 * something, and repeating it blind is how one bad click becomes two.
 */

const log = moduleLogger('workflow');

export interface WorkflowScope {
  page: Page;
  session: ReadymodeSession;
  context: WorkflowContext;
  /** True when the workflow must stop before submitting anything. */
  dryRun: boolean;
}

export interface WorkflowOutcome<T> {
  data: T;
  /** True when the workflow re-read Readymode and confirmed the change. */
  verified: boolean;
  notes?: string[];
  /** Label for the screenshot, e.g. `after-clear-license`. */
  evidenceLabel?: string;
}

export interface RunWorkflowInput<T> {
  /** Human name used in errors and alerts, e.g. "clear license". */
  name: string;
  /** Selector ids that must be mapped before this can run. */
  selectorIds: readonly string[];
  /** Route ids that must be mapped before this can run. */
  routeIds?: readonly string[];
  context: WorkflowContext;
  run(scope: WorkflowScope): Promise<WorkflowOutcome<T>>;
}

export async function runWorkflow<T>(input: RunWorkflowInput<T>): Promise<WorkflowResult<T>> {
  // 1. Refuse rather than guess.
  assertConfigured({
    workflow: input.name,
    selectorIds: input.selectorIds,
    ...(input.routeIds ? { routeIds: input.routeIds } : {}),
  });

  const started = Date.now();
  const session = await openSession({ requestId: input.context.requestId });
  let failed = false;

  try {
    // 3. Reuse the stored session, or sign in, or stop and ask for a human.
    await ensureAuthenticated(session);

    // 4. The workflow itself.
    const outcome = await input.run({
      page: session.page,
      session,
      context: input.context,
      dryRun: input.context.dryRun,
    });

    // 5. Evidence. Never fails the job.
    const evidence: Evidence = { finalUrl: session.page.url() };
    const screenshotPath = await capture({
      page: session.page,
      requestId: input.context.requestId,
      reference: input.context.reference,
      label: outcome.evidenceLabel ?? input.name,
    });
    if (screenshotPath) evidence.screenshotPath = screenshotPath;

    log.info(
      {
        workflow: input.name,
        requestId: input.context.requestId,
        ms: Date.now() - started,
        verified: outcome.verified,
        dryRun: input.context.dryRun,
      },
      'Workflow finished',
    );

    return {
      data: outcome.data,
      verified: outcome.verified,
      dryRun: input.context.dryRun,
      evidence,
      ...(outcome.notes?.length ? { notes: outcome.notes } : {}),
    };
  } catch (cause) {
    failed = true;
    const error = toReadySupportError(cause);

    // Photograph the failure too. Seeing what the page actually looked like is
    // usually the difference between "the interface changed" and a guess.
    await capture({
      page: session.page,
      requestId: input.context.requestId,
      reference: input.context.reference,
      label: `failed-${input.name}`,
    }).catch(() => undefined);

    log.warn(
      { workflow: input.name, requestId: input.context.requestId, category: error.category },
      'Workflow stopped',
    );

    throw error;
  } finally {
    await session.close(failed ? 'FAILED' : 'CLOSED');
  }
}
