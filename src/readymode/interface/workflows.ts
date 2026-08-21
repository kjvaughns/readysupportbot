import { EvidenceStatus, InterfaceVersion, SafetyClass, isAutomatable } from './types';
import { INTERFACE_CONTROLS, interfaceControl } from './registry';

/**
 * What ReadySupport can be asked to do, and how far each one has actually got.
 *
 * The status is the honest part. `documented` means the Help Center describes
 * it. `discovered` means the controls it needs were seen on a real screen.
 * `implemented` means the code exists — which says nothing about the interface.
 * `dry_run_tested` means it was run against the real account without saving,
 * and `live_tested` means it was run for real and verified. Nothing here claims
 * a status that its controls cannot support, and `assertStatusesAreSupported`
 * is the test that keeps it that way.
 *
 * Statuses move by somebody running the workflow and recording what happened.
 * They never move because the code was written.
 */

export interface WorkflowSpec {
  key: string;
  /** What a person would ask for, in their words. */
  intent: string;
  status: EvidenceStatus;
  interfaceVersion: InterfaceVersion;
  safety: SafetyClass;
  /** Interface control keys this workflow drives, in order. */
  controls: string[];
  /** What must be true before it may run. */
  preconditions: string[];
  /** What is checked afterwards, before it reports success. */
  postconditions: string[];
  /** Official Help Center articles. Populated by knowledge sync, never guessed. */
  officialSourceUrls: string[];
  notes?: string;
}

