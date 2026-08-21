import type { Page } from 'playwright-core';
import { logger } from '../../security/logger';
import { sanitizePageValue } from '../../security/sanitize';
import { listSearchRoots } from '../selectors/frames';
import { ReadymodeSession, ensureAuthenticated } from '../session';
import { EVIDENCE_CAPS, InterfaceEvidence, PageEvidence } from './evidence';
import { buildEvidence, inspectCurrentPage } from './inspector';

/**
 * The read-only walk through the real Readymode interface.
 *
 * Discovery previously looked at exactly one page — whatever was on screen after
 * signing in — which is why controls that live on the users, campaigns and queue
 * screens were reported as missing, and why the login fields looked missing too:
 * by then they are gone from the DOM.
 *
 * This walks the interface instead, capturing evidence at each stop. It only
 * ever follows navigation. It never types, never submits, and never clicks
 * anything whose label suggests it changes data.
 */

/**
 * Labels that must never be clicked during discovery. This is the guard that
 * makes the walk safe: it is a denylist, so an unrecognized label is not clicked
 * unless it also matches the navigation allowlist below.
 */
const UNSAFE_LABEL =
  /\b(save|submit|apply|update|create|add|new|delete|remove|purge|erase|drop|deactivate|disable|suspend|reset|clear|release|force|sign\s?out|log\s?out|logout|terminate|cancel|charge|refund|void|pay|billing|import|upload|export|send|dial|call|start|stop|pause|resume|merge|assign|unassign|archive|restore|confirm|continue|ok\b|yes\b|no\b)/i;

/** Labels that read as navigation into a section. */
const NAVIGATION_LABEL =
  /\b(users?|agents?|licen[cs]e|leads?|campaigns?|queues?|playlists?|states?|settings?|admin|dashboard|reports?|voip|phones?|dispositions?|folders?|groups?|permissions?|applications?|options?|management|manager|profile|configuration|home|iq)\b/i;

export function isSafeToClick(label: string): boolean {
  const value = sanitizePageValue(label, 80).trim();
  if (!value) return false;
  if (value.length > 60) return false;
  if (UNSAFE_LABEL.test(value)) return false;
  return NAVIGATION_LABEL.test(value);
}

export interface WalkOptions {
  /** Maximum navigation stops, excluding the login and dashboard captures. */
  maxStops?: number;
  /** Whether to capture screenshots at each stop. */
  screenshots?: boolean;
}

export interface WalkResult {
  evidence: InterfaceEvidence;
  /** Navigation labels that were visited, in order. */
  visited: string[];
  /** Navigation labels that were skipped, with the reason. */
  skipped: Array<{ label: string; reason: string }>;
}

interface NavigationCandidate {
  label: string;
  rootIndex: number;
}

/** Collects clickable navigation labels from the captured evidence. */
function navigationCandidates(page: PageEvidence): NavigationCandidate[] {
  const seen = new Set<string>();
  const candidates: NavigationCandidate[] = [];

  page.roots.forEach((root, rootIndex) => {
    const labels = [
      ...root.nav.map((entry) => entry.label),
      ...root.links.filter((link) => link.visible).map((link) => link.label),
    ];

    for (const label of labels) {
      const clean = sanitizePageValue(label, 80).trim();
      if (!clean || seen.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      candidates.push({ label: clean, rootIndex });
    }
  });

  return candidates;
}

/**
 * Signs in, then walks. The login page is captured *before* authenticating,
 * which is the only moment the login controls exist.
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

  const { page } = session;

  // 1. The login page, before signing in.
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  pages.push(await inspectCurrentPage(page, 'login', counters, { screenshot: screenshots }));

  // 2. Sign in. This also handles the administrator session notice.
  await ensureAuthenticated(session);
  const dashboard = await inspectCurrentPage(page, 'dashboard', counters, { screenshot: screenshots });
  pages.push(dashboard);
  const dashboardUrl = page.url();

  // 3. Follow navigation, one stop at a time, returning to the dashboard between.
  const candidates = navigationCandidates(dashboard);

  for (const candidate of candidates) {
    if (visited.length >= maxStops) {
      skipped.push({ label: candidate.label, reason: 'Stop limit reached.' });
      continue;
    }
    if (!isSafeToClick(candidate.label)) {
      skipped.push({ label: candidate.label, reason: 'Not a recognized navigation label.' });
      continue;
    }

    const moved = await clickNavigation(page, candidate.label);
    if (!moved) {
      skipped.push({ label: candidate.label, reason: 'The navigation item could not be resolved uniquely.' });
      continue;
    }

    pages.push(
      await inspectCurrentPage(page, `nav:${candidate.label}`, counters, { screenshot: screenshots }),
    );
    visited.push(candidate.label);

    // Return to a known location so the next stop starts from the same place.
    await page.goto(dashboardUrl, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }

  return { evidence: buildEvidence(loginUrl, pages, counters), visited, skipped };
}

/**
 * Clicks one navigation label, but only when it resolves to exactly one visible
 * element across the page and its frames.
 */
async function clickNavigation(page: Page, label: string): Promise<boolean> {
  for (const root of listSearchRoots(page)) {
    let locator;
    try {
      locator = root.getByText(label, { exact: true });
    } catch {
      continue;
    }

    const count = await locator.count().catch(() => 0);
    if (count !== 1) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;

    try {
      await locator.click({ timeout: 8000 });
      await page.waitForLoadState('domcontentloaded').catch(() => undefined);
      return true;
    } catch (error) {
      logger.debug({ label, err: error }, 'Navigation click failed during discovery');
      return false;
    }
  }
  return false;
}
