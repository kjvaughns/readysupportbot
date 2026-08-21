import type { Locator, Page } from 'playwright-core';
import { logger } from '../security/logger';
import { sanitizePageValue } from '../security/sanitize';
import { LocatorRoot, listSearchRoots, rootName } from './selectors/frames';
import { countVisible } from './selectors/discovery';
import type { RootEvidence } from './discovery/evidence';
import { DASHBOARD_ROUTE, routeUrl } from './interface/registry';

/**
 * Navigating Readymode Starter.
 *
 * Two things are true at once here, and the code has to hold both.
 *
 * Starter does have routes. The read-only inspection recorded them —
 * `-Team/ManageUsers`, `+Team/ManageLicenses`, `-AI Leads/pools`,
 * `+Communication/Queue={id}` — and going to one opens that screen. So
 * navigation goes by route first: it is direct, and it does not depend on a
 * label being visible from wherever the session happens to be.
 *
 * But a route arriving is not the same as a screen opening. Starter renders
 * administrative screens as panels inside a shell, and a route that fails to
 * open one leaves the address looking exactly right. So arrival is never
 * confirmed by the URL. It is confirmed by the panel's own heading — "User
 * Management", "License Usage", "Lead Management", "Edit Queue", "Campaign
 * Settings", "Lead Playlist Editor" — which is the interface's own statement of
 * where the session is. When the route does not produce the heading, the exact
 * label is clicked instead, and the heading is checked again.
 *
 * Headings do a second job: they tell apart controls that share a label. A
 * "Save" inside the Lead Playlist Editor is not the "Save" inside Edit Queue,
 * and nothing but the surrounding panel says which is which.
 */

/** The screen every route starts from. */
export function appRootUrl(anyTenantUrl: string): string {
  try {
    return routeUrl(anyTenantUrl, DASHBOARD_ROUTE);
  } catch {
    return anyTenantUrl;
  }
}

/**
 * Goes to a route, then reports whether the expected screen actually appeared.
 *
 * The return value is deliberately not "did the navigation succeed". A legacy
 * shell answers 200 and renders its own error inside the page, so the only
 * useful question is whether the heading arrived.
 */
