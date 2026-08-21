import type { Locator, Page } from 'playwright-core';
import { logger } from '../../security/logger';
import { WorkflowNeedsConfigurationError } from '../../security/errors';
import { ControlDefinition, SelectorStrategy } from './index';
import { LocatorRoot, listSearchRoots, rootName, rootUrl } from './frames';
import { CapabilityStatus, ControlSource, ControlStatus, capabilityStatuses } from './capabilities';
import { candidateStrategiesFor } from './resolve';

/**
 * Selector discovery.
 *
 * Readymode's markup is not assumed. Each control is resolved by trying its
 * candidate strategies in order, across the page and every frame, and accepting
 * the first that matches exactly one visible element in exactly one root.
 *
 * A control that resolves to zero elements, or to more than one, or to elements
 * in two different frames, is treated as unidentified: the workflow stops safely
 * and reports that it needs configuration instead of acting on a guess.
 */

export interface DiscoveryHit {
  control: string;
  strategy: string;
  /** Elements that are visible to a user. */
  matches: number;
  /**
   * Elements present in the DOM, visible or not. Reported so the two failure
   * modes are distinguishable: `matches: 0, attached: 2` means hidden
   * duplicates, while `matches: 1` in a non-main frame means framing.
   */
  attached: number;
  resolved: boolean;
  /** Where the strategy came from: an approved profile, the committed file, or a guess. */
  source: ControlSource;
  /** Which root the match was found in, when there was one. */
  root?: string;
  rootUrl?: string;
  note?: string;
}

/** A control that was found, together with the evidence of where it was found. */
export interface ResolvedControl {
  locator: Locator;
  root: LocatorRoot;
  rootName: string;
  rootUrl: string;
  strategy: string;
  source: ControlSource;
  matches: number;
}

export function describeStrategy(strategy: SelectorStrategy): string {
  switch (strategy.type) {
    case 'testId':
      return `testId=${strategy.value}`;
    case 'role':
      return `role=${strategy.role}${strategy.name ? `[name=${String(strategy.name)}]` : ''}`;
    case 'label':
      return `label=${String(strategy.value)}`;
    case 'placeholder':
      return `placeholder=${String(strategy.value)}`;
    case 'text':
      return `text=${String(strategy.value)}`;
    case 'css':
      return `css=${strategy.value}`;
    default:
      return 'unknown';
  }
}

export function locatorFor(root: LocatorRoot, strategy: SelectorStrategy): Locator {
  switch (strategy.type) {
    case 'testId':
      return root.getByTestId(strategy.value);
    case 'role':
      return root.getByRole(strategy.role as never, {
        ...(strategy.name ? { name: strategy.name } : {}),
        ...(strategy.exact !== undefined ? { exact: strategy.exact } : {}),
      });
    case 'label':
      return root.getByLabel(
        strategy.value,
        strategy.exact !== undefined ? { exact: strategy.exact } : undefined,
      );
    case 'placeholder':
      return root.getByPlaceholder(strategy.value);
    case 'text':
      return root.getByText(
        strategy.value,
        strategy.exact !== undefined ? { exact: strategy.exact } : undefined,
      );
    case 'css':
      return root.locator(strategy.value);
    default:
      return root.locator('__readysupport_no_match__');
  }
}

/** How many elements a locator matches that are actually visible to a user. */
const MAX_COUNTED = 20;

export interface MatchCount {
  visible: number;
  attached: number;
}

/**
 * Counts matches, separating visible from merely attached.
 *
 * Counting attached elements — which is what this did before — made a legacy
 * interface's hidden duplicate panels look like ambiguity, so controls that were
 * perfectly resolvable were reported unresolved. Only visible elements decide a
 * match; the attached count is kept purely as diagnostic evidence.
 */
