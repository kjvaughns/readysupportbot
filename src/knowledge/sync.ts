import { getStore } from '../database';
import { logger } from '../security/logger';
import { KnowledgeArticle, SyncRunSummary } from './types';
import { bankFolders, catalogedArticles, normalizedArticles } from './bank';
import {
  HelpCenterCrawler,
  SOLUTIONS_INDEX,
  articleLinksIn,
  folderLinksIn,
  isAllowedUrl,
  nextPageIn,
  normalizeUrl,
} from './crawler';
import { ArticleParseError, detectProduct, parseArticle, toKnowledgeArticle } from './parser';

/**
 * Bringing the Help Center into the knowledge bank.
 *
 * Two stages, and the difference between them is the whole point.
 *
 * Seeding stores what the supplied bank already knows: thirteen articles with
 * real content, and every other article as a title and a folder with nothing
 * else. Those carry `cataloged`, and nothing answers from them — writing
 * instructions from a title is inventing them.
 *
 * Syncing fetches each real article, parses it, and stores what the page
 * actually said. Only then does an article become answerable. An article whose
 * fetch or parse fails keeps whatever it had and is marked `failed`, because
 * losing good content to a bad network is worse than a stale answer with a date
 * on it.
 */

export interface SyncOptions {
  /** Cap on articles fetched in one run, so a first run can be a small one. */
  maxArticles?: number;
  delayMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Fetch even when the stored hash matches. */
  force?: boolean;
}

/** Loads the supplied bank into storage. Safe to re-run. */
export async function seedKnowledgeBank(): Promise<{
  folders: number;
  normalized: number;
  cataloged: number;
}> {
  const store = getStore();

  const folders = bankFolders();
  await store.upsertKnowledgeFolders(folders);

  const normalized = normalizedArticles();
  for (const article of normalized) await store.upsertKnowledgeArticle(article);

  // Every other article the catalog names. No URL yet — the catalog lists
  // titles, and the synchronizer resolves each against its folder page. Stored
  // so the gap between "known to exist" and "actually read" is countable.
  const pending = catalogedArticles();
  for (const entry of pending) {
    const placeholderUrl = `${entry.folderUrl}#${encodeURIComponent(entry.articleTitle)}`;
    await store.upsertKnowledgeArticle({
      articleUrl: placeholderUrl,
      category: entry.category,
      folder: entry.folder,
      articleTitle: entry.articleTitle,
      lastUpdated: null,
      supportedUserRole: [],
      product: detectProduct(entry.articleTitle, entry.folder),
      summary: '',
      stepByStepInstructions: [],
      warnings: [],
      troubleshooting: [],
      relatedArticles: [],
      sourceCitations: [entry.folderUrl],
      syncStatus: 'cataloged',
      contentHash: null,
      fetchedAt: null,
    });
  }

  logger.info(
    { folders: folders.length, normalized: normalized.length, cataloged: pending.length },
    'Knowledge bank seeded',
  );

  return { folders: folders.length, normalized: normalized.length, cataloged: pending.length };
}

/** Every article URL the Help Center currently lists, folder by folder. */
export async function discoverArticleUrls(
  crawler: HelpCenterCrawler,
  options: { maxFolders?: number } = {},
): Promise<{ urls: string[]; folders: string[]; complete: boolean; errors: SyncRunSummary['errors'] }> {
  const errors: SyncRunSummary['errors'] = [];
  const urls = new Set<string>();
  let complete = true;

  let index;
  try {
    index = await crawler.fetchPage(SOLUTIONS_INDEX);
  } catch (error) {
    return {
      urls: [],
      folders: [],
      complete: false,
      errors: [{ url: SOLUTIONS_INDEX, reason: reasonOf(error) }],
    };
  }

  if (index.status >= 400) {
    // The index is where every folder comes from. Without it the pass saw
    // nothing, and a pass that saw nothing must never conclude that everything
    // has been removed.
    return {
      urls: [],
      folders: [],
      complete: false,
      errors: [{ url: SOLUTIONS_INDEX, reason: `HTTP ${index.status}` }],
    };
  }

  const folders = folderLinksIn(index.html, SOLUTIONS_INDEX).slice(0, options.maxFolders ?? 100);

  // An index that lists no folders is a parse failure, not an empty Help Center.
  if (folders.length === 0) {
    complete = false;
    errors.push({ url: SOLUTIONS_INDEX, reason: 'no folder links were found on the index page' });
  }

  for (const folder of folders) {
    let pageUrl: string | null = folder;
    let guard = 0;

    while (pageUrl && guard < 20) {
      guard += 1;
      try {
        const page = await crawler.fetchPage(pageUrl);
        for (const url of articleLinksIn(page.html, pageUrl)) urls.add(url);
        pageUrl = nextPageIn(page.html, pageUrl);
      } catch (error) {
        // One folder failing does not make the pass complete, and an
        // incomplete pass may never conclude that an article was removed.
        complete = false;
        errors.push({ url: pageUrl ?? folder, reason: reasonOf(error) });
        break;
      }
    }
  }

  return { urls: [...urls], folders, complete, errors };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}