export async function gotoRoute(
  page: Page,
  route: string,
  expectHeadings: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OpenPanelResult> {
  let destination: string;
  try {
    destination = routeUrl(page.url(), route);
  } catch {
    return { opened: false, heading: null, reason: 'The organization base URL could not be read.' };
  }

  try {
    await page.goto(destination, { waitUntil: 'domcontentloaded' });
  } catch {
    return { opened: false, heading: null, reason: `The route ${route} could not be reached.` };
  }

  if (expectHeadings.length === 0) return { opened: true, heading: null };

  const heading = await waitForHeading(page, expectHeadings, options.timeoutMs ?? 12_000);
  if (heading) return { opened: true, heading };

  return {
    opened: false,
    heading: null,
    reason: `The route ${route} loaded but none of the expected headings appeared (${expectHeadings.join(', ')}).`,
  };
}

/**
 * Panel headings observed in the real interface.
 *
 * This list is the vocabulary of panel state. A heading that is not here is
 * still recorded as evidence; it simply does not identify a known panel.
 */
export const PANEL_HEADINGS = [
  // Specific screens first: `detectPanelState` returns the first match, and the
  // shell's own headings are the least informative answer to "where am I".
  'User Management',
  'License Usage',
  'Lead Management',
  'Edit Queue',
  'Campaign Settings',
  'Lead Playlist Editor',
  'Account Settings',
  'Activity Log',
  'Settings',
  'Dashboard',
] as const;

export type PanelHeading = (typeof PANEL_HEADINGS)[number];

/**
 * Elements that carry a panel's heading. Legacy markup rarely uses <h1>, so
 * title bars and legends are included.
 */
export const HEADING_SELECTOR =
  'h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption, .panel-title, .panelTitle, .ui-dialog-title';

/**
 * The only labels discovery is allowed to click, matched exactly.
 *
 * An allowlist of exact strings rather than a pattern: a pattern that admits
 * "Users" also admits "Delete Users", and the whole point of this walk is that
 * it cannot change anything. Every entry here was named by an operator as a
 * navigation control in the real interface.
 */
export const APPROVED_PANEL_LABELS = [
  'Users',
  'User Management',
  'License Usage',
  'Leads',
  'Lead Management',
  'View Lead Pool',
  'Queues',
  'Campaigns',
  'Members',
  'Configuration',
  'Account Settings',
] as const;

const APPROVED_LABEL_SET = new Set<string>(APPROVED_PANEL_LABELS.map((label) => label.toLowerCase()));

export function isApprovedPanelLabel(label: string): boolean {
  return APPROVED_LABEL_SET.has(sanitizePageValue(label, 60).trim().toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A heading element whose whole text is this heading. */
function exactHeadingPattern(heading: string): RegExp {
  return new RegExp(`^\\s*${escapeRegExp(heading)}\\s*$`, 'i');
}

/** A heading element that contains this heading among other text. */
function looseHeadingPattern(heading: string): RegExp {
  return new RegExp(escapeRegExp(heading), 'i');
}

async function headingVisible(
  root: LocatorRoot,
  heading: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const locator = root.locator(HEADING_SELECTOR).filter({ hasText: pattern });
    return (await countVisible(locator, timeoutMs)) > 0;
  } catch {
    return false;
  }
}

/**
 * How a screen was recognized, so an unconfirmed capture can be told from a
 * confirmed one rather than both looking the same.
 */
export type ArrivalEvidence = 'heading' | 'title' | 'none';

export interface Arrival {
  heading: string | null;
  evidence: ArrivalEvidence;
}

/**
 * Which of the given headings is on screen right now, across the page and every
 * frame. Exact matches are preferred over headings that merely contain the text,
 * so "Edit Queue" is not reported when the heading reads "Edit Queue Member".
 */
export async function findVisibleHeading(
  page: Page,
  headings: readonly string[],
  timeoutMs = 250,
): Promise<string | null> {
  const roots = listSearchRoots(page);

  for (const pattern of [exactHeadingPattern, looseHeadingPattern]) {
    for (const root of roots) {
      for (const heading of headings) {
        if (await headingVisible(root, heading, pattern(heading), timeoutMs)) return heading;
      }
    }
  }

  return null;
}

/**
 * Recognizes a screen by any of the things that actually identify one.
 *
 * A heading element first, because that is the strongest signal. Then the
 * document title, then the text itself anywhere on the page.
 *
 * The single-signal version of this is what broke discovery. It required an
 * <h1>-shaped element carrying the exact panel name; Readymode Starter does not
 * always render one, so every authenticated screen was judged not to have
 * opened, nothing past the login page was ever captured, and the resulting
 * profile resolved login controls and nothing else.
 */
export async function findArrival(
  page: Page,
  headings: readonly string[],
  timeoutMs = 250,
): Promise<Arrival> {
  const byHeading = await findVisibleHeading(page, headings, timeoutMs);
  if (byHeading) return { heading: byHeading, evidence: 'heading' };

  // The window title. Starter names the open screen there even when the panel
  // itself carries no heading element.
  const title = await page.title().catch(() => '');
  for (const heading of headings) {
    if (title && looseHeadingPattern(heading).test(title)) {
      return { heading, evidence: 'title' };
    }
  }

  /**
   * And that is where confirmation stops.
   *
   * A third tier — the screen's name as visible text anywhere — was tried and
   * removed. Starter's navigation carries a link reading "User Management", so
   * that tier confirmed the User Management screen while the session was still
   * on the dashboard. The result would be worse than not confirming: the
   * dashboard would be captured and labelled as User Management, and wrong
   * evidence is harder to notice than missing evidence.
   *
   * Not confirming costs nothing now, because the crawl inspects a screen
   * whether or not it could be confirmed. Confirmation says how much to trust
   * the capture; it no longer decides whether there is one.
   */
  return { heading: null, evidence: 'none' };
}

/** Which known panel is open right now, or null when none is. */
export async function currentPanelHeading(page: Page, timeoutMs = 250): Promise<string | null> {
  return findVisibleHeading(page, PANEL_HEADINGS, timeoutMs);
}

/**
 * Waits for one of the expected headings to appear.
 *
 * This replaces waiting for a URL change, which in Starter never comes: the
 * address is `/#` before the click and `/#` after it.
 */
export async function waitForHeading(
  page: Page,
  headings: readonly string[],
  timeoutMs = 12_000,
): Promise<string | null> {
  return (await waitForArrival(page, headings, timeoutMs)).heading;
}

export async function waitForArrival(
  page: Page,
  headings: readonly string[],
  timeoutMs = 12_000,
): Promise<Arrival> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const arrival = await findArrival(page, headings, 400);
    if (arrival.heading) return arrival;
    if (Date.now() >= deadline) return arrival;
    await page.waitForTimeout(250).catch(() => undefined);
  }
}

