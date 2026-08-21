import 'dotenv/config';
import { logger } from '../src/security/logger';
import { seedKnowledgeBank, syncKnowledge } from '../src/knowledge/sync';

/**
 * Loads the Help Center into the knowledge bank.
 *
 *   npm run knowledge:seed   store the supplied bank: 13 articles with content,
 *                            134 titles with none
 *   npm run knowledge:sync   fetch and parse the real articles
 *
 * Seeding needs no network and is safe to re-run. Syncing reaches
 * help.readymode.com, so it runs where that is reachable — on Railway, not from
 * a sandbox with no egress.
 */

async function main(): Promise<void> {
  const seedOnly = process.argv.includes('--seed-only');
  const maxArticles = Number(process.env.KNOWLEDGE_MAX_ARTICLES ?? 200);

  const seeded = await seedKnowledgeBank();
  process.stdout.write(
    `Seeded ${seeded.folders} folders, ${seeded.normalized} articles with content, ` +
      `${seeded.cataloged} cataloged titles.\n`,
  );

  if (seedOnly) return;

  const summary = await syncKnowledge({ maxArticles });

  process.stdout.write(
    `Sync ${summary.status}: ${summary.articlesFetched} fetched, ` +
      `${summary.articlesChanged} changed, ${summary.articlesFailed} failed, ` +
      `complete pass: ${summary.completePass}.\n`,
  );

  for (const error of summary.errors.slice(0, 10)) {
    process.stderr.write(`  ${error.url}: ${error.reason}\n`);
  }

  // A partial sync is not a failed command: it stored what it could read, and
  // said so. Only a run that read nothing at all is an error.
  if (summary.status === 'failed') process.exitCode = 1;
}

main().catch((error) => {
  logger.error({ err: error }, 'Knowledge sync failed');
  process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
  process.exit(1);
});
