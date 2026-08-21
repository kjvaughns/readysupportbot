/**
 * Every Readymode route, label, selector and success condition lives here.
 *
 * Nothing about how Readymode represents its screens is assumed anywhere else
 * in the codebase. Each control is described as an ordered list of candidate
 * strategies; the discovery module resolves the first one that matches exactly
 * one element on the page. If none match, the workflow stops and reports that
 * it needs configuration rather than clicking something it does not recognize.
 */

export type SelectorStrategy =
  | { type: 'testId'; value: string }
  /**
   * A control that legitimately appears once per row — the per-row "Sign Out"
   * on License Usage, for example. `scope` identifies the table uniquely and
   * `label` is the control's exact visible text; which row is acted on is
   * decided at run time by matching the user, never by position.
   */
  | { type: 'rowControl'; scope: string; label: string }
  | { type: 'role'; role: string; name?: string | RegExp; exact?: boolean }
  | { type: 'label'; value: string | RegExp; exact?: boolean }
  | { type: 'placeholder'; value: string | RegExp }
  | { type: 'text'; value: string | RegExp; exact?: boolean }
  | { type: 'css'; value: string };

export interface ControlDefinition {
  /** Stable name used in logs, audit records and the discovery report. */
  name: string;
  /** Ordered candidates, most specific first. */
  candidates: SelectorStrategy[];
  /** When false, a workflow may continue if the control is absent. */
  required: boolean;
  description: string;
  /**
   * True for a control that exists once per table row. Resolution accepts more
   * than one visible match for these — a licence table with eight users has
   * eight "Sign Out" buttons and that is correct, not ambiguous. The row is
   * still identified uniquely before anything is clicked.
   */
  perRow?: boolean;
}

/**
 * There is no route table.
 *
 * Readymode Starter is a single-page application: the authenticated address is
 * `https://<tenant>.readymode.com/#` and it stays that way. `/admin/users`,
 * `/admin/licenses`, `/admin/campaigns` and `/admin/queues` were assumptions,
 * and they do not exist. Screens are reached by clicking their exact label and
 * confirmed by the panel heading that appears — see `src/readymode/navigation.ts`.
 */

export const LABELS = {
  states: ['States', 'State', 'Licensed States', 'State Assignment', 'Assigned States', 'Territories'],
  campaigns: ['Campaigns', 'Campaign Assignment', 'Assigned Campaigns'],
  queues: ['Queues', 'Queue Assignment', 'Assigned Queues'],
  active: ['Active', 'Enabled', 'Status'],
} as const;

const control = (
  name: string,
  description: string,
  candidates: SelectorStrategy[],
  required = true,
  extra: { perRow?: boolean } = {},
): ControlDefinition => ({ name, description, candidates, required, ...extra });

export const LOGIN_CONTROLS = {
  username: control('login.username', 'Readymode administrator username field', [
    { type: 'testId', value: 'username' },
    { type: 'label', value: /user\s*name|username|email/i },
    { type: 'placeholder', value: /user\s*name|username|email/i },
    { type: 'css', value: 'input[name="username"]' },
    { type: 'css', value: 'input[name="user"]' },
    { type: 'css', value: 'input[type="email"]' },
  ]),
  password: control('login.password', 'Readymode administrator password field', [
    { type: 'testId', value: 'password' },
    { type: 'label', value: /password/i },
    { type: 'css', value: 'input[type="password"]' },
    { type: 'css', value: 'input[name="password"]' },
  ]),
  submit: control('login.submit', 'Login submit button', [
    { type: 'testId', value: 'login-submit' },
    { type: 'role', role: 'button', name: /log ?in|sign ?in|submit/i },
    { type: 'css', value: 'button[type="submit"]' },
    { type: 'css', value: 'input[type="submit"]' },
  ]),
} as const;

/** Signals that the session is authenticated. Any one of these is sufficient. */
export const LOGIN_SUCCESS_CONDITIONS: SelectorStrategy[] = [
  { type: 'testId', value: 'admin-nav' },
  { type: 'role', role: 'navigation' },
  { type: 'text', value: /log ?out|sign ?out/i },
  { type: 'css', value: '[data-admin], #admin, .admin-container' },
];

/**
 * Signals that a human has to intervene. ReadySupport never attempts to solve
 * these — it pauses the queue and notifies an Owner.
 */
