import { logger } from '../security/logger';
import { bankCoverage } from '../knowledge/bank';
import { seedKnowledgeBank, syncKnowledge } from '../knowledge/sync';
import { getStore } from '../database';

/**
 * The knowledge sync, as a command that runs inside the production container.
 *
 * `scripts/syncKnowledge.ts` needs tsx, which the production image does not
 * carry, so this compiles into `dist/` alongside everything else and runs with
 * plain node:
 *
 *   node dist/cli/knowledge.js status      what has actually been read
 *   node dist/cli/knowledge.js seed        store the supplied bank; no network
 *   node dist/cli/knowledge.js sync        seed, then fetch the real articles
 *   node dist/cli/knowledge.js sync 200    ...with a different article budget
 *
 * It reads the same environment the service does, so it works with no arguments
 * beyond the command.
 */

function usage(): void {
  process.stdout.write(
    [
      'Usage: node dist/cli/knowledge.js <command> [maxArticles]',
      '',
      '  status   report what has been read, without fetching anything',
      '  seed     store the supplied knowledge bank (no network)',
      '  sync     seed, then fetch and parse the real Help Center articles',
      '',
    ].join('\n'),
  );
}

async function status(): Promise<void> {
  const store = getStore();
  const coverage = bankCoverage();

  const [answerable, cataloged, failed, lastRun] = await Promise.all([
    store.listKnowledgeArticles({ statuses: ['normalized', 'fetched'], limit: 1000 }),
    store.listKnowledgeArticles({ statuses: ['cataloged'], limit: 1000 }),
    store.listKnowledgeArticles({ statuses: ['failed'], limit: 1000 }),
    store.latestKnowledgeSyncRun(),
  ]);

  process.stdout.write(
    [
      `Bank file:   ${coverage.folders} folders, ${coverage.articlesCataloged} articles cataloged, ` +
        `${coverage.articlesNormalized} with content`,
      `Stored:      ${answerable.length} answerable, ${cataloged.length} unread, ${failed.length} failed`,
      lastRun
        ? `Last sync:   ${lastRun.status} at ${lastRun.finishedAt ?? lastRun.startedAt} ` +
          `(${lastRun.articlesFetched} fetched, ${lastRun.articlesFailed} failed, ` +
          `complete pass: ${lastRun.completePass})`
        : 'Last sync:   never run',
      '',
    ].join('\n'),
  );

  if (coverage.articlesCataloged === 0) {
    process.stdout.write(
      'The bank file could not be read. Check that /app/data exists in this image.\n',
    );
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'sync';
  const budget = Number(process.argv[3] ?? process.env.KNOWLEDGE_MAX_ARTICLES ?? 200);

  if (command === 'help' || command === '--help') return usage();
  if (command === 'status') return status();

  if (command !== 'seed' && command !== 'sync') {
    usage();
    process.exitCode = 1;
    return;
  }

  const seeded = await seedKnowledgeBank();
  process.stdout.write(
    `Seeded ${seeded.folders} folders, ${seeded.normalized} article(s) with content, ` +
      `${seeded.cataloged} cataloged title(s).\n`,
  );

  if (command === 'seed') return;

  process.stdout.write(`Fetching up to ${budget} article(s) from help.readymode.com...\n`);
  const summary = await syncKnowledge({ maxArticles: budget });

  process.stdout.write(
    `Sync ${summary.status}: ${summary.articlesFetched} fetched, ${summary.articlesChanged} changed, ` +
      `${summary.articlesFailed} failed, complete pass: ${summary.completePass}.\n`,
  );

  for (const error of summary.errors.slice(0, 10)) {
    process.stderr.write(`  ${error.url}: ${error.reason}\n`);
  }
  if (summary.errors.length > 10) {
    process.stderr.write(`  ...and ${summary.errors.length - 10} more.\n`);
  }

  // A partial sync stored what it could read and said so. Only a run that read
  // nothing at all is a failure worth a non-zero exit.
  if (summary.status === 'failed') process.exitCode = 1;
}

main().catch((error) => {
  logger.error({ err: error }, 'Knowledge command failed');
  process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exit(1);
});
