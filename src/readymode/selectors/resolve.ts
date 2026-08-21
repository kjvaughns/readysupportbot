import type { Page } from 'playwright-core';
import { getStore } from '../../database';
import { logger } from '../../security/logger';
import { ControlDefinition, SelectorStrategy } from './index';
import { ControlSource } from './capabilities';
import { OBSERVED_SELECTORS } from './observed.generated';
import { inspectedStrategyFor } from '../interface/registry';
import { tryDeserializeStrategy } from './serialize';

/**
 * Where a selector is allowed to come from, in order:
 *
 *   1. the organization's active, Owner-approved discovery profile,
 *   2. the committed selectors generated from a real discovery report,
 *   3. the interface registry, transcribed from the read-only inspection,
 *   4. the built-in candidates — which are guesses, and are treated as such.
 *
 * Order is strongest evidence first, and each tier is tagged with where it came
 * from so a report can say honestly how a control was found.
 *
 * Everything below the first tier is useful for *finding* things and for
 * read-only work. None of it authorizes a change: `capabilities.ts` requires an
 * Owner-approved profile before a modifying capability counts as usable, so
 * neither a guess nor an inspection can click Save on its own.
 */

export interface ResolvedProfile {
  organizationId: string;
  profileId: string | null;
  byControl: Map<string, { strategy: SelectorStrategy; source: ControlSource; confidence: number }>;
  loadedAt: number;
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, ResolvedProfile>();

export function invalidateProfileCache(organizationId?: string): void {
  if (organizationId) cache.delete(organizationId);
  else cache.clear();
}

/** Loads the active approved profile, layering the committed file beneath it. */
export async function loadProfile(organizationId: string): Promise<ResolvedProfile> {
  const cached = cache.get(organizationId);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  const byControl = new Map<
    string,
    { strategy: SelectorStrategy; source: ControlSource; confidence: number }
  >();

  // Committed observations first, so an approved profile can override them.
  for (const [control, observed] of Object.entries(OBSERVED_SELECTORS)) {
    byControl.set(control, {
      strategy: observed.strategy,
      source: 'observed_file',
      confidence: observed.confidence,
    });
  }

  let profileId: string | null = null;
  try {
    const profile = await getStore().getActiveInterfaceProfile(organizationId);
    if (profile) {
      profileId = profile.id;
      for (const selector of profile.selectors) {
        // A profile stores every proposal, including the weak ones, so a person
        // can see what discovery considered. Only the ones discovery judged
        // strong enough become usable selectors — approving a profile approves
        // its verified selectors, not everything it happened to record.
        if (selector.verified === false) continue;

        const strategy = tryDeserializeStrategy(selector.strategy);
        if (!strategy) {
          logger.warn(
            { control: selector.controlName, organizationId },
            'Stored selector could not be read and was ignored',
          );
          continue;
        }
        byControl.set(selector.controlName, {
          strategy,
          source: 'approved_profile',
          confidence: selector.confidence,
        });
      }
    }
  } catch (error) {
    // A database problem must not silently downgrade to guesses without a trace.
    logger.error({ err: error, organizationId }, 'Could not load the interface profile');
  }

  const resolved: ResolvedProfile = {
    organizationId,
    profileId,
    byControl,
    loadedAt: Date.now(),
  };
  cache.set(organizationId, resolved);
  return resolved;
}

/** Binds a profile to a page so `discover(page, control)` needs no new argument. */
const boundProfiles = new WeakMap<Page, ResolvedProfile>();

export function bindProfile(page: Page, profile: ResolvedProfile): void {
  boundProfiles.set(page, profile);
}

export function profileFor(page: Page): ResolvedProfile | null {
  return boundProfiles.get(page) ?? null;
}

export interface TaggedStrategy {
  strategy: SelectorStrategy;
  source: ControlSource;
}

/**
 * The ordered candidates discovery walks, each tagged with where it came from,
 * so the report can say honestly how a control was found.
 */
export function candidateStrategiesFor(
  control: ControlDefinition,
  page: Page | null,
): TaggedStrategy[] {
  const tagged: TaggedStrategy[] = [];
  const profile = page ? profileFor(page) : null;
  const known = profile?.byControl.get(control.name);

  if (known) tagged.push({ strategy: known.strategy, source: known.source });

  // Transcribed from the read-only inspection. Only present for controls that
  // were actually seen — a control the Help Center merely describes contributes
  // nothing here.
  const inspected = inspectedStrategyFor(control.name);
  if (inspected) tagged.push({ strategy: inspected.strategy, source: 'interface_map' });

  for (const candidate of control.candidates) {
    tagged.push({ strategy: candidate, source: 'builtin' });
  }

  return tagged;
}