export const WORKFLOWS: WorkflowSpec[] = [
  {
    key: 'continue_existing_session',
    intent: 'Continue past the notice that an administrator is already signed in',
    // The notice did not appear during the inspection, so nobody has seen the
    // button on this account.
    status: 'documented',
    interfaceVersion: 'starter',
    safety: 'terminates_session',
    controls: ['login.multiple_session_continue'],
    preconditions: [
      'The interstitial classifier identified a genuine administrator session takeover.',
      'No human verification is on screen.',
      'Continue has not already been pressed in this session.',
    ],
    postconditions: ['The Dashboard or License Usage is on screen.'],
    officialSourceUrls: [],
    notes:
      'Pressing Continue signs the other administrator out. Authorized by the account owner, pressed at most once per session, and only when the page is unambiguously a takeover notice — a page carrying both a captcha and a Continue button is never one.',
  },
  {
    key: 'view_license_usage',
    intent: 'Show who is holding a licence right now',
    // The screen is discovered — route and heading both — but the table on it
    // is not: the inspection recorded its column headings and no selector, so
    // the selector here is derived from those headings rather than observed.
    // The workflow is only as evidenced as the control it depends on.
    status: 'documented',
    interfaceVersion: 'starter',
    safety: 'read_only',
    controls: ['licenses.users_table'],
    preconditions: ['The session is signed in as an administrator.'],
    postconditions: ['License Usage is on screen and its table was read.'],
    officialSourceUrls: [],
    notes:
      'Column headings and counts only; row contents are never captured or returned. Reading the table has not been confirmed live, so this reports as documented even though the screen itself is discovered.',
  },
  {
    key: 'sign_out_user',
    intent: 'Sign one named user out so their licence is released',
    status: 'discovered',
    interfaceVersion: 'starter',
    safety: 'terminates_session',
    controls: ['licenses.sign_out_user'],
    preconditions: [
      'License Usage is open.',
      'Exactly one row matches the named user.',
      'An administrator approved signing that person out.',
      'An Owner has approved the selector profile.',
    ],
    postconditions: [
      'That row reads as signed out.',
      'The remaining licence count has increased.',
    ],
    officialSourceUrls: [],
    notes: 'The row is chosen by matching the user, never by its position in the table.',
  },
  {
    key: 'sign_out_inactive_users',
    intent: 'Release the licences held by idle sessions',
    // The control was named by an operator and by the Help Center. It has not
    // been seen.
    status: 'documented',
    interfaceVersion: 'starter',
    safety: 'terminates_session',
    controls: ['licenses.sign_out_inactive'],
    preconditions: [
      'License Usage is open.',
      'An administrator approved releasing idle sessions.',
    ],
    postconditions: ['Fewer licences are in use, or Readymode reported that none were idle.'],
    officialSourceUrls: [],
    notes:
      '"Sign Out All Users" and "Sign Out Everyone Else" sit beside it and would sign out people who are working. Only the exact label is acceptable.',
  },
  {
    key: 'create_user',
    intent: 'Create a Readymode account for somebody',
    status: 'blocked',
    interfaceVersion: 'starter',
    safety: 'modifies_data',
    controls: ['users.create'],
    preconditions: ['User Management is open and the destination folder is chosen.'],
    postconditions: ['The new account appears in the folder it was created in.'],
    officialSourceUrls: [],
    notes:
      'The creation tool opens from an unlabelled plus icon that the inspection could not resolve: the legacy toolbar rendered at zero size. The password is set by a person — ReadySupport never handles one.',
  },
  {
    key: 'assign_folder_and_role',
    intent: 'Put a user in the right folder with the right role',
    status: 'blocked',
    interfaceVersion: 'starter',
    safety: 'modifies_data',
    controls: ['users.view_by_folder', 'users.view_by_role'],
    preconditions: ['The user record is open.'],
    postconditions: ['The record reads back the folder and role that were set.'],
    officialSourceUrls: [],
    notes:
      'Viewing by folder and by role is resolved; the controls that change them are on the user profile editor, which is unresolved.',
  },
  {
    key: 'manage_user_permissions',
    intent: "Change what a user is allowed to do",
    status: 'blocked',
    interfaceVersion: 'starter',
    safety: 'modifies_data',
    controls: [],
    preconditions: ['The user record is open.'],
    postconditions: ['The record reads back the permissions that were set.'],
    officialSourceUrls: [],
    notes:
      'Documented in the Help Center. The profile editor was not resolved live, so no permission control can be identified yet.',
  },
  {
    key: 'open_lead_management',
    intent: 'Open Lead Management',
    status: 'discovered',
    interfaceVersion: 'starter',
    safety: 'navigation',
    controls: ['leads.queues_tab'],
    preconditions: ['The session is signed in as an administrator.'],
    postconditions: ['The Lead Management heading is on screen.'],
    officialSourceUrls: [],
  },
  {
    key: 'open_queue',
    intent: 'Open one queue',
    status: 'discovered',
    interfaceVersion: 'starter',
    safety: 'navigation',
    controls: ['leads.queues_tab'],
    preconditions: ['Lead Management is open on the Queues tab.'],
    postconditions: ['The Edit Queue heading is on screen.'],
    officialSourceUrls: [],
  },
  {
    key: 'view_queue_members',
    intent: 'Show who is in a queue',
    status: 'blocked',
    interfaceVersion: 'starter',
    safety: 'read_only',
    controls: ['queue.members_tab'],
    preconditions: ['A queue is open.'],
    postconditions: ['The Members panel is on screen.'],
    officialSourceUrls: [],
    notes:
      'The Members tab id changes with the queue type — #ui-id-1 for one kind and #ui-id-2 for another — so it is reached by its exact label instead, and that has not been confirmed live.',
  },
  {
    key: 'configure_queue',
    intent: 'Change a queue setting',
    status: 'discovered',
    interfaceVersion: 'starter',
    safety: 'modifies_data',
    controls: [
      'queue.configuration_tab',
      'queue.queue_type',
      'queue.strategy',
      'queue.dialer_configuration',
      'queue.machine_detection',
      'queue.custom_call_times',
    ],
    preconditions: [
      'A queue is open on its Configuration tab.',
      'An administrator approved the specific change.',
      'An Owner has approved the selector profile.',
    ],
    postconditions: ['Each changed field reads back its new value.'],
    officialSourceUrls: [],
    notes:
      'Queue call times decide when this queue dials. They are not the iQ State Calling Restrictions, which enforce legal calling windows.',
  },
  {
    key: 'open_campaigns',
    intent: 'Open campaigns',
    status: 'discovered',
    interfaceVersion: 'starter',
    safety: 'navigation',
    controls: ['leads.campaigns_tab'],
    preconditions: ['Lead Management is open.'],
    postconditions: ['The Campaigns tab panel is on screen.'],
    officialSourceUrls: [],
    notes: 'Discovery opens campaigns and never changes a campaign setting.',
  },
  {
    key: 'open_playlists',
    intent: 'Open the playlists inside a queue',
    status: 'blocked',
    interfaceVersion: 'starter',
    safety: 'read_only',
    controls: ['playlists.editor'],
    preconditions: ['A queue is open on its Members tab.'],
    postconditions: ['The Lead Playlist Editor is on screen.'],
    officialSourceUrls: [],
    notes:
      'Reaching the playlist editor means opening lead-related content, which the read-only inspection stopped short of.',
  },
  {
    key: 'filter_playlist_by_location',
    intent: 'Change which states a playlist draws leads from',
    status: 'blocked',
    interfaceVersion: 'starter',
    safety: 'modifies_data',
    controls: ['playlists.location_filter'],
    preconditions: ['The playlist editor is open.'],
    postconditions: ['The playlist filter reads back the states that were set.'],
    officialSourceUrls: [],
    notes:
      'This decides which leads an agent receives. It is NOT the iQ State Calling Restriction, which enforces legal calling windows — substituting one for the other would either break the law or break the agent\'s lead flow.',
  },
  {
    key: 'explain_state_calling_restrictions',
    intent: 'Explain Readymode iQ State Calling Restrictions',
    // An explanation, answered from the Help Center. Nothing is driven.
    status: 'documented',
    interfaceVersion: 'iq',
    safety: 'read_only',
    controls: [],
    preconditions: [],
    postconditions: ['The answer cites the official article.'],
    officialSourceUrls: [
      'https://help.readymode.com/support/solutions/articles/11000121571-state-calling-restrictions',
    ],
    notes:
      'Enforces legal calling windows by state (TCPA). Distinct from playlist location filtering, which decides lead assignment. ReadySupport explains the documented setting and does not advise on compliance.',
  },
  {
    key: 'diagnose_problem',
    intent: 'Work out why login, a licence, a queue, dialing, a permission or routing is not working',
    status: 'documented',
    interfaceVersion: 'unknown',
    safety: 'read_only',
    controls: [],
    preconditions: [],
    postconditions: ['The answer cites the official article it came from, or says there is none.'],
    officialSourceUrls: [],
    notes:
      'Answered from the Help Center plus read-only observation. Where the documentation and the live screen disagree, the answer says which of the three likely causes it is: interface version, account permissions, or outdated documentation.',
  },
];