/**
 * Fetches and parses the real articles.
 *
 * Never writes an article it did not read. A fetch that fails, a page that
 * cannot be parsed, or a body that comes back empty all leave the stored
 * article as it was and record why.
 */
export async function syncKnowledge(options: SyncOptions = {}): Promise<SyncRunSummary> {
  const store = getStore();
  const startedAt = new Date().toISOString();

  const crawler = new HelpCenterCrawler({
    delayMs: options.delayMs ?? 1000,
    maxPages: (options.maxArticles ?? 200) + 60,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const summary: SyncRunSummary = {
    startedAt,
    finishedAt: null,
    status: 'running',
    foldersSeen: 0,
    articlesSeen: 0,
    articlesFetched: 0,
    articlesChanged: 0,
    articlesFailed: 0,
    completePass: false,
    errors: [],
  };

  const discovery = await discoverArticleUrls(crawler);
  summary.foldersSeen = discovery.folders.length;
  summary.articlesSeen = discovery.urls.length;
  summary.errors.push(...discovery.errors);
  summary.completePass = discovery.complete;

  const known = await store.listKnowledgeArticles({ limit: 1000 });
  const byUrl = new Map(known.map((article) => [article.articleUrl, article]));

  const folderOf = new Map<string, { folder: string; category: string }>();
  for (const folder of await store.listKnowledgeFolders()) {
    folderOf.set(folder.url, { folder: folder.folder, category: folder.category });
  }

  for (const url of discovery.urls.slice(0, options.maxArticles ?? 200)) {
    if (!isAllowedUrl(url)) continue;

    const existing = byUrl.get(normalizeUrl(url));

    try {
      const page = await crawler.fetchPage(url, {
        etag: options.force ? null : undefined,
        lastModified: options.force ? null : existing?.fetchedAt ?? null,
      });

      if (page.notModified) continue;
      if (page.status >= 400) {
        summary.articlesFailed += 1;
        summary.errors.push({ url, reason: `HTTP ${page.status}` });
        await markFailed(existing, url, `HTTP ${page.status}`);
        continue;
      }

      const parsed = parseArticle(page.html, url);
      const article = toKnowledgeArticle(parsed, {
        url: normalizeUrl(url),
        category: existing?.category ?? '',
        folder: existing?.folder ?? '',
        product: detectProduct(`${parsed.title} ${parsed.summary}`, existing?.folder ?? ''),
        fetchedAt: new Date().toISOString(),
      });

      const result = await store.upsertKnowledgeArticle(article);
      summary.articlesFetched += 1;
      if (result.changed) summary.articlesChanged += 1;
    } catch (error) {
      summary.articlesFailed += 1;
      summary.errors.push({ url, reason: reasonOf(error) });
      if (!(error instanceof ArticleParseError)) summary.completePass = false;
      await markFailed(existing, url, reasonOf(error));
    }
  }

  summary.finishedAt = new Date().toISOString();
  summary.status =
    summary.articlesFailed === 0 && summary.completePass
      ? 'succeeded'
      : summary.articlesFetched > 0
        ? 'partial'
        : 'failed';

  await store.recordKnowledgeSyncRun(summary);
  logger.info({ ...summary, errors: summary.errors.length }, 'Help Center sync finished');

  return summary;
}

/** Records why an article could not be read, keeping whatever it already had. */
async function markFailed(
  existing: KnowledgeArticle | undefined,
  url: string,
  reason: string,
): Promise<void> {
  if (!existing) return;
  await getStore().upsertKnowledgeArticle({
    ...existing,
    // Content that was good yesterday is better than nothing today, so it stays
    // exactly as it was — only the status and the reason change.
    syncStatus: 'failed',
    lastError: reason.slice(0, 300),
  });
  logger.warn({ url, reason }, 'Help Center article could not be read');
}
