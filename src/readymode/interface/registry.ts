import {
  BlockedArea,
  EvidenceStatus,
  InterfaceControl,
  InterfacePage,
  isAutomatable,
} from './types';

/**
 * The interface registry, transcribed from the read-only inspection recorded in
 * `data/readysupport_interface_map.json`.
 *
 * Two rules govern everything here.
 *
 * A control's `evidenceStatus` says where it came from, and `documented` is not
 * evidence. An official article saying a button exists is a reason to go and
 * look for it, never a reason to click it. `tests/interfaceMap.test.ts` checks
 * this file against the inspection file so the two cannot drift apart.
 *
 * Routes are relative. The inspection was captured against one customer's
 * tenant, and this repository is public, so no tenant hostname is stored here —
 * routes resolve against each organization's own configured base URL.
 */

/** The date of the read-only inspection these entries came from. */
export const INSPECTION_DATE = '2026-08-21';

/**
 * The dashboard route, and the route ReadySupport returns to between steps.
 *
 * Readymode Starter's routes are unusual — a leading `-`, `+`, `!` or `*` marks
 * how the shell should open the screen — but they are real routes and the
 * address does change. An earlier operator description had this as a
 * single-page interface at `/#` where screens open only as panels; the
 * inspection shows otherwise, and the inspection is the stronger evidence.
 * Navigation therefore uses the route and confirms the heading, which works
 * whichever description is right for a given deployment.
 */
export const DASHBOARD_ROUTE = '-Dashboard';

/** Navigation observed in the shell, by the label a person clicks. */
export const SHELL_NAVIGATION: Array<{
  label: string;
  route: string;
  evidenceStatus: EvidenceStatus;
}> = [
  { label: 'Dashboard', route: '-Dashboard', evidenceStatus: 'discovered' },
  { label: 'User Management', route: '-Team/ManageUsers', evidenceStatus: 'discovered' },
  { label: 'Lead Management', route: '-AI Leads/pools', evidenceStatus: 'discovered' },
  { label: 'License Usage', route: '+Team/ManageLicenses', evidenceStatus: 'discovered' },
  { label: 'Settings', route: '-Configure', evidenceStatus: 'discovered' },
  { label: 'My Files', route: '-Folders', evidenceStatus: 'discovered' },
  { label: 'Shared Files', route: '-Folders/shared', evidenceStatus: 'discovered' },
  { label: 'My Appointments', route: '+CCS Appointments/View', evidenceStatus: 'discovered' },
  { label: 'Audit logs', route: '+Team/AuditLog/Reports/out.php', evidenceStatus: 'discovered' },
  { label: 'Call logs', route: '+CCS Reports/call_log', evidenceStatus: 'discovered' },
  { label: 'Productivity', route: '+CCS Reports/productivity', evidenceStatus: 'discovered' },
  { label: 'Dialer report', route: '+CCS Reports/dialer', evidenceStatus: 'discovered' },
  {
    label: 'Lead reports',
    route: '+CCS Reports/View/Report type=Lead^batch reports',
    evidenceStatus: 'discovered',
  },
  { label: 'Agent Report', route: '+CCS Reports/agent', evidenceStatus: 'discovered' },
  { label: 'Research Calls', route: '+CCS Reports/research', evidenceStatus: 'discovered' },
  { label: 'Live call report', route: '+CCS Reports/live', evidenceStatus: 'discovered' },
  { label: 'Recent calls', route: '-CCS Reports/inboundcl', evidenceStatus: 'discovered' },
  { label: 'Office Map', route: '+CCS Floor Monitor/Floor Map=1', evidenceStatus: 'discovered' },
];

