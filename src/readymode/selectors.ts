import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { env } from '../config/env.js';
import { errorFor } from '../domain/errors.js';
import { moduleLogger } from '../util/logger.js';

/**
 * The Readymode interface map.
 *
 * Every route, field, button and success marker a workflow touches is declared
 * here, once. Nothing in this file is a claim about how Readymode actually
 * looks: each entry ships with the sentinel value UNKNOWN and a description of
 * what it should point at. Real values are captured against a real instance
 * with `npm run discover` and supplied as a JSON overlay, so the interface can
 * be re-mapped without editing a single workflow.
 *
 * A workflow declares the ids it needs and calls assertConfigured() before it
 * touches the page. An unmapped selector stops the job cleanly with
 * SELECTOR_NOT_CONFIGURED. The one thing that never happens is a workflow
 * clicking something it guessed at.
 */

const log = moduleLogger('selectors');

/** The value every entry starts with, and the one workflows refuse to use. */
export const UNKNOWN = 'UNKNOWN';

/**
 * How to find the element.
 *
 *  role        getByRole with an accessible name — the most durable
 *  label       getByLabel, for form fields with a real <label>
 *  placeholder getByPlaceholder, when there is no label
 *  text        getByText, for banners and static markers
 *  testid      getByTestId, when the application provides one
 *  css         a raw selector — last resort, and the most brittle
 */
export const SELECTOR_STRATEGIES = ['role', 'label', 'placeholder', 'text', 'testid', 'css'] as const;
export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

export interface SelectorSpec {
  /** Stable id used by workflows. Never changes, even when the value does. */
  id: string;
  /** What this should point at, written for whoever runs discovery. */
  description: string;
  strategy: SelectorStrategy;
  /**
   * For `role`, the ARIA role (button, textbox, row…). For everything else,
   * the label, placeholder, text, test id or CSS selector.
   */
  value: string;
  /** For `role`, the accessible name to disambiguate. */
  name?: string;
  /** Match the name or text exactly rather than as a substring. */
  exact?: boolean;
  /** Set true once a value has been captured against a real instance. */
  verified: boolean;
}

export interface RouteSpec {
  id: string;
  description: string;
  /** Path relative to the Readymode origin, e.g. `/admin/agents`. */
  path: string;
  verified: boolean;
}

function selector(
  id: string,
  description: string,
  strategy: SelectorStrategy = 'role',
): SelectorSpec {
  return { id, description, strategy, value: UNKNOWN, verified: false };
}