/** A label that resolved to exactly one visible element in exactly one root. */
export interface ResolvedLabel {
  locator: Locator;
  root: LocatorRoot;
  rootName: string;
  strategy: string;
}

/**
 * Finds a clickable carrying exactly this label.
 *
 * Legacy markup puts the label in a nested span, a title attribute or an image's
 * alt text as often as in the element's own text, so several strategies are
 * tried. The uniqueness rule is the same one the selector proposer uses: a
 * strategy wins only when it matches exactly one visible element in exactly one
 * root. Matching in two roots is ambiguity, and the next strategy is tried
 * rather than picking one at random.
 */
export async function findExactLabel(
  page: Page,
  label: string,
  timeoutMs = 800,
): Promise<ResolvedLabel | null> {
  const roots = listSearchRoots(page);
  const escaped = escapeRegExp(label);
  const attributeSelector = `[title="${label}"], [alt="${label}"], [aria-label="${label}"]`;

  const strategies: Array<{ name: string; build: (root: LocatorRoot) => Locator }> = [
    { name: `role=link[${label}]`, build: (root) => root.getByRole('link', { name: label, exact: true }) },
    { name: `role=button[${label}]`, build: (root) => root.getByRole('button', { name: label, exact: true }) },
    { name: `role=tab[${label}]`, build: (root) => root.getByRole('tab', { name: label, exact: true }) },
    { name: `text=${label}`, build: (root) => root.getByText(label, { exact: true }) },
    { name: `attr=${label}`, build: (root) => root.locator(attributeSelector) },
    {
      name: `text~=${label}`,
      build: (root) => root.getByText(new RegExp(`^\\s*${escaped}\\s*$`, 'i')),
    },
  ];

  for (const strategy of strategies) {
    const matches: ResolvedLabel[] = [];

    for (const [index, root] of roots.entries()) {
      let locator: Locator;
      try {
        locator = strategy.build(root);
      } catch {
        continue;
      }

      const visible = await countVisible(locator, timeoutMs).catch(() => 0);
      if (visible === 1) {
        matches.push({ locator, root, rootName: rootName(root, index), strategy: strategy.name });
      } else if (visible > 1) {
        // Ambiguous within one root — this strategy cannot identify the control.
        matches.push(
          { locator, root, rootName: rootName(root, index), strategy: strategy.name },
          { locator, root, rootName: rootName(root, index), strategy: strategy.name },
        );
      }
    }

    if (matches.length === 1) return matches[0];
  }

  return null;
}

export interface OpenPanelResult {
  opened: boolean;
  /** The heading that actually appeared, when one did. */
  heading: string | null;
  reason?: string;
}

/**
 * Opens a panel by clicking its exact label, then confirms it by heading.
 *
 * No URL is involved in either half: Starter neither accepts a route nor
 * changes its address when a panel opens.
 */
