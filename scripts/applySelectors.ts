#!/usr/bin/env tsx
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { scrubPersonalData } from '../src/security/personalData';
import { deserializeStrategy } from '../src/readymode/selectors/serialize';
import { PROMOTION_THRESHOLD } from '../src/readymode/discovery/propose';

/**
 * Regenerates src/readymode/selectors/observed.generated.ts from a real
 * discovery report.
 *
 *   npm run selectors:apply evidence/<report>.json
 *   npm run selectors:apply evidence/<report>.json -- --check
 *
 * Fetch the report from GET /api/readymode/profiles/:id/report as an Owner and
 * commit it under evidence/ so the selectors in git can be traced back to the
 * capture they came from.
 *
 * The script refuses to emit anything the evidence does not justify: unverified
 * controls, low-confidence proposals, structural css-path fallbacks, and any
 * report that still contains personal data.
 */

interface ReportSelector {
  control: string;
  strategy: Record<string, unknown>;
  tier: string;
  confidence: number;
  rootName: string;
  rootUrl: string;
  verified: boolean;
}

interface Report {
  reportId: string;
  capturedAt: string;
  host: string;
  selectors: ReportSelector[];
}

export interface BuildResult {
  source: string;
  emitted: string[];
  skipped: Array<{ control: string; reason: string }>;
}

/** Pure core, so the rules are unit-testable without touching the filesystem. */
export function buildObservedModule(report: Report, sha256: string): BuildResult {
  const emitted: string[] = [];
  const skipped: Array<{ control: string; reason: string }> = [];
  const entries: string[] = [];

  // A report that still carries personal data must never be committed.
  // Structural mode: a report is full of identifiers and UUIDs, so only genuine
  // personal-data shapes count — a digit run inside an id is not a leak.
  const serialized = JSON.stringify(report);
  if (scrubPersonalData(serialized, { structural: true }).dropped.length > 0) {
    throw new Error(
      'The report contains something that looks like personal data. It was not written. ' +
        'Re-run discovery: evidence is scrubbed before storage, so this should not happen.',
    );
  }

  for (const selector of [...report.selectors].sort((a, b) => a.control.localeCompare(b.control))) {
    if (!selector.verified) {
      skipped.push({ control: selector.control, reason: 'Not verified against the interface.' });
      continue;
    }
    if (selector.confidence < PROMOTION_THRESHOLD) {
      skipped.push({
        control: selector.control,
        reason: `Confidence ${selector.confidence} is below the ${PROMOTION_THRESHOLD} threshold.`,
      });
      continue;
    }
    if (selector.tier === 'css-path') {
      skipped.push({
        control: selector.control,
        reason: 'Structural css-path selectors are too brittle to commit.',
      });
      continue;
    }

    try {
      deserializeStrategy(selector.strategy);
    } catch (error) {
      skipped.push({
        control: selector.control,
        reason: error instanceof Error ? error.message : 'Unreadable strategy.',
      });
      continue;
    }

    emitted.push(selector.control);
    entries.push(
      `  ${JSON.stringify(selector.control)}: {\n` +
        `    strategy: ${JSON.stringify(selector.strategy)} as unknown as SelectorStrategy,\n` +
        `    tier: ${JSON.stringify(selector.tier)},\n` +
        `    confidence: ${selector.confidence},\n` +
        `    rootName: ${JSON.stringify(selector.rootName)},\n` +
        `    rootUrl: ${JSON.stringify(selector.rootUrl)},\n` +
        `  },`,
    );
  }

  const source = `import { SelectorStrategy } from './index';

/**
 * GENERATED FILE — do not edit by hand.
 *
 * Written by \`npm run selectors:apply\` from a discovery report captured against
 * a real Readymode interface. Every entry below was observed; nothing here is a
 * guess. Controls absent from this file were not identified uniquely, which is
 * reported rather than filled in.
 */

export interface ObservedSelector {
  strategy: SelectorStrategy;
  tier: string;
  confidence: number;
  rootName: string;
  rootUrl: string;
}

export const OBSERVED_SOURCE: {
  reportId: string;
  capturedAt: string;
  sha256: string;
  host: string;
} | null = {
  reportId: ${JSON.stringify(report.reportId)},
  capturedAt: ${JSON.stringify(report.capturedAt)},
  sha256: ${JSON.stringify(sha256)},
  host: ${JSON.stringify(report.host)},
};

export const OBSERVED_SELECTORS: Record<string, ObservedSelector> = {
${entries.join('\n')}
};
`;

  return { source, emitted, skipped };
}

const TARGET = resolve(__dirname, '../src/readymode/selectors/observed.generated.ts');

function main(): void {
  const args = process.argv.slice(2).filter((arg) => arg !== '--');
  const check = args.includes('--check');
  const path = args.find((arg) => !arg.startsWith('--'));

  if (!path) {
    process.stderr.write('Usage: npm run selectors:apply <report.json> [-- --check]\n');
    process.exit(1);
  }

  const raw = readFileSync(resolve(path), 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const result = buildObservedModule(JSON.parse(raw) as Report, sha256);

  if (check) {
    const current = readFileSync(TARGET, 'utf8');
    if (current !== result.source) {
      process.stderr.write('observed.generated.ts is out of date with the report.\n');
      process.exit(1);
    }
    process.stdout.write('observed.generated.ts matches the report.\n');
    return;
  }

  writeFileSync(TARGET, result.source, 'utf8');

  process.stdout.write(`Wrote ${result.emitted.length} observed selector(s).\n`);
  for (const control of result.emitted) process.stdout.write(`  kept    ${control}\n`);
  for (const entry of result.skipped) {
    process.stdout.write(`  skipped ${entry.control}: ${entry.reason}\n`);
  }
}

if (require.main === module) main();
