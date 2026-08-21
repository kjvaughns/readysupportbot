import type { Frame, Page } from 'playwright-core';

/**
 * Frame handling.
 *
 * Readymode's legacy administration interface renders much of its content
 * inside frames. Playwright's `Page` and `Frame` expose the same locator API,
 * so every lookup in this codebase runs against a `LocatorRoot` — the page plus
 * each of its frames — instead of the top-level page alone.
 *
 * Searching only the top-level page is what made the connection test report
 * `login.username` and `login.password` as unresolved even though signing in
 * demonstrably worked: the fields exist, but not where the search was looking.
 */

export type LocatorRoot = Page | Frame;

/**
 * Frames that cannot hold application content.
 *
 * `about:srcdoc` is deliberately NOT here: a srcdoc frame carries inline
 * content by definition, and skipping it loses whatever is inside.
 *
 * A frame populated by `document.write` keeps the URL `about:blank` and is
 * still excluded, because including every blank frame costs a lookup timeout
 * per candidate. If a legacy interface turns out to build frames that way, the
 * `frames` list in the discovery report will show them and this is the line to
 * revisit.
 */
const IGNORED_URLS = new Set(['about:blank', '']);

/** Upper bound on how many roots are searched, so a frame bomb cannot stall a run. */
export const MAX_SEARCH_ROOTS = 25;

export function isPage(root: LocatorRoot): root is Page {
  return typeof (root as Page).context === 'function';
}

/** The URL of a root, used for evidence and for reporting where a control was found. */
export function rootUrl(root: LocatorRoot): string {
  try {
    return root.url();
  } catch {
    return '';
  }
}

/** A stable, human-readable name for a root. */
export function rootName(root: LocatorRoot, index: number): string {
  if (isPage(root)) return 'page';
  const name = (root as Frame).name();
  return name ? `frame:${name}` : `frame#${index}`;
}

/**
 * The page and every usable frame, main frame first.
 *
 * Detached and blank frames are dropped: they cannot hold content, and querying
 * a detached frame throws.
 */
export function listSearchRoots(page: Page): LocatorRoot[] {
  const roots: LocatorRoot[] = [page];

  let frames: Frame[] = [];
  try {
    frames = page.frames();
  } catch {
    return roots;
  }

  for (const frame of frames) {
    if (roots.length >= MAX_SEARCH_ROOTS) break;
    try {
      if (frame.isDetached()) continue;
      // The main frame is already covered by the page itself.
      if (frame === page.mainFrame()) continue;
      if (IGNORED_URLS.has(frame.url())) continue;
      roots.push(frame);
    } catch {
      // A frame that throws while being inspected is not usable.
    }
  }

  return roots;
}

/**
 * Visible text across the page and every frame.
 *
 * Workflow verification used to read `page.innerText('body')`, which returns
 * nothing useful when the content lives in a frame. Every check that asks "does
 * this page mention X" has to look everywhere X could be.
 */
export async function allText(page: Page, limitPerRoot = 20000): Promise<string> {
  const parts: string[] = [];

  for (const root of listSearchRoots(page)) {
    try {
      const text = await root.innerText('body', { timeout: 2000 });
      if (text) parts.push(text.slice(0, limitPerRoot));
    } catch {
      // A root without a body, or one that navigated mid-read, contributes nothing.
    }
  }

  return parts.join('\n');
}