export async function openPanelByLabel(
  page: Page,
  label: string,
  expectHeadings: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OpenPanelResult> {
  if (!isApprovedPanelLabel(label)) {
    return { opened: false, heading: null, reason: `"${label}" is not an approved navigation label.` };
  }

  // Already there. Clicking again would close a toggling panel.
  if (expectHeadings.length > 0) {
    const already = await findVisibleHeading(page, expectHeadings, 250);
    if (already) return { opened: true, heading: already };
  }

  const target = await findExactLabel(page, label);
  if (!target) {
    return { opened: false, heading: null, reason: `"${label}" was not uniquely visible on screen.` };
  }

  try {
    await target.locator.click({ timeout: 8000 });
  } catch (error) {
    logger.debug({ label, err: error }, 'Panel navigation click failed');
    return { opened: false, heading: null, reason: `"${label}" could not be clicked.` };
  }

  if (expectHeadings.length === 0) return { opened: true, heading: null };

  const heading = await waitForHeading(page, expectHeadings, options.timeoutMs ?? 12_000);
  if (!heading) {
    return {
      opened: false,
      heading: null,
      reason: `Clicked "${label}" but none of the expected headings appeared (${expectHeadings.join(', ')}).`,
    };
  }

  return { opened: true, heading };
}

/** Controls that close a Starter panel, tried before falling back to a reload. */
const CLOSE_SELECTORS = [
  '.ui-dialog-titlebar-close',
  '[title="Close"]',
  '[aria-label="Close"]',
  'img[alt="Close"]',
  '.panel-close',
  '.closeButton',
];

/**
 * Returns to the application root between stops.
 *
 * Reloading after every stop is what a route-based walk does, and in a
 * single-page application it throws away the session's in-memory state and costs
 * a full application boot each time. Closing the panel is preferred; the reload
 * is the fallback for when no close control can be identified.
 */
export async function returnToAppRoot(
  page: Page,
  rootUrl: string,
): Promise<'closed' | 'reloaded' | 'failed'> {
  for (const root of listSearchRoots(page)) {
    for (const selector of CLOSE_SELECTORS) {
      let locator: Locator;
      try {
        locator = root.locator(selector);
      } catch {
        continue;
      }
      const visible = await countVisible(locator, 300).catch(() => 0);
      if (visible !== 1) continue;

      try {
        await locator.click({ timeout: 4000 });
        // Stabilization: the panel is gone when no known panel heading remains.
        const stillOpen = await currentPanelHeading(page, 300);
        if (!stillOpen) return 'closed';
      } catch {
        // Fall through to the reload.
      }
    }
  }

  try {
    await page.goto(rootUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => undefined);
    return 'reloaded';
  } catch {
    return 'failed';
  }
}

/**
 * One click in a walk through the interface.
 *
 * `nav` opens a panel from the application root, `tab` switches tabs inside the
 * panel that is already open, and `record` opens the first row of the panel's
 * table — the only way to reach a user's detail screen or a queue's editor,
 * since neither has a URL of its own.
 */
export interface PanelStep {
  kind: 'nav' | 'tab' | 'record';
  /** Exact visible label. Absent for a `record` step, which has no fixed label. */
  label?: string;
  /** Other exact labels the same destination is known by. */
  altLabels?: string[];
  /** The inspected route, when the screen has one. Tried before the label. */
  route?: string;
  /** Any one of these headings confirms the step arrived. */
  expectHeadings: string[];
  /** A step that may legitimately not exist; the route continues without it. */
  optional?: boolean;
  /** False for a step that only repeats a prefix already captured. */
  capture?: boolean;
}

export interface PanelRoute {
  id: string;
  description: string;
  steps: PanelStep[];
}

/**
 * The panels discovery walks, in order.
 *
 * Each route starts from the application root. Every label here is one an
 * operator named in the real interface, and every step states the heading that
 * proves it arrived — because the URL will say `/#` either way.
 */
export const STARTER_ROUTES: PanelRoute[] = [
  {
    id: 'users',
    description: 'User Management, one user record, and that record\'s Account Settings tab',
    steps: [
      {
        kind: 'nav',
        label: 'User Management',
        altLabels: ['Users'],
        route: '-Team/ManageUsers',
        expectHeadings: ['User Management'],
      },
      { kind: 'record', expectHeadings: ['Account Settings', 'Activity Log', 'User Management'] },
      { kind: 'tab', label: 'Account Settings', expectHeadings: ['Account Settings'], optional: true },
    ],
  },
  {
    id: 'licenses',
    description: 'License Usage, including the agent and admin licence tables',
    steps: [
      {
        kind: 'nav',
        label: 'License Usage',
        route: '+Team/ManageLicenses',
        expectHeadings: ['License Usage'],
      },
    ],
  },
  {
    id: 'queues',
    description: 'Lead Management, the Queues tab, and one queue\'s editor',
    steps: [
      {
        kind: 'nav',
        label: 'Lead Management',
        altLabels: ['Leads'],
        route: '-AI Leads/pools',
        expectHeadings: ['Lead Management'],
      },
      { kind: 'tab', label: 'Queues', expectHeadings: ['Lead Management'] },
      { kind: 'record', expectHeadings: ['Edit Queue'] },
      { kind: 'tab', label: 'Members', expectHeadings: ['Edit Queue'], optional: true },
      { kind: 'tab', label: 'Configuration', expectHeadings: ['Edit Queue'], optional: true },
    ],
  },
  {
    id: 'campaigns',
    description: 'The Campaigns tab of Lead Management',
    steps: [
      {
        kind: 'nav',
        label: 'Lead Management',
        altLabels: ['Leads'],
        route: '-AI Leads/pools',
        expectHeadings: ['Lead Management'],
        capture: false,
      },
      { kind: 'tab', label: 'Campaigns', expectHeadings: ['Lead Management', 'Campaign Settings'] },
    ],
  },
  {
    id: 'lead-pool',
    description: 'View Lead Pool, reached from the recent queues list',
    steps: [
      {
        kind: 'nav',
        label: 'View Lead Pool',
        expectHeadings: ['Edit Queue', 'Lead Playlist Editor', 'Lead Management'],
      },
    ],
  },
];

/**
 * Labels that must never be clicked while discovering, wherever they appear.
 *
 * A denylist, so an unrecognized label is not clicked unless it also matches the
 * navigation allowlist below. This is what keeps the walk read-only.
 */
export const UNSAFE_LABEL =
  /\b(save|submit|apply|update|create|add|new|delete|remove|purge|erase|drop|deactivate|disable|suspend|reset|clear|release|force|sign\s?out|log\s?out|logout|terminate|cancel|charge|refund|void|pay|billing|import|upload|export|send|dial|call|start|stop|pause|resume|merge|assign|unassign|archive|restore|confirm|continue|ok\b|yes\b|no\b)/i;

/** Labels that read as navigation into a section. */
export const NAVIGATION_LABEL =
  /\b(users?|agents?|licen[cs]e|leads?|campaigns?|queues?|playlists?|states?|settings?|admin|dashboard|reports?|voip|phones?|dispositions?|folders?|groups?|permissions?|applications?|options?|management|manager|members?|configuration|profile|home|iq|pool)\b/i;

/**
 * Whether a label found on screen is safe to click during discovery.
 *
 * The panel walk uses the stricter `isApprovedPanelLabel` — an exact allowlist.
 * This looser guard covers labels the walk merely *encountered* and had to judge.
 */
export function isSafeToClick(label: string): boolean {
  const value = sanitizePageValue(label, 80).trim();
  if (!value) return false;
  if (value.length > 60) return false;
  if (UNSAFE_LABEL.test(value)) return false;
  return NAVIGATION_LABEL.test(value);
}

/**
 * Opens the first record in the panel's table.
 *
 * A user's detail screen and a queue's editor have no label and no URL — they
 * are reached by clicking a row, and the row's text is somebody's name or a
 * queue's title. That text is used to decide whether the link is safe and is
 * then discarded: it is never logged, returned or stored.
 */
export async function openFirstRecord(
  page: Page,
  expectHeadings: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<OpenPanelResult> {
  for (const root of listSearchRoots(page)) {
    let rows: Locator;
    try {
      rows = root.locator('table').locator('tr');
    } catch {
      continue;
    }

    const total = Math.min(await rows.count().catch(() => 0), 25);

    for (let index = 0; index < total; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible().catch(() => false))) continue;

      const link = row.locator('td a').first();
      if ((await link.count().catch(() => 0)) === 0) continue;

      const label = sanitizePageValue(await link.innerText().catch(() => ''), 60).trim();
      if (!label || UNSAFE_LABEL.test(label)) continue;

      try {
        await link.click({ timeout: 8000 });
      } catch {
        continue;
      }

      const heading = await waitForHeading(page, expectHeadings, options.timeoutMs ?? 12_000);
      if (heading) return { opened: true, heading };

      return {
        opened: false,
        heading: null,
        reason: `Opened a record but none of the expected headings appeared (${expectHeadings.join(', ')}).`,
      };
    }
  }

  return { opened: false, heading: null, reason: 'No record row could be opened.' };
}