const BY_KEY = new Map(WORKFLOWS.map((workflow) => [workflow.key, workflow]));

export function workflowSpec(key: string): WorkflowSpec | null {
  return BY_KEY.get(key) ?? null;
}

/** Workflows whose controls are all evidenced, so they may be attempted. */
export function attemptableWorkflows(): WorkflowSpec[] {
  return WORKFLOWS.filter((workflow) => isAutomatable(workflow.status));
}

export interface StatusProblem {
  workflow: string;
  reason: string;
}

/**
 * Checks that no workflow claims more than its controls support.
 *
 * A workflow is only as evidenced as its weakest control. Saying `discovered`
 * while depending on something nobody has seen is the exact dishonesty this
 * whole status model exists to prevent, so it is checked mechanically rather
 * than left to whoever edits the list next.
 */
export function statusProblems(): StatusProblem[] {
  const problems: StatusProblem[] = [];

  for (const workflow of WORKFLOWS) {
    if (!isAutomatable(workflow.status)) continue;

    for (const key of workflow.controls) {
      const control = interfaceControl(key);
      if (!control) {
        problems.push({ workflow: workflow.key, reason: `unknown control ${key}` });
        continue;
      }
      if (!isAutomatable(control.evidenceStatus)) {
        problems.push({
          workflow: workflow.key,
          reason: `depends on ${key}, which is only ${control.evidenceStatus}`,
        });
      }
    }

    if (workflow.controls.length === 0) {
      problems.push({
        workflow: workflow.key,
        reason: 'claims to be automatable but names no control',
      });
    }
  }

  return problems;
}

/** Every control that no workflow uses, so nothing is registered and forgotten. */
export function unusedControls(): string[] {
  const used = new Set(WORKFLOWS.flatMap((workflow) => workflow.controls));
  return INTERFACE_CONTROLS.filter((control) => !used.has(control.key)).map((control) => control.key);
}

/** The status table, for the report an operator reads. */
export function statusTable(): Array<{
  workflow: string;
  intent: string;
  status: EvidenceStatus;
  interfaceVersion: InterfaceVersion;
  safety: SafetyClass;
  blockedBy: string[];
}> {
  return WORKFLOWS.map((workflow) => ({
    workflow: workflow.key,
    intent: workflow.intent,
    status: workflow.status,
    interfaceVersion: workflow.interfaceVersion,
    safety: workflow.safety,
    blockedBy: workflow.controls.filter((key) => {
      const control = interfaceControl(key);
      return !control || !isAutomatable(control.evidenceStatus);
    }),
  }));
}