export async function countMatches(locator: Locator, timeoutMs: number): Promise<MatchCount> {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    return { visible: 0, attached: 0 };
  }

  let attached = 0;
  try {
    attached = await locator.count();
  } catch {
    return { visible: 0, attached: 0 };
  }
  if (attached === 0) return { visible: 0, attached: 0 };

  // Beyond this many matches the control is ambiguous whatever the answer is,
  // so there is no point paying for a visibility round trip per element.
  if (attached > MAX_COUNTED) return { visible: attached, attached };

  let visible = 0;
  for (let index = 0; index < attached; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) visible += 1;
  }
  return { visible, attached };
}

/** Back-compatible helper: visible matches only. */
export async function countVisible(locator: Locator, timeoutMs: number): Promise<number> {
  return (await countMatches(locator, timeoutMs)).visible;
}

export interface DiscoveryOptions {
  /** Time allowed per candidate, per root. Kept short — many are tried. */
  timeoutMs?: number;
  /** Accept the first element when a candidate matches several. Off by default. */
  allowFirstOfMany?: boolean;
  /** Restrict the search to one root, used when a control must stay in context. */
  roots?: LocatorRoot[];
}

export interface DiscoveryResult {
  resolved: ResolvedControl | null;
  hits: DiscoveryHit[];
}

/**
 * Attempts to resolve a control without throwing.
 *
 * Each candidate is tried against every root before moving to the next
 * candidate, so a specific strategy in a frame beats a vague one on the page.
 */
export async function tryDiscover(
  page: Page,
  control: ControlDefinition,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? 1200;
  const roots = options.roots ?? listSearchRoots(page);
  const hits: DiscoveryHit[] = [];

  for (const { strategy, source } of candidateStrategiesFor(control, page)) {
    const described = describeStrategy(strategy);
    const matchesByRoot: Array<{
      root: LocatorRoot;
      name: string;
      locator: Locator;
      count: MatchCount;
    }> = [];
    let attachedTotal = 0;

    for (const [index, root] of roots.entries()) {
      let locator: Locator;
      try {
        locator = locatorFor(root, strategy);
      } catch (error) {
        hits.push({
          control: control.name,
          strategy: described,
          matches: 0,
          attached: 0,
          resolved: false,
          source,
          root: rootName(root, index),
          note: error instanceof Error ? error.message : 'Invalid strategy.',
        });
        continue;
      }

      const count = await countMatches(locator, timeoutMs);
      attachedTotal += count.attached;
      if (count.visible > 0) {
        matchesByRoot.push({ root, name: rootName(root, index), locator, count });
      }
    }

    if (matchesByRoot.length === 0) {
      hits.push({
        control: control.name,
        strategy: described,
        matches: 0,
        attached: attachedTotal,
        resolved: false,
        source,
        note:
          attachedTotal > 0
            ? `Present but not visible in any frame (attached=${attachedTotal}).`
            : undefined,
      });
      continue;
    }

    // The same control matching in two frames is ambiguity, not a match. Acting
    // on the first would mean picking a panel at random.
    if (matchesByRoot.length > 1) {
      hits.push({
        control: control.name,
        strategy: described,
        matches: matchesByRoot.reduce((sum, entry) => sum + entry.count.visible, 0),
        attached: attachedTotal,
        resolved: false,
        source,
        note: `Ambiguous: visible in ${matchesByRoot.length} frames (${matchesByRoot
          .map((entry) => entry.name)
          .join(', ')}).`,
      });
      continue;
    }

    const only = matchesByRoot[0];
    if (only.count.visible === 1 || (only.count.visible > 1 && options.allowFirstOfMany)) {
      hits.push({
        control: control.name,
        strategy: described,
        matches: only.count.visible,
        attached: attachedTotal,
        resolved: true,
        source,
        root: only.name,
        rootUrl: rootUrl(only.root),
      });
      return {
        resolved: {
          locator: only.count.visible === 1 ? only.locator : only.locator.first(),
          root: only.root,
          rootName: only.name,
          rootUrl: rootUrl(only.root),
          strategy: described,
          source,
          matches: only.count.visible,
        },
        hits,
      };
    }

    hits.push({
      control: control.name,
      strategy: described,
      matches: only.count.visible,
      attached: attachedTotal,
      resolved: false,
      source,
      root: only.name,
      note: 'Ambiguous: more than one visible element matched.',
    });
  }

  return { resolved: null, hits };
}

