import type { Page } from 'playwright-core';
import { sanitizePageValue } from '../../security/sanitize';
import { logger } from '../../security/logger';
import { scrubDeep, scrubPersonalData } from '../../security/personalData';
import { LocatorRoot, listSearchRoots, rootName, rootUrl } from '../selectors/frames';
import { detectPanelState } from '../navigation';
import { captureScreenshot } from '../session';
import { collectFromRoot } from './collector';
import {
  CollectorOutput,
  EVIDENCE_CAPS,
  InterfaceEvidence,
  PageEvidence,
  RootEvidence,
  STABLE_ATTRIBUTES,
  emptyRedactions,
  enforceSizeCap,
} from './evidence';

/**
 * Read-only inspection of the real Readymode interface.
 *
 * Everything here observes. Nothing clicks, types, submits, or navigates — the
 * caller decides where to look, and this reports what is there. The collector
 * that runs inside the browser reads attributes, text and computed styles only;
 * it never touches `.value`, `.checked`, cookies or storage.
 */

/** Sanitizes and scrubs everything one root returned. */
function normalizeRoot(
  root: LocatorRoot,
  index: number,
  raw: CollectorOutput,
  counters: { personalDataDropped: number; passwordFieldsSeen: number },
): RootEvidence {
  counters.passwordFieldsSeen += raw.passwordFieldsSeen ?? 0;

  // Two passes, in order: neutralize page text, then remove personal data.
  const sanitized = JSON.parse(
    JSON.stringify(raw, (_key, value) =>
      typeof value === 'string' ? sanitizePageValue(value, EVIDENCE_CAPS.maxTextLength) : value,
    ),
  );
  // Structural keys (id, name, cssPath) keep their shape; content is scrubbed.
  const dropCounter = { dropped: 0 };
  const scrubbed = scrubDeep(sanitized, dropCounter) as CollectorOutput;
  counters.personalDataDropped += dropCounter.dropped;

  return {
    rootName: rootName(root, index),
    rootUrl: sanitizePageValue(rootUrl(root), EVIDENCE_CAPS.maxUrlLength),
    isMain: index === 0,
    title: String(scrubbed.title ?? ''),
    childFrameUrls: (scrubbed.childFrameUrls as string[]) ?? [],
    nav: (scrubbed.nav as RootEvidence['nav']) ?? [],
    buttons: (scrubbed.buttons as RootEvidence['buttons']) ?? [],
    inputs: (scrubbed.inputs as RootEvidence['inputs']) ?? [],
    selects: (scrubbed.selects as RootEvidence['selects']) ?? [],
    checkboxes: (scrubbed.checkboxes as RootEvidence['checkboxes']) ?? [],
    links: (scrubbed.links as RootEvidence['links']) ?? [],
    forms: (scrubbed.forms as RootEvidence['forms']) ?? [],
    tables: (scrubbed.tables as RootEvidence['tables']) ?? [],
    clickables: (scrubbed.clickables as RootEvidence['clickables']) ?? [],
    headings: (scrubbed.headings as RootEvidence['headings']) ?? [],
    truncated: (scrubbed.truncated as string[]) ?? [],
  };
}

/** Captures the current location, across the page and every frame. */
export async function inspectCurrentPage(
  page: Page,
  step: string,
  counters: { personalDataDropped: number; passwordFieldsSeen: number },
  options: { screenshot?: boolean; expectedPanelState?: string | null } = {},
): Promise<PageEvidence> {
  const roots = listSearchRoots(page);
  const collected: RootEvidence[] = [];

  let failedRoots = 0;

  for (const [index, root] of roots.entries()) {
    const name = rootName(root, index);
    try {
      // One object argument, matching what `page.evaluate` actually passes.
      // No casts: if the shapes ever diverge again, this stops compiling.
      const raw = await root.evaluate(collectFromRoot, {
        caps: EVIDENCE_CAPS,
        stableAttributes: STABLE_ATTRIBUTES,
      });
      collected.push(normalizeRoot(root, index, raw, counters));
    } catch (error) {
      failedRoots += 1;
      const detail = sanitizePageValue(
        error instanceof Error ? error.message : 'Root could not be read.',
        200,
      );

      // Recorded *and* logged. Silently collecting nothing looks identical to a
      // page that genuinely has nothing on it, which is how a broken collector
      // went unnoticed.
      logger.warn({ step, root: name, rootUrl: rootUrl(root), detail }, 'Evidence collection failed for a root');

      collected.push({
        rootName: name,
        rootUrl: sanitizePageValue(rootUrl(root), EVIDENCE_CAPS.maxUrlLength),
        isMain: index === 0,
        title: '',
        childFrameUrls: [],
        nav: [],
        buttons: [],
        inputs: [],
        selects: [],
        checkboxes: [],
        links: [],
        forms: [],
        tables: [],
        clickables: [],
        headings: [],
        truncated: [],
        error: detail,
      });
    }
  }

  if (failedRoots > 0) {
    logger.warn(
      { step, failedRoots, totalRoots: roots.length },
      'Some roots produced no evidence',
    );
  }

  const screenshotPath = options.screenshot === false ? null : await captureScreenshot(page, `discovery-${step}`);

  return {
    step,
    pageUrl: sanitizePageValue(page.url(), EVIDENCE_CAPS.maxUrlLength),
    pageTitle: scrubPersonalData(sanitizePageValue(await page.title().catch(() => ''), 200)).text,
    // Starter keeps one URL for the whole session, so where the session is has
    // to come from the panel's own heading. The URL above says `/#` on every
    // screen and identifies nothing.
    panelState: detectPanelState(collected),
    expectedPanelState: options.expectedPanelState ?? null,
    roots: collected,
    screenshotPath,
  };
}

export function buildEvidence(baseUrl: string, pages: PageEvidence[], counters: {
  personalDataDropped: number;
  passwordFieldsSeen: number;
}): InterfaceEvidence {
  const redactions = emptyRedactions();
  redactions.personalDataDropped = counters.personalDataDropped;
  redactions.passwordFieldsSeen = counters.passwordFieldsSeen;
  redactions.truncatedCategories = [
    ...new Set(pages.flatMap((page) => page.roots.flatMap((root) => root.truncated))),
  ];

  return enforceSizeCap({
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    baseUrl: sanitizePageValue(baseUrl, EVIDENCE_CAPS.maxUrlLength),
    pages,
    redactions,
  });
}
