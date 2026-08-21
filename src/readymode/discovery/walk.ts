import { logger } from '../../security/logger';
import { sanitizePageValue } from '../../security/sanitize';
import { LOGIN_SUCCESS_CONDITIONS } from '../selectors';
import { anyPresent } from '../selectors/discovery';
import {
  OpenPanelResult,
  PanelStep,
  STARTER_ROUTES,
  appRootUrl,
  currentPanelHeading,
  isApprovedPanelLabel,
  openStep,
  returnToAppRoot,
} from '../navigation';
import { ReadymodeSession, ensureAuthenticated } from '../session';
import { EVIDENCE_CAPS, InterfaceEvidence, PageEvidence } from './evidence';
import { buildEvidence, inspectCurrentPage } from './inspector';

/**
 * The read-only walk through the real Readymode Starter interface.
 *
 * Starter is a single-page application. After signing in the address stays at
 * `https://<tenant>.readymode.com/#`, and every administrative screen — User
 * Management, License Usage, Lead Management, Edit Queue, the Lead Playlist
 * Editor — opens as a movable panel inside that page.
 *
 * Two consequences shape this file. There is nowhere to navigate to, so each
 * stop is reached by clicking an exact, named label. And there is no URL change
 * to wait for, so each stop is confirmed by the panel's own heading. Between
 * routes the panel is closed rather than the page reloaded, because reloading a
 * single-page application discards its state and pays for a full boot.
 *
 * The walk only ever opens screens. It never types, never submits, and never
 * clicks anything whose label suggests it changes data.
 */

// The looser guard lives with the navigation model, next to the exact
// allowlist it complements. Re-exported because it is the walk's safety rule.
export { isSafeToClick } from '../navigation';

export interface WalkOptions {
  /** Maximum evidence captures, excluding the login and dashboard captures. */
  maxStops?: number;
  /** Whether to capture screenshots at each stop. */
  screenshots?: boolean;
}

/** One attempt to open one panel, and what actually happened. */
export interface PanelVisit {
  route: string;
  kind: PanelStep['kind'];
  /** The label clicked, or `(first record)` for a row that has no fixed label. */
  step: string;
  /** The heading the step expected. */
  expectedHeading: string | null;
  /** The heading that actually appeared. */
  observedHeading: string | null;
  opened: boolean;
  captured: boolean;
  reason?: string;
}

export interface WalkResult {
  evidence: InterfaceEvidence;
  /** Stops that produced evidence, in order. */
  visited: string[];
  /** Routes and labels that were not followed, with the reason. */
  skipped: Array<{ label: string; reason: string }>;
  /** Every panel attempt: expected heading against observed heading. */
  panels: PanelVisit[];
  /**
   * False when the login URL went straight to the dashboard because the
   * persistent Browserbase session was still signed in. The login controls are
   * then simply not on screen — that is not a discovery failure.
   */
  loginPageObserved: boolean;
}

/** Navigation labels visible on the dashboard, for the skipped report. */
function observedNavigationLabels(page: PageEvidence): string[] {
  const seen = new Set<string>();

  for (const root of page.roots) {
    const labels = [
      ...root.nav.map((entry) => entry.label),
      ...root.links.filter((link) => link.visible).map((link) => link.label),
      ...root.clickables.filter((entry) => entry.visible).map((entry) => entry.label),
    ];

    for (const label of labels) {
      const clean = sanitizePageValue(label, 80).trim();
      if (clean) seen.add(clean);
    }
  }

  return [...seen];
}

/**
 * Signs in, then walks the panels. The login page is captured *before*
 * authenticating, which is the only moment the login controls exist.
 */
export async function discoverInterface(
  session: ReadymodeSession,
  loginUrl: string,
  options: WalkOptions = {},
): Promise<WalkResult> {
  const maxStops = Math.min(options.maxStops ?? 12, EVIDENCE_CAPS.maxPages - 2);
  const screenshots = options.screenshots !== false;
  const counters = { personalDataDropped: 0, passwordFieldsSeen: 0 };

  const pages: PageEvidence[] = [];
  const visited: string[] = [];
  const skipped: Array<{ label: string; reason: string }> = [];
  const panels: PanelVisit[] = [];

  const { page } = session;

  // 1. The login page, before signing in — the only moment the login controls
  //    exist. A persistent session that is still signed in redirects straight
  //    to the dashboard, in which case there is no login form to observe.
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  const loginPageObserved = !(await anyPresent(page, LOGIN_SUCCESS_CONDITIONS, 1500));

  pages.push(
    await inspectCurrentPage(page, loginPageObserved ? 'login' : 'already-signed-in', counters, {
      screenshot: screenshots,
    }),
  );

  if (!loginPageObserved) {
    logger.info('The Browserbase session was already signed in, so the login page was not shown.');
  }

  // 2. Sign in. This also handles the administrator session notice.
  await ensureAuthenticated(session);
  const dashboard = await inspectCurrentPage(page, 'dashboard', counters, { screenshot: screenshots });
  pages.push(dashboard);

  // Everything from here happens at this one address.
  const appRoot = appRootUrl(page.url());

  for (const label of observedNavigationLabels(dashboard).slice(0, 40)) {
    if (!isApprovedPanelLabel(label)) {
      skipped.push({ label, reason: 'Not one of the approved navigation labels.' });
    }
  }

  // 3. Walk the panels. Each route starts from the application root and is
  //    confirmed at every step by the heading the interface shows.
  let captured = 0;

  for (const route of STARTER_ROUTES) {
    if (captured >= maxStops) {
      skipped.push({ label: route.id, reason: 'Stop limit reached.' });
      continue;
    }

    for (const step of route.steps) {
      const stepLabel = step.label ?? '(first record)';
      const expected = step.expectHeadings[0] ?? null;

      const result: OpenPanelResult = await openStep(page, step);

      const visit: PanelVisit = {
        route: route.id,
        kind: step.kind,
        step: stepLabel,
        expectedHeading: expected,
        observedHeading: result.heading,
        opened: result.opened,
        captured: false,
        reason: result.reason,
      };

      if (!result.opened) {
        panels.push(visit);
        if (step.optional) continue;
        skipped.push({
          label: `${route.id}/${stepLabel}`,
          reason: result.reason ?? 'The step did not open.',
        });
        break;
      }

      if (step.capture !== false && captured < maxStops) {
        pages.push(
          await inspectCurrentPage(page, `panel:${route.id}/${stepLabel}`, counters, {
            screenshot: screenshots,
            expectedPanelState: expected,
          }),
        );
        captured += 1;
        visited.push(`${route.id}/${stepLabel}`);
        visit.captured = true;
      }

      panels.push(visit);
    }

    // Close the panel rather than reloading. A reload works, but it throws away
    // the single-page application's state and costs a full boot each time.
    const returned = await returnToAppRoot(page, appRoot);
    if (returned === 'failed') {
      logger.warn({ route: route.id }, 'Could not return to the application root after a route');
    }
  }

  const endedOn = await currentPanelHeading(page, 300);
  if (endedOn) {
    logger.debug({ panel: endedOn }, 'A panel was still open when the walk finished');
  }

  return {
    evidence: buildEvidence(loginUrl, pages, counters),
    visited,
    skipped,
    panels,
    loginPageObserved,
  };
}