/**
 * A control inside the one row that belongs to a named user.
 *
 * The per-row "Sign Out" on License Usage cannot be a unique selector — there is
 * one in every row — so safety comes from the row instead: the row must contain
 * the identifier and must be the only row that does. A row identified by
 * position would sign out whoever happens to be sitting in that position, which
 * is exactly the mistake this prevents.
 */
export async function findControlInRow(
  page: Page,
  options: { scope?: string; rowIdentifier: string; label: string },
): Promise<ResolvedLabel | null> {
  const identifier = options.rowIdentifier.trim();
  if (!identifier) return null;

  const rowPattern = new RegExp(`(^|\\s|\\b)${escapeRegExp(identifier)}(\\b|\\s|$)`, 'i');
  const found: ResolvedLabel[] = [];

  for (const [index, root] of listSearchRoots(page).entries()) {
    let rows: Locator;
    try {
      rows = root.locator(options.scope ?? 'table').locator('tr').filter({ hasText: rowPattern });
    } catch {
      continue;
    }

    const matchingRows = await countVisible(rows, 800).catch(() => 0);
    if (matchingRows === 0) continue;
    if (matchingRows > 1) {
      // Two rows mention this user. Which one is meant is a question this code
      // cannot answer, so it does not try.
      return null;
    }

    const control = rows.first().getByText(options.label, { exact: true });
    const controlMatches = await countVisible(control, 800).catch(() => 0);
    if (controlMatches !== 1) continue;

    found.push({
      locator: control,
      root,
      rootName: rootName(root, index),
      strategy: `row[${options.label}]`,
    });
  }

  return found.length === 1 ? found[0] : null;
}

