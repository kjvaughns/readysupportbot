import { ALL_CONTROLS, LOGIN_CONTROLS } from '../selectors';
import { ProposedSelector, promotable } from './propose';
import { WorkflowProbeResult } from './stages';

/**
 * Whether a discovery profile is fit to be reviewed, and then acted on.
 *
 * A run reported success having resolved `login.username` and `login.submit`
 * and nothing else. Both of those are true statements about a login form and
 * neither says anything about the administrative interface, but the profile was
 * offered for approval as though it did. Approving it would have marked the
 * interface verified on the strength of a sign-in.
 *
 * So readiness is computed from what was actually resolved, and a profile that
 * never got past the login page cannot reach `ready_for_review` at all.
 */

export type ProfileReadiness = 'incomplete' | 'ready_for_review' | 'approved' | 'rejected';

/**
 * Controls a profile must resolve before it is worth a person's time.
 *
 * Navigation and reading only. Nothing here modifies Readymode, and a profile
 * that resolves all of them has demonstrably reached the administrative
 * interface rather than stopping at the door.
 */
export const REQUIRED_NAVIGATION_CONTROLS = [
  'agents.search',
  'agents.rows',
  'licenses.table',
];

export interface ReadinessAssessment {
  readiness: ProfileReadiness;
  /** Required controls that resolved. */
  satisfied: string[];
  /** Required controls that did not. */
  missing: string[];
  /** True when the only things resolved were login controls. */
  loginOnly: boolean;
  /** Workflows that cannot run, each of which needs a stated reason. */
  unsupportedWorkflows: Array<{ key: string; reason: string }>;
  /** Workflows that are unsupported and do not say why. */
  undocumentedWorkflows: string[];
  /** One sentence, safe to show. */
  summary: string;
}

const LOGIN_CONTROL_NAMES = new Set(Object.values(LOGIN_CONTROLS).map((control) => control.name));

export function assessReadiness(input: {
  proposals: ProposedSelector[];
  workflows: WorkflowProbeResult[];
  /** True when the authenticated interface was positively confirmed. */
  dashboardConfirmed: boolean;
  /** Screens actually inspected after signing in. */
  screensInspected: number;
  /**
   * Which run this was. The reduced run deliberately inspects nothing but the
   * navigation structure, so calling its profile "incomplete" without saying
   * why reads as a failure when it is the intended result.
   */
  mode?: 'reduced' | 'full';
}): ReadinessAssessment {
  const usable = new Set(
    input.proposals.filter(promotable).map((proposal) => proposal.control),
  );

  const beyondLogin = [...usable].filter((control) => !LOGIN_CONTROL_NAMES.has(control));
  const loginOnly = usable.size > 0 && beyondLogin.length === 0;

  const satisfied = REQUIRED_NAVIGATION_CONTROLS.filter((control) => usable.has(control));
  const missing = REQUIRED_NAVIGATION_CONTROLS.filter((control) => !usable.has(control));

  const unsupported = input.workflows.filter((workflow) => workflow.status !== 'discovered');
  const unsupportedWorkflows = unsupported
    .filter((workflow) => workflow.reason)
    .map((workflow) => ({ key: workflow.key, reason: workflow.reason as string }));
  const undocumentedWorkflows = unsupported
    .filter((workflow) => !workflow.reason)
    .map((workflow) => workflow.key);

  // The dashboard first. Everything else in a run is meaningless without it,
  // because a run that never signed in captures the login page over and over.
  if (!input.dashboardConfirmed || input.screensInspected === 0 || loginOnly) {
    return {
      readiness: 'incomplete',
      satisfied,
      missing,
      loginOnly,
      unsupportedWorkflows,
      undocumentedWorkflows,
      summary: !input.dashboardConfirmed
        ? 'The authenticated interface was never confirmed, so this run says nothing about it.'
        : loginOnly
          ? 'Only login controls were resolved. Signing in proves the credentials work and nothing else.'
          : 'No administrative screen was inspected after signing in.',
    };
  }

  if (input.mode === 'reduced') {
    return {
      readiness: 'incomplete',
      satisfied,
      missing,
      loginOnly,
      unsupportedWorkflows,
      undocumentedWorkflows,
      summary:
        'This was the reduced run: it confirmed the authenticated interface and read the ' +
        'navigation structure, and deliberately crawled nothing. It is not meant to be ' +
        'approvable — run discovery in full mode once this one is fast.',
    };
  }

  if (missing.length > 0) {
    return {
      readiness: 'incomplete',
      satisfied,
      missing,
      loginOnly,
      unsupportedWorkflows,
      undocumentedWorkflows,
      summary: `${missing.length} required navigation control(s) are still unresolved: ${missing.join(', ')}.`,
    };
  }

  if (undocumentedWorkflows.length > 0) {
    return {
      readiness: 'incomplete',
      satisfied,
      missing,
      loginOnly,
      unsupportedWorkflows,
      undocumentedWorkflows,
      summary:
        `${undocumentedWorkflows.length} workflow(s) could not be walked and do not say why: ` +
        `${undocumentedWorkflows.join(', ')}. An unexplained gap is not a reviewable one.`,
    };
  }

  return {
    readiness: 'ready_for_review',
    satisfied,
    missing,
    loginOnly,
    unsupportedWorkflows,
    undocumentedWorkflows,
    summary:
      `Every required navigation control resolved, and ${unsupportedWorkflows.length} unsupported ` +
      'workflow(s) each state a reason. Ready for an Owner to review.',
  };
}

/** Controls with no evidence matcher at all, which can never resolve. */
export function controlsWithoutMatchers(matcherControls: Set<string>): string[] {
  return ALL_CONTROLS.filter((control) => !matcherControls.has(control.name)).map(
    (control) => control.name,
  );
}
