import { EvidenceStatus } from '../interface/types';

/**
 * What a discovery run is made of, and the order it happens in.
 *
 * The previous run reported a profile that had only ever seen the login page.
 * Nothing in the shape of the code said which stage it had reached, so a run
 * that signed in and then failed to crawl looked identical to a run that
 * crawled and found nothing. Naming the stages makes the difference visible in
 * the result, and makes "we never got past the login screen" a reportable fact
 * rather than something to infer from a short list of selectors.
 */

export const DISCOVERY_STAGES = [
  'login_page_confirmed',
  'credentials_submitted',
  'multiple_session_continued',
  'authenticated_dashboard_confirmed',
  'interface_crawling',
  'interface_crawled',
  'profile_generated',
] as const;

/**
 * Ways a run can end without reaching the interface.
 *
 * Separate from the ordered stages because they are not progress: reaching one
 * means the run stopped. `authentication_lost` in particular describes a run
 * that *was* signed in and then was not — a route redirected back to login —
 * and the crawl stops there rather than recording the login page as another
 * administrative screen.
 */
export const DISCOVERY_FAILURES = ['authentication_failed', 'authentication_lost'] as const;

export type DiscoveryFailure = (typeof DISCOVERY_FAILURES)[number];

export type DiscoveryStage = (typeof DISCOVERY_STAGES)[number];

/** Every state a run can report, ordered stages plus the two failures. */
export type DiscoveryState = DiscoveryStage | DiscoveryFailure;

export interface StageResult {
  stage: DiscoveryState;
  reached: boolean;
  at: string;
  detail?: string;
}

/**
 * The furthest state a run got to.
 *
 * A failure state wins over any stage before it: a run that lost its session
 * half way through the crawl reports `authentication_lost`, not
 * `interface_crawling`, because the second would read as progress.
 */
export function furthestStage(stages: StageResult[]): DiscoveryState | null {
  for (const failure of DISCOVERY_FAILURES) {
    if (stages.some((entry) => entry.stage === failure && entry.reached)) return failure;
  }

  let furthest: DiscoveryStage | null = null;
  for (const stage of DISCOVERY_STAGES) {
    if (stages.some((entry) => entry.stage === stage && entry.reached)) furthest = stage;
  }
  return furthest;
}

/**
 * Whether a run may claim it crawled the interface.
 *
 * Two conditions, both required. The dashboard must have been confirmed, and at
 * least one administrative screen must have been confirmed after it. A run that
 * navigated eleven times and confirmed nothing has not crawled anything.
 */
export function mayClaimCrawled(input: {
  dashboardConfirmed: boolean;
  screensConfirmed: number;
  authenticationLost: boolean;
}): boolean {
  return input.dashboardConfirmed && input.screensConfirmed > 0 && !input.authenticationLost;
}

/**
 * A screen the crawl visits.
 *
 * Every route here was recorded by the read-only inspection. `expect` names how
 * the screen identifies itself so arrival can be confirmed — but a route whose
 * confirmation fails is still inspected, because refusing to record what is on
 * screen is what produced an empty profile last time. Confirmation decides how
 * much a capture is trusted, not whether it happens.
 */
export interface CrawlTarget {
  key: string;
  label: string;
  route: string;
  expect: string[];
  /** A tab inside the screen its parent opened, clicked by exact label. */
  tabOf?: string;
  tabLabel?: string;
  /** Why a target is expected to fail, when that is already known. */
  knownLimitation?: string;
}

export const CRAWL_TARGETS: CrawlTarget[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    route: '-Dashboard',
    expect: ['Dashboard'],
  },
  {
    key: 'user_management',
    label: 'User Management',
    route: '-Team/ManageUsers',
    expect: ['User Management', 'Manage Users'],
  },
  {
    key: 'license_usage',
    label: 'License Usage',
    route: '+Team/ManageLicenses',
    expect: ['License Usage', 'Manage Licenses'],
  },
  {
    key: 'lead_management',
    label: 'Lead Management',
    route: '-AI Leads/pools',
    expect: ['Lead Management', 'Lead Pools'],
  },
  {
    key: 'queues',
    label: 'Queues',
    route: '-AI Leads/pools',
    tabOf: 'lead_management',
    tabLabel: 'Queues',
    expect: ['Lead Management', 'Queues'],
  },
  {
    key: 'campaigns',
    label: 'Campaigns',
    route: '-AI Leads/pools',
    tabOf: 'lead_management',
    tabLabel: 'Campaigns',
    expect: ['Lead Management', 'Campaigns'],
  },
  {
    key: 'queue_editor',
    label: 'Edit Queue',
    // The inspection observed queue 0. Opening a queue's editor is read-only;
    // nothing is saved.
    route: '+Communication/Queue=0',
    expect: ['Edit Queue'],
  },
  {
    key: 'settings',
    label: 'Settings',
    route: '-Configure',
    expect: ['Settings', 'Configure'],
  },
  {
    key: 'voip',
    label: 'VOIP',
    route: '!Configure/Communication/VOIP',
    expect: ['VOIP', 'Settings'],
  },
  {
    key: 'lead_distribution',
    label: 'Lead distribution',
    route: '!Configure/AI Leads/Lead distribution',
    expect: ['Lead distribution', 'Settings'],
  },
  {
    key: 'agent_options',
    label: 'Agent Options',
    route: '!Configure/CCS Profile/Agent Options',
    expect: ['Agent Options', 'Settings'],
  },
];