export const HUMAN_VERIFICATION_CONDITIONS: SelectorStrategy[] = [
  { type: 'css', value: 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .g-recaptcha, .h-captcha' },
  { type: 'css', value: '[data-testid="captcha"], #captcha' },
  { type: 'text', value: /verification code|two[- ]factor|2fa|one[- ]time (code|password)|authenticator/i },
  { type: 'text', value: /prove you.?re (not a robot|human)/i },
];

export const LOGIN_FAILURE_CONDITIONS: SelectorStrategy[] = [
  { type: 'text', value: /invalid (username|password|credentials)|login failed|incorrect password/i },
  { type: 'css', value: '.login-error, [data-testid="login-error"]' },
];

export const AGENT_CONTROLS = {
  search: control('agents.search', 'Agent search field on the users list', [
    { type: 'testId', value: 'agent-search' },
    { type: 'role', role: 'searchbox' },
    { type: 'placeholder', value: /search/i },
    { type: 'css', value: 'input[name="search"], input[type="search"]' },
  ]),
  resultRows: control('agents.rows', 'Rows in the agent results table', [
    { type: 'testId', value: 'agent-row' },
    { type: 'css', value: 'table tbody tr' },
    { type: 'role', role: 'row' },
  ]),
  createButton: control('agents.create', 'Create agent button', [
    { type: 'testId', value: 'create-agent' },
    { type: 'role', role: 'button', name: /add (user|agent)|create (user|agent)|new (user|agent)/i },
  ]),
  clearLicense: control('agents.clear_license', 'Clear license control on an agent', [
    { type: 'testId', value: 'clear-license' },
    { type: 'role', role: 'button', name: /clear licen[cs]e|release licen[cs]e|force ?logout/i },
  ]),
  resetPassword: control(
    'agents.reset_password',
    'Reset button beside the Reset password field on a user\'s Account Settings tab',
    [
      { type: 'testId', value: 'reset-password' },
      { type: 'role', role: 'button', name: 'Reset', exact: true },
      { type: 'role', role: 'button', name: /^reset password$/i },
    ],
  ),
  deactivate: control('agents.deactivate', 'Deactivate agent control', [
    { type: 'testId', value: 'deactivate-agent' },
    { type: 'role', role: 'button', name: /deactivate|disable|suspend/i },
  ]),
  /**
   * Readymode's own control for releasing idle sessions. An operator placed it
   * at the foot of License Usage, beside "Sign Out Myself" and "Sign Out
   * Everyone Else", and gave its exact label. That is a reported observation
   * rather than a guess — but it still has to resolve uniquely in the real
   * interface before any workflow will click it.
   */
  logOutInactive: control(
    'users.log_out_inactive',
    'Sign Out Inactive Users button at the foot of License Usage',
    [
      { type: 'testId', value: 'log-out-inactive' },
      // The exact label, as it reads in the real interface. "Sign Out Everyone
      // Else" sits beside it and signs out every other administrator — it is
      // never an acceptable substitute, so nothing here may match it.
      { type: 'role', role: 'button', name: 'Sign Out Inactive Users', exact: true },
      { type: 'text', value: 'Sign Out Inactive Users', exact: true },
      { type: 'css', value: 'input[type="submit"][value="Sign Out Inactive Users" i]' },
    ],
  ),
  forceLogout: control(
    'agents.force_logout',
    'Sign Out button inside one user\'s row on License Usage',
    [
      { type: 'testId', value: 'force-logout' },
      // Row-scoped by construction. The row is chosen by matching the user, so
      // the control never depends on a position in the table.
      { type: 'rowControl', scope: 'table', label: 'Sign Out' },
    ],
    true,
    { perRow: true },
  ),
  saveButton: control('agents.save', 'Save button on the agent detail form', [
    { type: 'testId', value: 'save-agent' },
    { type: 'role', role: 'button', name: /^\s*(save|update|apply)\s*$/i },
    { type: 'css', value: 'button[type="submit"]' },
  ]),
  loggedInIndicator: control(
    'agents.logged_in',
    'Indicator showing whether the agent is currently logged in',
    [
      { type: 'testId', value: 'agent-logged-in' },
      { type: 'text', value: /logged ?in|online|on call|available/i },
    ],
    false,
  ),
} as const;

export const STATE_CONTROLS = {
  section: control('states.section', 'Section of the agent form that holds state assignments', [
    { type: 'testId', value: 'agent-states' },
    { type: 'role', role: 'group', name: /states?|territories/i },
    { type: 'css', value: '[data-field="states"], fieldset:has(legend:text-matches("states?", "i"))' },
  ]),
  multiSelect: control(
    'states.multiselect',
    'Multi-select control listing every state',
    [
      { type: 'testId', value: 'states-select' },
      { type: 'css', value: 'select[name*="state" i][multiple]' },
      { type: 'css', value: 'select[name*="state" i]' },
    ],
    false,
  ),
  checkboxContainer: control(
    'states.checkboxes',
    'Container holding one checkbox per state',
    [
      { type: 'testId', value: 'states-checkboxes' },
      { type: 'css', value: '[data-field="states"] input[type="checkbox"]' },
    ],
    false,
  ),
  save: control('states.save', 'Save button for the state assignment', [
    { type: 'testId', value: 'save-states' },
    { type: 'role', role: 'button', name: /save|update|apply/i },
  ]),
} as const;

/** Confirmation that a save actually took effect. */
export const SAVE_SUCCESS_CONDITIONS: SelectorStrategy[] = [
  { type: 'testId', value: 'save-success' },
  { type: 'role', role: 'alert' },
  { type: 'text', value: /saved|updated successfully|changes saved/i },
];

export const CAMPAIGN_CONTROLS = {
  section: control('campaigns.section', 'Campaigns tab of Lead Management', [
    { type: 'testId', value: 'agent-campaigns' },
    { type: 'role', role: 'tab', name: 'Campaigns', exact: true },
    { type: 'text', value: 'Campaigns', exact: true },
    { type: 'css', value: '[data-field="campaigns"]' },
  ]),
  save: control('campaigns.save', 'Save button inside Campaign Settings', [
    { type: 'testId', value: 'save-campaigns' },
    { type: 'role', role: 'button', name: 'Save', exact: true },
  ]),
} as const;

export const PLAYLIST_CONTROLS = {
  section: control('playlists.section', 'Playlist membership inside a queue\'s Members tab', [
    { type: 'testId', value: 'agent-playlists' },
    // Queue membership is organized into playlists, and each playlist offers
    // "Add a queue member" — the phrase is the section's clearest marker.
    { type: 'text', value: 'Add a queue member', exact: true },
    { type: 'role', role: 'group', name: /playlists?|lead pools?/i },
    { type: 'css', value: '[data-field="playlists"]' },
  ]),
  save: control('playlists.save', 'Save button inside the Lead Playlist Editor', [
    { type: 'testId', value: 'save-playlists' },
    { type: 'role', role: 'button', name: 'Save and Close', exact: true },
    { type: 'role', role: 'button', name: 'Save', exact: true },
  ]),
} as const;

export const QUEUE_CONTROLS = {
  section: control('queues.section', 'Queues tab of Lead Management', [
    { type: 'testId', value: 'agent-queues' },
    { type: 'role', role: 'tab', name: 'Queues', exact: true },
    { type: 'text', value: 'Queues', exact: true },
    { type: 'css', value: '[data-field="queues"]' },
  ]),
  save: control('queues.save', 'Save button inside Edit Queue', [
    { type: 'testId', value: 'save-queues' },
    { type: 'role', role: 'button', name: 'Save and Close', exact: true },
    { type: 'role', role: 'button', name: 'Save', exact: true },
  ]),
} as const;

export const LICENSE_CONTROLS = {
  table: control('licenses.table', 'Table of users holding a licence on License Usage', [
    { type: 'testId', value: 'license-table' },
    // Identified by the column headings an operator observed, so it is not
    // confused with the two summary tables above it on the same screen.
    { type: 'css', value: 'table:has(th:text-is("License Type"))' },
    { type: 'css', value: 'table:has(th:text-is("Last Active"))' },
  ]),
} as const;


/**
 * The Continue button on Readymode's "another administrator is signed in"
 * notice.
 *
 * Deliberately NOT part of ALL_CONTROLS: it is not a capability, and it must not
 * change the control counts the connection test reports.
 */
export const TAKEOVER_CONTROLS = {
  continue: control(
    'takeover.continue',
    'Continue button on the administrator session notice',
    [
      {
        type: 'role',
        role: 'button',
        name: /^\s*(?:continue|proceed|take\s?over|continue\s+anyway|yes,?\s*continue)\s*$/i,
      },
      { type: 'css', value: 'input[type="submit"][value="Continue" i]' },
      { type: 'css', value: 'input[type="button"][value="Continue" i]' },
    ],
  ),
} as const;

/** Every control, used by the discovery report. */
export const ALL_CONTROLS: ControlDefinition[] = [
  ...Object.values(LOGIN_CONTROLS),
  ...Object.values(AGENT_CONTROLS),
  ...Object.values(STATE_CONTROLS),
  ...Object.values(CAMPAIGN_CONTROLS),
  ...Object.values(QUEUE_CONTROLS),
  ...Object.values(PLAYLIST_CONTROLS),
  ...Object.values(LICENSE_CONTROLS),
];
