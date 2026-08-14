import type { Locator, Page } from 'playwright-core';
import { logger } from '../../security/logger';
import { WorkflowNeedsConfigurationError } from '../../security/errors';
import { ControlDefinition, SelectorStrategy } from './index';

/**
 * Selector discovery.
 *
 * Readymode's markup is not assumed. Each control is resolved by trying its
 * candidate strategies in order and accepting the first that matches exactly
 * one visible element. A control that resolves to zero elements, or to more
 * than one, is treated as unidentified: the workflow stops safely and reports
 * that it needs configuration instead of acting on a guess.
 */

export interface DiscoveryHit {
  control: string;
  strategy: string;
  matches: number;
  resolved: boolean;
  note?: string;
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

function locatorFor(page: Page, strategy: SelectorStrategy): Locator {
  switch (strategy.type) {
    case 'testId':
      return page.getByTestId(strategy.value);
    case 'role':
      return page.getByRole(strategy.role as never, {
        ...(strategy.name ? { name: strategy.name } : {}),
        ...(strategy.exact !== undefined ? { exact: strategy.exact } : {}),
      });
    case 'label':
      return page.getByLabel(strategy.value, strategy.exact !== undefined ? { exact: strategy.exact } : undefined);
    case 'placeholder':
      return page.getByPlaceholder(strategy.value);
    case 'text':
      return page.getByText(strategy.value, strategy.exact !== undefined ? { exact: strategy.exact } : undefined);
    case 'css':
      return page.locator(strategy.value);
    default:
      return page.locator('__readysupport_no_match__');
  }
}

async function countVisible(locator: Locator, timeoutMs: number): Promise<number> {
  try {
    await locator.first().waitFor({ state: 'attached', timeout: timeoutMs });
  } catch {
    return 0;
  }
  try {
    return await locator.count();
  } catch {
    return 0;
  }
}

export interface DiscoveryOptions {
  /** Time allowed per candidate. Kept short — several are usually tried. */
  timeoutMs?: number;
  /** Accept the first element when a candidate matches several. Off by default. */
  allowFirstOfMany?: boolean;
}

export interface DiscoveryResult {
  locator: Locator | null;
  hits: DiscoveryHit[];
  strategy?: string;
}

/** Attempts to resolve a control without throwing. */
export async function tryDiscover(
  page: Page,
  control: ControlDefinition,
  options: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const hits: DiscoveryHit[] = [];

  for (const strategy of control.candidates) {
    const described = describeStrategy(strategy);
    let locator: Locator;
    try {
      locator = locatorFor(page, strategy);
    } catch (error) {
      hits.push({
        control: control.name,
        strategy: described,
        matches: 0,
        resolved: false,
        note: error instanceof Error ? error.message : 'Invalid strategy.',
      });
      continue;
    }

    const matches = await countVisible(locator, timeoutMs);

    if (matches === 1 || (matches > 1 && options.allowFirstOfMany)) {
      hits.push({ control: control.name, strategy: described, matches, resolved: true });
      return { locator: matches === 1 ? locator : locator.first(), hits, strategy: described };
    }

    hits.push({
      control: control.name,
      strategy: described,
      matches,
      resolved: false,
      note: matches > 1 ? 'Ambiguous: more than one element matched.' : undefined,
    });
  }

  return { locator: null, hits };
}

/** Resolves a control or stops the workflow. */
export async function discover(
  page: Page,
  control: ControlDefinition,
  options: DiscoveryOptions = {},
): Promise<Locator> {
  const result = await tryDiscover(page, control, options);
  if (result.locator) return result.locator;

  logger.warn(
    { control: control.name, attempts: result.hits.map((hit) => `${hit.strategy}:${hit.matches}`) },
    'Control could not be identified',
  );
  throw new WorkflowNeedsConfigurationError(control.description);
}

/** True when any of the given signals is present on the page. */
export async function anyPresent(
  page: Page,
  strategies: SelectorStrategy[],
  timeoutMs = 1200,
): Promise<boolean> {
  for (const strategy of strategies) {
    try {
      const locator = locatorFor(page, strategy);
      const count = await countVisible(locator, timeoutMs);
      if (count > 0) return true;
    } catch {
      // A malformed strategy simply does not match.
    }
  }
  return false;
}

/**
 * Full discovery report. Surfaced through POST /api/readymode/test so an
 * operator can see exactly which controls ReadySupport can and cannot find
 * before enabling live changes.
 */
export async function discoveryReport(
  page: Page,
  controls: ControlDefinition[],
  options: DiscoveryOptions = {},
): Promise<{ resolved: string[]; unresolved: string[]; hits: DiscoveryHit[] }> {
  const hits: DiscoveryHit[] = [];
  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const control of controls) {
    const result = await tryDiscover(page, control, { timeoutMs: 800, ...options });
    hits.push(...result.hits);
    if (result.locator) resolved.push(control.name);
    else if (control.required) unresolved.push(control.name);
  }

  return { resolved, unresolved, hits };
}