export const INTERFACE_PAGES: InterfacePage[] = [
  {
    key: 'dashboard',
    route: '-Dashboard',
    heading: 'Dashboard',
    evidenceStatus: 'discovered',
    interfaceVersion: 'starter',
  },
  {
    key: 'user_management',
    route: '-Team/ManageUsers',
    heading: 'User Management',
    evidenceStatus: 'discovered',
    interfaceVersion: 'starter',
  },
  {
    key: 'license_usage',
    route: '+Team/ManageLicenses',
    heading: 'License Usage',
    tables: [
      {
        name: 'license_summary',
        headers: ['Agent Licenses', 'Admin Licenses', 'Total', 'Assigned', 'Remaining'],
      },
      {
        name: 'users',
        headers: ['User Id', 'User Account', 'User Name', 'License Type', 'Signed In', 'Last Active'],
      },
    ],
    evidenceStatus: 'discovered',
    interfaceVersion: 'starter',
  },
  {
    key: 'lead_management',
    route: '-AI Leads/pools',
    heading: 'Lead Management',
    evidenceStatus: 'discovered',
    interfaceVersion: 'starter',
  },
  {
    key: 'queue_editor',
    route: null,
    routePattern: '+Communication/Queue={queue_id}',
    heading: 'Edit Queue',
    headingPattern: 'Edit Queue: {queue_name}',
    frames: [
      { name: 'queuevmup_target', purpose: 'voicemail upload response' },
      { name: 'whisperup_target', purpose: 'whisper upload response' },
    ],
    evidenceStatus: 'discovered',
    interfaceVersion: 'starter',
  },
  {
    key: 'settings',
    route: '-Configure',
    heading: 'Settings',
    evidenceStatus: 'discovered',
    interfaceVersion: 'starter',
  },
];

/** Frames seen in the shell. Neither is used for automation. */
export const SHELL_FRAMES = [
  {
    key: 'frame.resource_center',
    selector: 'iframe#userpilot-resource-centre-frame',
    title: 'Resource Center',
    automationUse: 'none',
  },
  {
    key: 'frame.support_context',
    selector: 'iframe#embeddedMessagingSiteContextFrame',
    name: 'embeddedMessagingSiteContextFrame',
    // Third-party origin. Never searched for controls and never read from.
    origin: 'https://xencall.my.site.com',
    automationUse: 'none',
  },
] as const;

const starter = {
  interfaceVersion: 'starter' as const,
  lastVerified: INSPECTION_DATE,
};