function route(id: string, description: string): RouteSpec {
  return { id, description, path: UNKNOWN, verified: false };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTES: Record<string, RouteSpec> = {
  'route.login': route('route.login', 'The Readymode admin sign-in page.'),
  'route.dashboard': route(
    'route.dashboard',
    'The page you land on after signing in. Used to tell an authenticated session from an expired one.',
  ),
  'route.agents': route('route.agents', 'The list of agent accounts, with a search box.'),
  'route.agentCreate': route('route.agentCreate', 'The form for creating a new agent account.'),
  'route.licenses': route(
    'route.licenses',
    'The view showing which agents are consuming licenses. May be the same page as the agent list.',
  ),
};

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const DEFAULT_SELECTORS: Record<string, SelectorSpec> = {
  // --- Page identity -------------------------------------------------------
  // Each workflow confirms it is where it thinks it is before doing anything.
  'page.login.marker': selector(
    'page.login.marker',
    'Something present only on the sign-in page, e.g. the heading above the form.',
  ),
  'page.dashboard.marker': selector(
    'page.dashboard.marker',
    'Something present only once signed in, e.g. the account menu or the main navigation.',
  ),
  'page.agents.marker': selector(
    'page.agents.marker',
    'Something present only on the agent list, e.g. its heading or the results table.',
  ),
  'page.agentDetail.marker': selector(
    'page.agentDetail.marker',
    "Something present only on one agent's own page, e.g. their username heading.",
  ),
  'page.agentCreate.marker': selector(
    'page.agentCreate.marker',
    'Something present only on the new-agent form, e.g. its heading or the submit button.',
  ),
  'page.licenses.marker': selector('page.licenses.marker', 'Something present only on the license view.'),

  // --- Authentication ------------------------------------------------------
  'login.username.input': selector('login.username.input', 'The username field on the Readymode admin sign-in form.', 'label'),
  'login.password.input': selector('login.password.input', 'The password field on the Readymode admin sign-in form.', 'label'),
  'login.submit.button': selector('login.submit.button', 'The button that submits the Readymode admin sign-in form.'),
  'login.error.marker': selector(
    'login.error.marker',
    'The message shown when sign-in is rejected, e.g. wrong username or password.',
    'text',
  ),
  'auth.expired.marker': selector(
    'auth.expired.marker',
    'Anything shown when a session has expired and Readymode wants you to sign in again.',
    'text',
  ),
  'auth.captcha.marker': selector(
    'auth.captcha.marker',
    'A CAPTCHA challenge. ReadySupport stops when it sees this and never attempts to solve it.',
    'css',
  ),
  'auth.mfa.marker': selector(
    'auth.mfa.marker',
    'A multi-factor or verification-code prompt. ReadySupport stops when it sees this.',
    'text',
  ),

  // --- Agent list and search ----------------------------------------------
  'agents.search.input': selector('agents.search.input', 'The search box above the agent list, used to find one account by name, username or email.', 'placeholder'),
  'agents.search.submit': selector(
    'agents.search.submit',
    'The button that runs the search. Leave unmapped if the list filters as you type.',
  ),
  'agents.results.row': selector(
    'agents.results.row',
    'One row of agent search results. Must match every row and nothing else, because this is how results are counted and a miscount would defeat the single-match rule.',
    'role',
  ),
  'agents.results.empty.marker': selector(
    'agents.results.empty.marker',
    'The message the agent list shows when a search matches nothing at all.',
    'text',
  ),
  'agents.row.userId': selector('agents.row.userId', 'The Readymode user ID cell within a result row.', 'css'),
  'agents.row.username': selector('agents.row.username', 'The username cell within a result row.', 'css'),
  'agents.row.email': selector('agents.row.email', 'The email cell within a result row.', 'css'),
  'agents.row.fullName': selector('agents.row.fullName', 'The name cell within a result row.', 'css'),
  'agents.row.open': selector('agents.row.open', 'The link that opens an agent from a result row.'),
  'agents.create.button': selector('agents.create.button', 'The button that opens the new-agent form.'),

  // --- Agent detail --------------------------------------------------------
  'agent.detail.userId': selector('agent.detail.userId', 'Where the agent page shows the Readymode user ID for this account.', 'css'),
  'agent.detail.username': selector('agent.detail.username', 'Where the agent page shows this account username.', 'css'),
  'agent.detail.email': selector('agent.detail.email', 'Where the agent page shows this account email address.', 'css'),
  'agent.detail.fullName': selector('agent.detail.fullName', 'Where the agent page shows this person full name.', 'css'),
  'agent.detail.role': selector('agent.detail.role', 'Where the agent page shows the assigned agent role.', 'css'),
  'agent.detail.licenseType': selector('agent.detail.licenseType', 'Where the agent page shows which license type this account holds.', 'css'),
  'agent.detail.team': selector('agent.detail.team', 'Where the agent page shows the team this account belongs to.', 'css'),
  'agent.detail.campaign': selector('agent.detail.campaign', 'Where the agent page shows the campaign this account is assigned to.', 'css'),
  'agent.detail.queue': selector('agent.detail.queue', 'Where the agent page shows the queue this account is assigned to.', 'css'),
  'agent.detail.activeState': selector(
    'agent.detail.activeState',
    'Where the page shows whether the account is active or deactivated.',
    'css',
  ),
  'agent.detail.licenseState': selector(
    'agent.detail.licenseState',
    'Where the page shows whether a license is currently assigned or in use.',
    'css',
  ),
  'agent.detail.loginState': selector(
    'agent.detail.loginState',
    'Where the page shows whether the agent is signed in.',
    'css',
  ),
  'agent.detail.callState': selector(
    'agent.detail.callState',
    'Where the page shows whether the agent is on a call.',
    'css',
  ),

  // --- Create account ------------------------------------------------------
  'create.firstName.input': selector('create.firstName.input', 'The first name field on the new-agent form.', 'label'),
  'create.lastName.input': selector('create.lastName.input', 'The last name field on the new-agent form.', 'label'),
  'create.email.input': selector('create.email.input', 'The email address field on the new-agent form.', 'label'),
  'create.username.input': selector('create.username.input', 'The username field on the new-agent form.', 'label'),
  'create.password.input': selector('create.password.input', 'The initial password field on the new-agent form.', 'label'),
  'create.passwordConfirm.input': selector(
    'create.passwordConfirm.input',
    'Confirm-password field, if the form has one.',
    'label',
  ),
  'create.role.select': selector('create.role.select', 'The control that picks the agent role on the new-agent form.', 'label'),
  'create.licenseType.select': selector('create.licenseType.select', 'The control that picks the license type on the new-agent form.', 'label'),
  'create.team.select': selector('create.team.select', 'The control that picks the team on the new-agent form. Leave unmapped if there is none.', 'label'),
  'create.campaign.select': selector('create.campaign.select', 'The control that picks the campaign on the new-agent form. Leave unmapped if there is none.', 'label'),
  'create.queue.select': selector('create.queue.select', 'The control that picks the queue on the new-agent form. Leave unmapped if there is none.', 'label'),
  'create.active.toggle': selector('create.active.toggle', 'The control that decides whether the new account starts active.', 'label'),
  'create.submit.button': selector('create.submit.button', 'The button that submits the new-agent form and creates the account.'),
  'create.success.marker': selector(
    'create.success.marker',
    'The confirmation Readymode shows after an account is created.',
    'text',
  ),
  'create.validationError.marker': selector(
    'create.validationError.marker',
    'The message shown when the form is rejected, e.g. a duplicate username.',
    'text',
  ),

  // --- Clear license -------------------------------------------------------
  'clearLicense.trigger.button': selector(
    'clearLicense.trigger.button',
    'The control that releases the license held by the agent being viewed.',
  ),
  'clearLicense.confirm.button': selector(
    'clearLicense.confirm.button',
    'The confirmation Readymode asks for, if it asks for one.',
  ),
  'clearLicense.success.marker': selector(
    'clearLicense.success.marker',
    'The confirmation shown after a license is released.',
    'text',
  ),

  // --- Reset password ------------------------------------------------------
  'resetPassword.trigger.button': selector(
    'resetPassword.trigger.button',
    'The control that starts a password reset for the agent being viewed.',
  ),
  'resetPassword.newPassword.input': selector('resetPassword.newPassword.input', 'The new password field on the password reset form.', 'label'),
  'resetPassword.confirmPassword.input': selector(
    'resetPassword.confirmPassword.input',
    'Confirm new password field, if the form has one.',
    'label',
  ),
  'resetPassword.submit.button': selector('resetPassword.submit.button', 'The button that submits the password reset form.'),
  'resetPassword.success.marker': selector(
    'resetPassword.success.marker',
    'The confirmation shown after a password is changed.',
    'text',
  ),

  // --- Deactivate ----------------------------------------------------------
  'deactivate.trigger.button': selector(
    'deactivate.trigger.button',
    'The control that deactivates the agent being viewed.',
  ),
  'deactivate.confirm.button': selector('deactivate.confirm.button', 'The button that confirms deactivation, if Readymode asks for confirmation.'),
  'deactivate.success.marker': selector(
    'deactivate.success.marker',
    'The confirmation shown after an account is deactivated.',
    'text',
  ),

  // --- License usage -------------------------------------------------------
  'licenses.row': selector(
    'licenses.row',
    'One row in the license view. Must match every row and nothing else.',
    'role',
  ),
  'licenses.row.agent': selector('licenses.row.agent', 'The agent name or username cell in a license row.', 'css'),
  'licenses.row.licenseType': selector('licenses.row.licenseType', 'The license type cell within a row of the license view.', 'css'),
  'licenses.row.status': selector('licenses.row.status', 'The status cell, e.g. signed in or on a call.', 'css'),
  'licenses.total.inUse': selector(
    'licenses.total.inUse',
    'A total of licenses in use, if the page shows one.',
    'css',
  ),
  'licenses.total.available': selector(
    'licenses.total.available',
    'A total of licenses available, if the page shows one.',
    'css',
  ),
};

// ---------------------------------------------------------------------------
// Overlay loading
// ---------------------------------------------------------------------------

const overlaySchema = z.object({
  routes: z.record(z.object({ path: z.string().min(1), verified: z.boolean().optional() })).optional(),
  selectors: z
    .record(
      z.object({
        strategy: z.enum(SELECTOR_STRATEGIES).optional(),
        value: z.string().min(1),
        name: z.string().optional(),
        exact: z.boolean().optional(),
        verified: z.boolean().optional(),
      }),
    )
    .optional(),
});

export type SelectorOverlay = z.infer<typeof overlaySchema>;

interface SelectorRegistry {
  routes: Record<string, RouteSpec>;
  selectors: Record<string, SelectorSpec>;
  /** Where the overlay came from, for the health view. */
  overlayPath: string | null;
  loadedAt: string;
}

let registry: SelectorRegistry | undefined;

function clone(): SelectorRegistry {
  return {
    routes: Object.fromEntries(Object.entries(DEFAULT_ROUTES).map(([id, spec]) => [id, { ...spec }])),
    selectors: Object.fromEntries(Object.entries(DEFAULT_SELECTORS).map(([id, spec]) => [id, { ...spec }])),
    overlayPath: null,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * Merge a captured overlay over the defaults.
 *
 * An overlay entry for an id that is not in the registry is ignored with a
 * warning rather than added: a typo in a hand-edited file would otherwise
 * become a selector no workflow ever asks for, and the real one would stay
 * unmapped without anyone noticing.
 */
export function applyOverlay(overlay: SelectorOverlay, target: SelectorRegistry): void {
  for (const [id, patch] of Object.entries(overlay.routes ?? {})) {
    const existing = target.routes[id];
    if (!existing) {
      log.warn({ id }, 'Overlay names a route that is not in the registry; ignoring it');
      continue;
    }
    existing.path = patch.path;
    existing.verified = patch.verified ?? true;
  }

  for (const [id, patch] of Object.entries(overlay.selectors ?? {})) {
    const existing = target.selectors[id];
    if (!existing) {
      log.warn({ id }, 'Overlay names a selector that is not in the registry; ignoring it');
      continue;
    }
    if (patch.strategy) existing.strategy = patch.strategy;
    existing.value = patch.value;
    if (patch.name !== undefined) existing.name = patch.name;
    if (patch.exact !== undefined) existing.exact = patch.exact;
    existing.verified = patch.verified ?? true;
  }
}

export function loadSelectors(overlayPath?: string): SelectorRegistry {
  const built = clone();
  const path = overlayPath ?? env().READYMODE_SELECTOR_OVERLAY;

  try {
    const contents = readFileSync(resolvePath(process.cwd(), path), 'utf8');
    const parsed = overlaySchema.parse(JSON.parse(contents));
    applyOverlay(parsed, built);
    built.overlayPath = path;

    log.info(
      { path, selectors: Object.keys(parsed.selectors ?? {}).length, routes: Object.keys(parsed.routes ?? {}).length },
      'Loaded captured Readymode selectors',
    );
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (missing) {
      log.warn(
        { path },
        'No selector overlay found. Live workflows will refuse to run until discovery has been done.',
      );
    } else {
      log.error({ err: cause, path }, 'Could not read the selector overlay');
    }
  }

  return built;
}

function current(): SelectorRegistry {
  registry ??= loadSelectors();
  return registry;
}

/** Re-read the overlay, e.g. after a fresh discovery run. */
export function reloadSelectors(overlayPath?: string): void {
  registry = loadSelectors(overlayPath);
}

/** Test helper — install a registry directly. */
export function setRegistry(next: { routes?: Record<string, RouteSpec>; selectors?: Record<string, SelectorSpec> } | undefined): void {
  if (!next) {
    registry = undefined;
    return;
  }
  const built = clone();
  Object.assign(built.routes, next.routes ?? {});
  Object.assign(built.selectors, next.selectors ?? {});
  registry = built;
}

export function getSelector(id: string): SelectorSpec {
  const spec = current().selectors[id];
  if (!spec) throw new Error(`No selector is declared with the id "${id}"`);
  return spec;
}

export function getRoute(id: string): RouteSpec {
  const spec = current().routes[id];
  if (!spec) throw new Error(`No route is declared with the id "${id}"`);
  return spec;
}

export function isConfigured(id: string): boolean {
  const spec = current().selectors[id];
  return Boolean(spec && spec.value !== UNKNOWN);
}

export function isRouteConfigured(id: string): boolean {
  const spec = current().routes[id];
  return Boolean(spec && spec.path !== UNKNOWN);
}

/**
 * The gate every live workflow passes through before it touches a page.
 *
 * Reports every unmapped id at once, so someone running discovery gets the
 * whole list rather than finding them one failed job at a time.
 */
export function assertConfigured(input: {
  workflow: string;
  selectorIds: readonly string[];
  routeIds?: readonly string[];
}): void {
  const missingSelectors = input.selectorIds.filter((id) => !isConfigured(id));
  const missingRoutes = (input.routeIds ?? []).filter((id) => !isRouteConfigured(id));

  if (missingSelectors.length === 0 && missingRoutes.length === 0) return;

  throw errorFor('SELECTOR_NOT_CONFIGURED', {
    message:
      `I cannot run ${input.workflow} yet: ${missingSelectors.length + missingRoutes.length} part(s) of the ` +
      'Readymode interface it needs have not been mapped. An administrator has to run the discovery step first.',
    details: {
      workflow: input.workflow,
      missingSelectors,
      missingRoutes,
      overlayPath: current().overlayPath ?? env().READYMODE_SELECTOR_OVERLAY,
    },
  });
}

/** Coverage summary for the health view and the discovery script. */
export function coverage(): {
  total: number;
  configured: number;
  missing: string[];
  overlayPath: string | null;
} {
  const registryNow = current();
  const ids = [
    ...Object.keys(registryNow.routes).map((id) => ({ id, ok: registryNow.routes[id]?.path !== UNKNOWN })),
    ...Object.keys(registryNow.selectors).map((id) => ({ id, ok: registryNow.selectors[id]?.value !== UNKNOWN })),
  ];

  return {
    total: ids.length,
    configured: ids.filter((entry) => entry.ok).length,
    missing: ids.filter((entry) => !entry.ok).map((entry) => entry.id),
    overlayPath: registryNow.overlayPath,
  };
}