/**
 * A workflow walked for its controls, rather than a screen visited for itself.
 *
 * Discovering isolated controls misses the ones that only exist part-way
 * through something: the reset control on a user's own record, the playlist
 * editor inside a queue's members tab. These name the read-only path to each.
 *
 * Every step is a navigation. None of them submits, saves, creates,
 * deactivates, resets or changes anything — the collector reads attributes and
 * text, and the walk clicks only labels on a fixed allowlist.
 */
export interface WorkflowProbe {
  key: string;
  /** What a person would ask for. */
  intent: string;
  /** Crawl targets to be on, in order, before looking. */
  path: string[];
  /**
   * Open the first record in the screen's table, to reach a detail view that
   * has no route of its own. Row contents are never captured.
   */
  openFirstRecord?: boolean;
  /** Exact tab labels to click once the record is open. */
  tabs?: string[];
  /** Controls this workflow is looking for. */
  controls: string[];
  /** Set when the path is known not to be reachable, with the reason. */
  blocked?: string;
}

export const WORKFLOW_PROBES: WorkflowProbe[] = [
  {
    key: 'search_agent',
    intent: 'Search for an agent',
    path: ['user_management'],
    controls: ['agents.search', 'agents.rows'],
  },
  {
    key: 'open_agent',
    intent: 'Open an agent profile',
    path: ['user_management'],
    openFirstRecord: true,
    controls: ['agents.rows'],
  },
  {
    key: 'create_agent',
    intent: 'Create an agent',
    path: ['user_management'],
    controls: ['agents.create'],
    blocked:
      'The creation tool opens from an unlabelled plus icon beside a user folder. The inspection could not resolve it — the legacy toolbar rendered at zero size — and a selector for an unlabelled icon could only come from its appearance or position.',
  },
  {
    key: 'reset_password',
    intent: 'Reset an agent password',
    path: ['user_management'],
    openFirstRecord: true,
    tabs: ['Account Settings'],
    controls: ['agents.reset_password'],
  },
  {
    key: 'deactivate_agent',
    intent: 'Deactivate an agent',
    path: ['user_management'],
    openFirstRecord: true,
    controls: ['agents.deactivate'],
  },
  {
    key: 'save_agent',
    intent: 'Save agent changes',
    path: ['user_management'],
    openFirstRecord: true,
    controls: ['agents.save'],
  },
  {
    key: 'manage_states',
    intent: 'Manage states',
    path: ['user_management'],
    openFirstRecord: true,
    controls: ['states.section', 'states.multiselect', 'states.checkboxes', 'states.save'],
  },
  {
    key: 'clear_license',
    intent: 'Clear a license',
    path: ['license_usage'],
    controls: ['licenses.table', 'agents.clear_license'],
  },
  {
    key: 'force_logout',
    intent: 'Force logout an agent',
    path: ['license_usage'],
    controls: ['agents.force_logout'],
  },
  {
    key: 'logout_inactive',
    intent: 'Log out inactive users',
    path: ['license_usage'],
    controls: ['users.log_out_inactive'],
  },
  {
    key: 'manage_campaigns',
    intent: 'Manage campaigns',
    path: ['lead_management', 'campaigns'],
    controls: ['campaigns.section', 'campaigns.save'],
  },
  {
    key: 'manage_queues',
    intent: 'Manage queues',
    path: ['lead_management', 'queues'],
    controls: ['queues.section', 'queues.save'],
  },
  {
    key: 'manage_playlists',
    intent: 'Manage playlists',
    path: ['queue_editor'],
    tabs: ['Members'],
    controls: ['playlists.section', 'playlists.save'],
  },
  {
    key: 'assign_playlist',
    intent: 'Assign an agent to a playlist',
    path: ['queue_editor'],
    tabs: ['Members'],
    controls: ['playlists.section'],
  },
];

/** One workflow's outcome, for the review screen. */
export interface WorkflowProbeResult {
  key: string;
  intent: string;
  /** Screens actually reached, in order. */
  reached: string[];
  /** Screens the path named that could not be opened. */
  unreachable: string[];
  controlsFound: string[];
  controlsMissing: string[];
  status: EvidenceStatus;
  /** Present whenever the workflow could not be walked in full. */
  reason?: string;
}