/**
 * Carries out one step of a walk: route first, then each label it is known by.
 *
 * Every attempt has to end with the expected heading on screen. A route that
 * loads without opening the screen counts as not having worked, and the next
 * approach is tried.
 */
export async function openStep(
  page: Page,
  step: PanelStep,
  options: { timeoutMs?: number } = {},
): Promise<OpenPanelResult> {
  const timeoutMs = options.timeoutMs ?? 12_000;
  if (step.kind === 'record') return openFirstRecord(page, step.expectHeadings, { timeoutMs });

  const already = await findVisibleHeading(page, step.expectHeadings, 250);
  if (already && step.kind === 'nav') return { opened: true, heading: already };

  if (step.route) {
    const byRoute = await gotoRoute(page, step.route, step.expectHeadings, {
      timeoutMs: Math.min(timeoutMs, 5000),
    });
    if (byRoute.opened) return byRoute;
  }

  let last: OpenPanelResult = {
    opened: false,
    heading: null,
    reason: 'The step named no label to click.',
  };

  for (const label of [step.label, ...(step.altLabels ?? [])].filter(Boolean) as string[]) {
    last = await openPanelByLabel(page, label, step.expectHeadings, { timeoutMs });
    if (last.opened) return last;
  }

  return last;
}

/** Known panels, by the label that opens them and the heading that confirms them. */
export type PanelId = 'users' | 'licenses' | 'leads' | 'queues' | 'campaigns';

