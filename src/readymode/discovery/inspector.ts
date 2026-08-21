import type { Page } from 'playwright-core';
import { sanitizePageValue } from '../../security/sanitize';
import { scrubDeep, scrubPersonalData } from '../../security/personalData';
import { LocatorRoot, listSearchRoots, rootName, rootUrl } from '../selectors/frames';
import { captureScreenshot } from '../session';
import { collectFromRoot } from './collector';
import {
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

interface CollectorOutput {
  title: string;
  childFrameUrls: string[];
  [key: string]: unknown;
  truncated: string[];
  passwordFieldsSeen: number;
}

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
    truncated: (scrubbed.truncated as string[]) ?? [],
  };
}

/** Captures the current location, across the page and every frame. */
export async function inspectCurrentPage(
  page: Page,
  step: string,
  counters: { personalDataDropped: number; passwordFieldsSeen: number },
  options: { screenshot?: boolean } = {},
): Promise<PageEvidence> {
  const roots = listSearchRoots(page);
  const collected: RootEvidence[] = [];

  for (const [index, root] of roots.entries()) {
    try {
      const raw = (await root.evaluate(collectFromRoot as never, {
        caps: EVIDENCE_CAPS,
        stableAttributes: STABLE_ATTRIBUTES,
      } as never)) as CollectorOutput;
      collected.push(normalizeRoot(root, index, raw, counters));
    } catch (error) {
      // A cross-origin or torn-down frame is recorded, never fatal.
      collected.push({
        rootName: rootName(root, index),
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
        truncated: [],
        error: error instanceof Error ? error.message.slice(0, 200) : 'Root could not be read.',
      });
    }
  }

  const screenshotPath = options.screenshot === false ? null : await captureScreenshot(page, `discovery-${step}`);

  return {
    step,
    pageUrl: sanitizePageValue(page.url(), EVIDENCE_CAPS.maxUrlLength),
    pageTitle: scrubPersonalData(sanitizePageValue(await page.title().catch(() => ''), 200)).text,
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