/** Resolves a control with its frame context, or stops the workflow. */
export async function discoverResolved(
  page: Page,
  control: ControlDefinition,
  options: DiscoveryOptions = {},
): Promise<ResolvedControl> {
  const result = await tryDiscover(page, control, options);
  if (result.resolved) return result.resolved;

  logger.warn(
    { control: control.name, attempts: result.hits.map((hit) => `${hit.strategy}:${hit.matches}`) },
    'Control could not be identified',
  );
  throw new WorkflowNeedsConfigurationError(control.description);
}

/** Resolves a control to a locator. Kept for callers that do not need the frame. */
export async function discover(
  page: Page,
  control: ControlDefinition,
  options: DiscoveryOptions = {},
): Promise<Locator> {
  return (await discoverResolved(page, control, options)).locator;
}

/** True when any of the given signals is present on the page or in any frame. */
export async function anyPresent(
  page: Page,
  strategies: SelectorStrategy[],
  timeoutMs = 1000,
): Promise<boolean> {
  const roots = listSearchRoots(page);

  for (const strategy of strategies) {
    for (const root of roots) {
      try {
        const count = await countVisible(locatorFor(root, strategy), timeoutMs);
        if (count > 0) return true;
      } catch {
        // A malformed strategy simply does not match.
      }
    }
  }
  return false;
}

/**
 * Full discovery report. Surfaced through POST /api/readymode/test so an
 * operator can see exactly which controls ReadySupport can and cannot find, and
 * — just as importantly — whether a match came from real evidence or from a
 * built-in guess.
 */
export async function discoveryReport(
  page: Page,
  controls: ControlDefinition[],
  options: DiscoveryOptions = {},
): Promise<{
  resolved: string[];
  unresolved: string[];
  controls: ControlStatus[];
  capabilities: CapabilityStatus[];
  hits: DiscoveryHit[];
  roots: Array<{ name: string; url: string }>;
}> {
  const roots = listSearchRoots(page);
  const hits: DiscoveryHit[] = [];
  const statuses: ControlStatus[] = [];
  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const control of controls) {
    const result = await tryDiscover(page, control, { timeoutMs: 800, ...options, roots });
    hits.push(...result.hits);

    if (result.resolved) {
      resolved.push(control.name);
      statuses.push({
        control: control.name,
        required: control.required,
        state: 'verified',
        source: result.resolved.source,
        strategy: result.resolved.strategy,
        root: result.resolved.rootName,
        rootUrl: result.resolved.rootUrl,
        visibleMatches: result.resolved.matches,
        attachedMatches: result.hits[result.hits.length - 1]?.attached ?? result.resolved.matches,
      });
      continue;
    }

    if (control.required) unresolved.push(control.name);

    // Distinguish "not there at all" from "there but ambiguous" — they need
    // different fixes, and saying only "unresolved" hides that.
    const ambiguous = result.hits.some((hit) => hit.note?.startsWith('Ambiguous'));
    const attached = result.hits.reduce((max, hit) => Math.max(max, hit.attached), 0);

    statuses.push({
      control: control.name,
      required: control.required,
      state: ambiguous ? 'ambiguous' : 'missing',
      source: 'none',
      visibleMatches: 0,
      attachedMatches: attached,
      note: result.hits.find((hit) => hit.note)?.note,
    });
  }

  return {
    resolved,
    unresolved,
    controls: statuses,
    capabilities: capabilityStatuses(statuses),
    hits,
    roots: roots.map((root, index) => ({ name: rootName(root, index), url: rootUrl(root) })),
  };
}