export interface PanelTarget {
  label: string;
  headings: string[];
  /** The inspected route, when the screen has one of its own. */
  route?: string;
  /** A tab only exists once its panel is open. */
  parent?: PanelId;
}

export const PANELS: Record<PanelId, PanelTarget> = {
  users: {
    label: 'User Management',
    route: '-Team/ManageUsers',
    headings: ['User Management'],
  },
  licenses: {
    label: 'License Usage',
    route: '+Team/ManageLicenses',
    headings: ['License Usage'],
  },
  leads: {
    label: 'Lead Management',
    route: '-AI Leads/pools',
    headings: ['Lead Management'],
  },
  // Tabs, not screens: they have no route of their own and only exist once
  // Lead Management is open.
  queues: { label: 'Queues', headings: ['Lead Management', 'Edit Queue'], parent: 'leads' },
  campaigns: {
    label: 'Campaigns',
    headings: ['Lead Management', 'Campaign Settings'],
    parent: 'leads',
  },
};

/**
 * Opens a panel: by route when it has one, by its exact label when it does not
 * or when the route did not produce the expected heading.
 *
 * A tab's parent screen is opened first, because a tab does not exist until it
 * does.
 */
export async function openPanel(
  page: Page,
  panel: PanelId,
  options: { timeoutMs?: number } = {},
): Promise<OpenPanelResult> {
  const target = PANELS[panel];
  const timeoutMs = options.timeoutMs ?? 12_000;

  // Already open. Clicking again would toggle a panel shut.
  //
  // Deliberately the strict check: a navigation link reading "User Management"
  // is not the User Management screen, and the looser signals used to confirm
  // an arrival would mistake one for the other and skip the navigation.
  const already = await findVisibleHeading(page, target.headings, 250);
  if (already) return { opened: true, heading: already };

  if (target.parent) {
    const parent = await openPanel(page, target.parent, options);
    if (!parent.opened) return parent;
  }

  if (target.route) {
    // A shorter wait than the label attempt gets: a route either renders its
    // screen or it does not, and there is a second approach to try.
    const byRoute = await gotoRoute(page, target.route, target.headings, {
      timeoutMs: Math.min(timeoutMs, 5000),
    });
    if (byRoute.opened) return byRoute;
    logger.debug(
      { panel, route: target.route, reason: byRoute.reason },
      'Route did not open the panel; falling back to its label',
    );
  }

  const byLabel = await openPanelByLabel(page, target.label, target.headings, { timeoutMs });
  if (byLabel.opened) return byLabel;

  // A label that is not reachable from inside whichever panel happens to be
  // open usually is from the dashboard.
  await returnToAppRoot(page, appRootUrl(page.url()));

  if (target.parent) {
    const parent = await openPanel(page, target.parent, options);
    if (!parent.opened) return parent;
  }

  return openPanelByLabel(page, target.label, target.headings, { timeoutMs });
}

/**
 * The panel state named by evidence already collected.
 *
 * Pure, so the same rule that decides panel state during a walk can be tested
 * against a fixture.
 */
export function detectPanelState(roots: RootEvidence[]): string | null {
  const headings = roots.flatMap((root) => root.headings ?? []);

  for (const known of PANEL_HEADINGS) {
    if (headings.some((heading) => heading.text.trim().toLowerCase() === known.toLowerCase())) {
      return known;
    }
  }

  for (const known of PANEL_HEADINGS) {
    if (headings.some((heading) => heading.text.toLowerCase().includes(known.toLowerCase()))) {
      return known;
    }
  }

  return null;
}