/** Every known control. */
export const INTERFACE_CONTROLS: InterfaceControl[] = [
  // -- login ----------------------------------------------------------------
  {
    key: 'login.username',
    page: 'login',
    strategy: { type: 'css', value: "input[placeholder='Username']" },
    expectedLabel: 'Username',
    expectedElement: 'input',
    expectedFrame: null,
    expectedRoute: 'login_new/?then=/',
    preconditions: ['The session is signed out.'],
    postconditions: ['The field accepts input.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    notes: 'The value is written once from encrypted storage and never read back.',
    ...starter,
  },
  {
    key: 'login.password',
    page: 'login',
    strategy: { type: 'css', value: "input[placeholder='Password']" },
    expectedLabel: 'Password',
    expectedElement: 'password',
    expectedFrame: null,
    expectedRoute: 'login_new/?then=/',
    preconditions: ['The session is signed out.'],
    postconditions: ['The field accepts input.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    notes: 'Write-only. The value is never read, logged, stored in evidence, or sent to a model.',
    ...starter,
  },
  {
    key: 'login.submit',
    page: 'login',
    strategy: { type: 'role', role: 'button', name: 'Sign in', exact: true },
    expectedLabel: 'Sign in',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: 'login_new/?then=/',
    preconditions: ['The username and password fields are filled.'],
    postconditions: ['The Dashboard appears, or an interstitial does.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    ...starter,
  },
  {
    key: 'login.admin_mode',
    page: 'login',
    strategy: { type: 'css', value: "input[type='checkbox']" },
    expectedLabel: 'Sign in as Admin',
    expectedElement: 'checkbox',
    expectedFrame: null,
    expectedRoute: 'login_new/?then=/',
    preconditions: ['The login form is on screen.'],
    postconditions: ['Signing in reaches the administrator interface.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    ...starter,
  },
  {
    key: 'login.multiple_session_continue',
    page: 'login',
    strategy: { type: 'role', role: 'button', name: 'Continue', exact: true },
    expectedLabel: 'Continue',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: [
      'Readymode says an administrator is already signed in.',
      'No human verification is on screen.',
      'The host matches the organization\'s configured Readymode domain.',
      'Continue has not already been pressed in this session.',
    ],
    postconditions: ['The Dashboard or License Usage becomes available.'],
    // Documented, not discovered: the notice did not appear during the
    // inspection, so nobody has seen this button on this account. The
    // interstitial classifier decides whether it is safe to press.
    evidenceStatus: 'documented',
    safety: 'terminates_session',
    notes:
      'Pressing Continue signs the other administrator out. Explicitly authorized by the account owner, once per session, and only for a genuine session takeover.',
    ...starter,
  },

  // -- shell ----------------------------------------------------------------
  {
    key: 'shell.search',
    page: 'shell',
    strategy: { type: 'css', value: '#hotbar_search' },
    expectedLabel: 'Search..',
    expectedElement: 'input',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The session is signed in.'],
    postconditions: ['Results appear.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    notes:
      'Results contain lead and user personal data. ReadySupport does not read, store or return result contents.',
    ...starter,
  },
  {
    key: 'shell.sign_out',
    page: 'shell',
    strategy: { type: 'css', value: '#hotbar_logout' },
    expectedLabel: 'Sign out',
    expectedElement: 'link',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['Never used by automation.'],
    postconditions: ['The session ends.'],
    // Recorded so it is recognized and avoided, not so it can be used.
    evidenceStatus: 'unsupported',
    safety: 'terminates_session',
    notes: 'ReadySupport never signs its own session out; doing so would strand queued work.',
    ...starter,
  },

  // -- user management ------------------------------------------------------
  {
    key: 'users.search_toggle',
    page: 'user_management',
    strategy: { type: 'css', value: '#uMgmtSearchBut' },
    expectedLabel: 'Search',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['User Management is open.'],
    postconditions: ['The search field becomes visible.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    ...starter,
  },
  {
    key: 'users.search',
    page: 'user_management',
    strategy: { type: 'css', value: '#userMgmtSearchUser' },
    expectedLabel: 'Search Users',
    expectedElement: 'search',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['User Management is open.'],
    postconditions: ['The list narrows to matching users.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    notes: 'Results are used to locate one row and are never stored.',
    ...starter,
  },
  {
    key: 'users.open_queues',
    page: 'user_management',
    strategy: { type: 'css', value: '#uMgmtQueuelistBut' },
    expectedLabel: 'Open queue',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['User Management is open.'],
    postconditions: ['The queue list appears.'],
    evidenceStatus: 'discovered',
    safety: 'navigation',
    ...starter,
  },
  {
    key: 'users.view_by_role',
    page: 'user_management',
    strategy: { type: 'css', value: '#uMgmtViewOUBut' },
    expectedLabel: 'View by role',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['User Management is open.'],
    postconditions: ['The list regroups by role.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    ...starter,
  },
  {
    key: 'users.view_by_folder',
    page: 'user_management',
    strategy: { type: 'css', value: '#uMgmtViewFolderBut' },
    expectedLabel: 'View by folder',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['User Management is open.'],
    postconditions: ['The list regroups by folder.'],
    evidenceStatus: 'discovered',
    safety: 'read_only',
    ...starter,
  },
  {
    key: 'users.toggle_deleted',
    page: 'user_management',
    strategy: { type: 'css', value: '#uMgmtViewDeletedBut' },
    expectedLabel: 'Show/hide deleted users',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['Never used by automation.'],
    postconditions: ['Deleted users appear in the list.'],
    evidenceStatus: 'unsupported',
    safety: 'read_only',
    notes:
      'Shows deleted-user rows, which are personal data with no support use. ReadySupport does not toggle it.',
    ...starter,
  },
  {
    key: 'users.create',
    page: 'user_management',
    // The plus icon beside a folder. It carries no text, and the inspection
    // could not resolve it: the legacy controls rendered at zero size.
    strategy: { type: 'css', value: '__unresolved__' },
    expectedLabel: null,
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '-Team/ManageUsers',
    preconditions: ['User Management is open and a folder is chosen.'],
    postconditions: ['The User Creation Tool opens.'],
    evidenceStatus: 'blocked',
    safety: 'modifies_data',
    notes:
      'Documented in the Help Center as the plus icon beside a user folder, but not resolved live: the legacy toolbar rendered at zero size during inspection. Creating accounts stays refused until it is.',
    ...starter,
  },
  {
    key: 'users.bulk_passwords',
    page: 'user_management',
    strategy: { type: 'css', value: '__unresolved__' },
    expectedLabel: 'Open Bulk Passwords Page',
    expectedElement: 'link',
    expectedFrame: null,
    expectedRoute: '+Team/ManageUsers/bulkPassword',
    preconditions: ['Never used by automation.'],
    postconditions: [],
    evidenceStatus: 'unsupported',
    safety: 'human_only',
    notes:
      'Password operations are handled by a person. ReadySupport never reads, sets or transports a password.',
    ...starter,
  },

  // -- license usage --------------------------------------------------------
  {
    key: 'licenses.users_table',
    page: 'license_usage',
    // Identified by the columns the inspection recorded, so it is not confused
    // with the Agent/Admin summary tables above it on the same screen.
    strategy: { type: 'css', value: 'table:has(th:text-is("License Type"))' },
    expectedLabel: null,
    expectedElement: 'table',
    expectedFrame: null,
    expectedRoute: '+Team/ManageLicenses',
    preconditions: ['License Usage is open.'],
    postconditions: ['The table lists the users holding a licence.'],
    // The columns were observed; a selector for the table was not, so this is
    // an inference from real evidence rather than the evidence itself.
    evidenceStatus: 'documented',
    safety: 'read_only',
    notes: 'Column headings only are read. Row contents are never captured.',
    ...starter,
  },
  {
    key: 'licenses.sign_out_user',
    page: 'license_usage',
    strategy: { type: 'css', value: 'a#sign-out-btn.button.primary' },
    expectedLabel: 'Sign Out',
    expectedElement: 'link',
    expectedFrame: null,
    expectedRoute: '+Team/ManageLicenses',
    preconditions: [
      'License Usage is open.',
      'Exactly one row matches the named user.',
      'An administrator approved signing that user out.',
    ],
    postconditions: [
      'That row reads as signed out.',
      'The remaining licence count has increased.',
    ],
    evidenceStatus: 'discovered',
    safety: 'terminates_session',
    perRow: true,
    notes:
      'One per user row. The row is chosen by matching the user, never by position — a row chosen by position would sign out whoever happened to be sitting in it.',
    ...starter,
  },
  {
    key: 'licenses.sign_out_inactive',
    page: 'license_usage',
    strategy: { type: 'role', role: 'button', name: 'Sign Out Inactive Users', exact: true },
    expectedLabel: 'Sign Out Inactive Users',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '+Team/ManageLicenses',
    preconditions: [
      'License Usage is open.',
      'An administrator approved releasing idle sessions.',
    ],
    postconditions: ['The number of licences in use has fallen, or Readymode reported none were idle.'],
    // Named by an operator and by the Help Center, but not seen during the
    // inspection. Until it is, this workflow refuses.
    evidenceStatus: 'documented',
    safety: 'terminates_session',
    notes:
      '"Sign Out All Users" and "Sign Out Everyone Else" sit beside it and sign out people who are working. The exact label is the only thing that separates them, so nothing here may match on "sign out" alone.',
    ...starter,
  },
  {
    key: 'licenses.sign_out_all',
    page: 'license_usage',
    strategy: { type: 'role', role: 'button', name: 'Sign Out All Users', exact: true },
    expectedLabel: 'Sign Out All Users',
    expectedElement: 'button',
    expectedFrame: null,
    expectedRoute: '+Team/ManageLicenses',
    preconditions: ['Never used by automation.'],
    postconditions: [],
    evidenceStatus: 'unsupported',
    safety: 'destructive',
    notes:
      'Signs out every user, including people mid-call. Recorded so it is recognized and avoided — never as a substitute for signing out inactive users.',
    ...starter,
  },

  // -- lead management ------------------------------------------------------
  {
    key: 'leads.queues_tab',
    page: 'lead_management',
    strategy: { type: 'css', value: '#ui-id-1' },
    expectedLabel: 'Queues',
    expectedElement: 'tab',
    expectedFrame: null,
    expectedRoute: '-AI Leads/pools',
    preconditions: ['Lead Management is open.'],
    postconditions: ['The Queues tab panel is shown.'],
    evidenceStatus: 'discovered',
    safety: 'navigation',
    ...starter,
  },
  {
    key: 'leads.campaigns_tab',
    page: 'lead_management',
    strategy: { type: 'css', value: '#ui-id-2' },
    expectedLabel: 'Campaigns',
    expectedElement: 'tab',
    expectedFrame: null,
    expectedRoute: '-AI Leads/pools',
    preconditions: ['Lead Management is open.'],
    postconditions: ['The Campaigns tab panel is shown.'],
    evidenceStatus: 'discovered',
    safety: 'navigation',
    ...starter,
  },
  {
    key: 'leads.upload_file',
    page: 'lead_management',
    strategy: { type: 'css', value: '#leadfileuploadbutton' },
    expectedLabel: null,
    expectedElement: 'file',
    expectedFrame: "iframe[name='lead_csv_postwindow']",
    expectedRoute: '-AI Leads/pools',
    preconditions: ['Never used by automation.'],
    postconditions: [],
    evidenceStatus: 'unsupported',
    safety: 'human_only',
    notes: 'Uploads lead data. ReadySupport does not handle lead files.',
    ...starter,
  },

  // -- queue editor ---------------------------------------------------------
  {
    key: 'queue.members_tab',
    page: 'queue_editor',
    strategy: { type: 'css', value: '__ambiguous__' },
    expectedLabel: 'Members',
    expectedElement: 'tab',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['A queue is open.'],
    postconditions: ['The Members panel is shown.'],
    // The inspection found the id varies with queue type: `#ui-id-1` for one
    // kind of queue and `#ui-id-2` for another. An id that means two different
    // tabs is not an identification, so this stays blocked and the tab is
    // reached by its label instead.
    evidenceStatus: 'blocked',
    safety: 'navigation',
    notes:
      'The tab id changes with the rendered tab set (#ui-id-1 or #ui-id-2). Reached by its exact label "Members" instead, which does not move.',
    ...starter,
  },
  {
    key: 'queue.view_leads_tab',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#ui-id-3' },
    expectedLabel: 'View leads',
    expectedElement: 'tab',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['Never opened by automation.'],
    postconditions: [],
    evidenceStatus: 'unsupported',
    safety: 'read_only',
    notes: 'Shows lead rows. ReadySupport does not open it, so lead data is never on screen.',
    ...starter,
  },
  {
    key: 'queue.configuration_tab',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#ui-id-4' },
    expectedLabel: 'Configuration',
    expectedElement: 'tab',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['A queue is open.'],
    postconditions: ['The Configuration panel is shown.'],
    evidenceStatus: 'discovered',
    safety: 'navigation',
    ...starter,
  },
  {
    key: 'queue.queue_type',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#queue-queue_type' },
    expectedLabel: 'Queue Type',
    expectedElement: 'select',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.strategy',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#queue-queue_strat' },
    expectedLabel: 'Queue Strategy',
    expectedElement: 'select',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.dialer_configuration',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#dialersettingdropdown' },
    expectedLabel: 'Queue Speed / Dialer Configuration',
    expectedElement: 'select',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.machine_detection',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#mdselect' },
    expectedLabel: 'Machine Detection',
    expectedElement: 'select',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.agent_announcement',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#agent_announce_toggle' },
    expectedLabel: 'Agent Announcement',
    expectedElement: 'checkbox',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The toggle reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.custom_call_times',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#todEnable' },
    expectedLabel: 'Custom Call Times',
    expectedElement: 'checkbox',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The toggle reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    notes:
      'Queue call times decide when this queue dials. They are not the iQ State Calling Restrictions, which enforce legal calling windows by state.',
    ...starter,
  },
  {
    key: 'queue.start_time',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#todStart' },
    expectedLabel: 'Start Time',
    expectedElement: 'input',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['Custom Call Times is enabled.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.end_time',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#todEnd' },
    expectedLabel: 'End Time',
    expectedElement: 'input',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['Custom Call Times is enabled.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },
  {
    key: 'queue.ringtone',
    page: 'queue_editor',
    strategy: { type: 'css', value: '#queue_configure_ringtoneSelect' },
    expectedLabel: 'Ringtone',
    expectedElement: 'select',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The queue Configuration tab is open.'],
    postconditions: ['The field reads back the chosen value after saving.'],
    evidenceStatus: 'discovered',
    safety: 'modifies_data',
    ...starter,
  },

  // -- playlists ------------------------------------------------------------
  {
    key: 'playlists.editor',
    page: 'playlist_editor',
    strategy: { type: 'css', value: '__unresolved__' },
    expectedLabel: 'Lead Playlist Editor',
    expectedElement: 'panel',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['A queue is open and its Members tab is shown.'],
    postconditions: ['The playlist editor is on screen.'],
    evidenceStatus: 'blocked',
    safety: 'modifies_data',
    notes:
      'Live inspection stopped short of the playlist editor because reaching it means opening lead content. Navigation and concepts are documented; selectors are not.',
    ...starter,
  },
  {
    key: 'playlists.location_filter',
    page: 'playlist_editor',
    strategy: { type: 'css', value: '__unresolved__' },
    expectedLabel: 'State',
    expectedElement: 'select',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The playlist editor is open.'],
    postconditions: ['The playlist filter reads back the chosen states.'],
    evidenceStatus: 'blocked',
    safety: 'modifies_data',
    notes:
      'Decides which leads an agent receives. This is NOT the iQ State Calling Restriction, which enforces legal calling windows — substituting one for the other would either break the law or break the agent\'s lead flow.',
    ...starter,
  },

  // -- Readymode iQ ---------------------------------------------------------
  {
    key: 'iq.state_calling_restrictions',
    page: 'iq_advanced_settings',
    strategy: { type: 'css', value: '__unresolved__' },
    expectedLabel: 'State Calling Restrictions',
    expectedElement: 'checkbox',
    expectedFrame: null,
    expectedRoute: null,
    preconditions: ['The account uses Readymode iQ.'],
    postconditions: ['The restriction reads back as enabled.'],
    evidenceStatus: 'documented',
    interfaceVersion: 'iq',
    lastVerified: null,
    safety: 'modifies_data',
    notes:
      'Help Center documented only: the inspected account signed in to the Starter interface, so no iQ screen was ever on show. Enforces legal calling windows (TCPA) and is not a lead-assignment filter.',
  },
];

/** Areas that were looked at and could not be resolved. */
export const BLOCKED_AREAS: BlockedArea[] = [
  {
    area: 'User list and profile editor',
    reason:
      'Legacy controls rendered at zero size in the cloud session, and the rows hold personal data. The official workflow is documented; live form selectors are unresolved.',
  },
  {
    area: 'Playlist editor',
    reason:
      'Live selector inspection was not completed, because reaching the editor means opening lead-related content. Navigation and concepts are documented.',
  },
  {
    area: 'Readymode iQ administrator interface',
    reason:
      'The signed-in gateway exposed the Starter legacy interface. Every iQ path is Help Center documented only.',
  },
];

const BY_KEY = new Map(INTERFACE_CONTROLS.map((control) => [control.key, control]));

export function interfaceControl(key: string): InterfaceControl | null {
  return BY_KEY.get(key) ?? null;
}

export function controlsForPage(page: string): InterfaceControl[] {
  return INTERFACE_CONTROLS.filter((control) => control.page === page);
}

/** Controls that may be proposed for automation at all. */
export function automatableControls(): InterfaceControl[] {
  return INTERFACE_CONTROLS.filter((control) => isAutomatable(control.evidenceStatus));
}

export function pageFor(key: string): InterfacePage | null {
  return INTERFACE_PAGES.find((page) => page.key === key) ?? null;
}

/**
 * Resolves a Starter route against an organization's own base URL.
 *
 * Only spaces are encoded. Starter's routes carry leading punctuation — `-`,
 * `+`, `!`, `*` — and `+` in particular must reach the server as a literal
 * plus, exactly as the inspection recorded it (`+Team/ManageLicenses`).
 * Percent-encoding the punctuation would be a different request to a legacy
 * router that reads the raw path.
 */
export function routeUrl(baseUrl: string, route: string): string {
  const origin = new URL(baseUrl).origin;
  const path = route.replace(/^\/+/, '').replace(/ /g, '%20');
  return `${origin}/${path}`;
}

/**
 * Control names used by the workflows, mapped to the inspection's own keys.
 *
 * The two vocabularies grew separately — the workflows speak of "agents", the
 * interface speaks of "users" — and this is the one place they are reconciled.
 * A name absent from here simply has no inspected evidence behind it, which is
 * a fact worth being able to see rather than paper over.
 */
export const CONTROL_KEY_ALIASES: Record<string, string> = {
  'login.username': 'login.username',
  'login.password': 'login.password',
  'login.submit': 'login.submit',
  'takeover.continue': 'login.multiple_session_continue',
  'agents.search': 'users.search',
  'agents.create': 'users.create',
  'agents.force_logout': 'licenses.sign_out_user',
  'agents.reset_password': 'users.bulk_passwords',
  'users.log_out_inactive': 'licenses.sign_out_inactive',
  'licenses.table': 'licenses.users_table',
  'queues.section': 'leads.queues_tab',
  'campaigns.section': 'leads.campaigns_tab',
  'playlists.section': 'playlists.editor',
  'playlists.save': 'playlists.editor',
};

/** The inspected control behind a workflow control name, if there is one. */
export function inspectedControlFor(controlName: string): InterfaceControl | null {
  const key = CONTROL_KEY_ALIASES[controlName];
  return key ? interfaceControl(key) : null;
}

/**
 * The strategy the inspection supports for this control name.
 *
 * Null unless the inspection actually saw the control. A control that is only
 * documented returns nothing here, so a described button can never become a
 * clicked one.
 */
export function inspectedStrategyFor(controlName: string): InterfaceControl | null {
  const control = inspectedControlFor(controlName);
  if (!control) return null;
  if (!isAutomatable(control.evidenceStatus)) return null;
  if (control.strategy.type === 'css' && control.strategy.value.startsWith('__')) return null;
  return control;
}
