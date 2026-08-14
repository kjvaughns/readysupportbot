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
}

export const ROUTES = {
  login: '/',
  dashboard: '/admin',
  agents: '/admin/users',
  agentSearch: '/admin/users?search=',
  agentDetail: (readymodeUserId: string) => `/admin/users/${encodeURIComponent(readymodeUserId)}`,
  licenses: '/admin/licenses',
  campaigns: '/admin/campaigns',
  queues: '/admin/queues',
} as const;

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
): ControlDefinition => ({ name, description, candidates, required });

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
  resetPassword: control('agents.reset_password', 'Reset password control on an agent', [
    { type: 'testId', value: 'reset-password' },
    { type: 'role', role: 'button', name: /reset password|change password/i },
  ]),
  deactivate: control('agents.deactivate', 'Deactivate agent control', [
    { type: 'testId', value: 'deactivate-agent' },
    { type: 'role', role: 'button', name: /deactivate|disable|suspend/i },
  ]),
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
  section: control('campaigns.section', 'Campaign assignment section', [
    { type: 'testId', value: 'agent-campaigns' },
    { type: 'role', role: 'group', name: /campaigns?/i },
    { type: 'css', value: '[data-field="campaigns"]' },
  ]),
  save: control('campaigns.save', 'Save button for campaign assignment', [
    { type: 'testId', value: 'save-campaigns' },
    { type: 'role', role: 'button', name: /save|update|apply/i },
  ]),
} as const;

export const QUEUE_CONTROLS = {
  section: control('queues.section', 'Queue assignment section', [
    { type: 'testId', value: 'agent-queues' },
    { type: 'role', role: 'group', name: /queues?/i },
    { type: 'css', value: '[data-field="queues"]' },
  ]),
  save: control('queues.save', 'Save button for queue assignment', [
    { type: 'testId', value: 'save-queues' },
    { type: 'role', role: 'button', name: /save|update|apply/i },
  ]),
} as const;

export const LICENSE_CONTROLS = {
  table: control('licenses.table', 'Table of licenses currently in use', [
    { type: 'testId', value: 'license-table' },
    { type: 'css', value: 'table' },
    { type: 'role', role: 'table' },
  ]),
} as const;

/** Every control, used by the discovery report. */
export const ALL_CONTROLS: ControlDefinition[] = [
  ...Object.values(LOGIN_CONTROLS),
  ...Object.values(AGENT_CONTROLS),
  ...Object.values(STATE_CONTROLS),
  ...Object.values(CAMPAIGN_CONTROLS),
  ...Object.values(QUEUE_CONTROLS),
  ...Object.values(LICENSE_CONTROLS),
];
