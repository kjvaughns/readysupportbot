import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { logger } from '../../security/logger';
import { InterfaceProfileWithSelectors } from '../../database/store';
import { ALL_CONTROLS } from '../selectors';
import { serializeStrategy } from '../selectors/serialize';
import { invalidateProfileCache } from '../selectors/resolve';
import { ReadymodeSession } from '../session';
import { resolveCredentials } from '../credentials';
import { InterfaceEvidence } from './evidence';
import { discoverInterface } from './walk';
import { ProposedSelector, proposeSelectors, promotable } from './propose';

export * from './evidence';
export * from './propose';
export * from './walk';
export { inspectCurrentPage, buildEvidence } from './inspector';

/**
 * Interface discovery, end to end.
 *
 * Signs in, walks the real interface read-only, records what is there, proposes
 * selectors that the evidence can justify, and stores the result as a *proposed*
 * profile. Nothing is used for automation until an Owner approves it.
 */

export interface DiscoveryRunResult {
  profile: InterfaceProfileWithSelectors;
  visited: string[];
  skipped: Array<{ label: string; reason: string }>;
  proposals: ProposedSelector[];
  unproposed: Array<{ control: string; reason: string }>;
  evidenceSummary: {
    pages: number;
    roots: number;
    personalDataDropped: number;
    passwordFieldsSeen: number;
    truncatedCategories: string[];
  };
}

/** Guesses which Readymode interface this organization uses, from evidence only. */
export function detectInterfaceVersion(evidence: InterfaceEvidence): 'starter' | 'iq' | 'unknown' {
  const haystack = evidence.pages
    .flatMap((page) => [
      page.pageTitle,
      ...page.roots.flatMap((root) => [root.title, ...root.nav.map((entry) => entry.label)]),
    ])
    .join(' ')
    .toLowerCase();

  // Only claim iQ when the interface says so. Everything else stays unknown
  // rather than being asserted as Starter.
  if (/\breadymode\s*iq\b|\biq\s+dashboard\b|autopilot|local presence/.test(haystack)) return 'iq';
  if (/\breadymode\b/.test(haystack)) return 'starter';
  return 'unknown';
}

export async function runDiscovery(input: {
  session: ReadymodeSession;
  organizationId: string;
  discoveredBy: string | null;
  maxStops?: number;
}): Promise<DiscoveryRunResult> {
  const credentials = await resolveCredentials(input.organizationId);

  const walk = await discoverInterface(input.session, credentials.loginUrl, {
    maxStops: input.maxStops,
  });

  const { proposals, unproposed } = proposeSelectors(walk.evidence, ALL_CONTROLS);
  const usable = proposals.filter(promotable);

  logger.info(
    {
      organizationId: input.organizationId,
      pages: walk.evidence.pages.length,
      proposed: proposals.length,
      usable: usable.length,
      unproposed: unproposed.length,
    },
    'Interface discovery completed',
  );

  const profile = await getStore().createInterfaceProfile({
    profile: {
      organizationId: input.organizationId,
      schemaVersion: 1,
      baseUrl: walk.evidence.baseUrl,
      interfaceVersion: detectInterfaceVersion(walk.evidence),
      pagesCaptured: walk.evidence.pages.length,
      controlsTotal: ALL_CONTROLS.length,
      controlsProposed: usable.length,
      capabilities: [],
      unproposed,
      screenshotPaths: walk.evidence.pages
        .map((page) => page.screenshotPath)
        .filter((path): path is string => Boolean(path)),
      discoveredBy: input.discoveredBy,
      discoveredAt: new Date().toISOString(),
      notes: null,
    },
    selectors: proposals.map((proposal) => ({
      organizationId: input.organizationId,
      controlName: proposal.control,
      strategy: serializeStrategy(proposal.strategy),
      tier: proposal.tier,
      confidence: proposal.confidence,
      rootName: proposal.rootName,
      rootUrl: proposal.rootUrl,
      evidenceRef: {
        page: proposal.pageStep,
        category: proposal.evidence.category,
        ordinal: proposal.evidence.ordinal,
        excerpt: proposal.evidence.excerpt,
      },
      // "Verified" here means the evidence identifies exactly one element and
      // the proposal is strong enough to be used. It is not a claim that the
      // workflow has been run.
      verified: promotable(proposal),
      verifiedMatches: 1,
    })),
    evidence: walk.evidence,
  });

  await recordEvent({
    organizationId: input.organizationId,
    type: 'readymode.interface_discovered',
    message: `Interface discovery captured ${walk.evidence.pages.length} page(s) and proposed ${usable.length} of ${ALL_CONTROLS.length} controls.`,
    data: {
      profileId: profile.id,
      visited: walk.visited,
      unproposed: unproposed.map((entry) => entry.control),
    },
  });

  invalidateProfileCache(input.organizationId);

  return {
    profile,
    visited: walk.visited,
    skipped: walk.skipped,
    proposals,
    unproposed,
    evidenceSummary: {
      pages: walk.evidence.pages.length,
      roots: walk.evidence.pages.reduce((sum, page) => sum + page.roots.length, 0),
      personalDataDropped: walk.evidence.redactions.personalDataDropped,
      passwordFieldsSeen: walk.evidence.redactions.passwordFieldsSeen,
      truncatedCategories: walk.evidence.redactions.truncatedCategories,
    },
  };
}
