import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../security/logger';
import {
  KnowledgeArticle,
  KnowledgeBankFile,
  KnowledgeFolder,
  knowledgeBankSchema,
} from './types';

/**
 * The supplied knowledge bank: the starting point the synchronizer works from.
 *
 * It carries two different things, and conflating them would be the mistake.
 * A handful of articles are fully normalized — summary, steps, warnings,
 * troubleshooting, citations — and those can be answered from today. The rest
 * is a catalog: 38 folders and every article title, with no content. Cataloged
 * articles are stored so the synchronizer knows what to go and fetch, and they
 * are never answered from, because instructions written from a title are
 * invented instructions.
 */

const BANK_PATH = join(__dirname, '..', '..', 'data', 'readysupport_knowledge_bank.json');

let cached: KnowledgeBankFile | null = null;

/**
 * Reads the bank from disk.
 *
 * A missing file is reported and treated as an empty bank rather than thrown.
 * The service should start and say it has no documentation, not fail to start —
 * every other capability is independent of this one, and a deployment that
 * forgot to ship `data/` should be diagnosable from `/api/readymode/capabilities`
 * rather than from a crash loop.
 */
export function loadKnowledgeBank(path = BANK_PATH): KnowledgeBankFile {
  if (cached) return cached;

  try {
    cached = knowledgeBankSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    logger.error(
      { path, err: error instanceof Error ? error.message : 'unreadable' },
      'The Help Center knowledge bank could not be read; ReadySupport has no documentation loaded',
    );
    cached = knowledgeBankSchema.parse({
      schema_version: '0',
      generated_at: new Date(0).toISOString(),
      source_home: 'https://help.readymode.com/support/home',
      source_index: 'https://help.readymode.com/support/solutions',
    });
  }

  return cached;
}

/** For tests that load a different file. */
export function resetKnowledgeBankCache(): void {
  cached = null;
}

/** SHA-256 over the content that would be quoted, ignoring formatting. */
export function contentHash(article: {
  articleTitle: string;
  summary: string;
  stepByStepInstructions: string[];
  warnings: string[];
  troubleshooting: string[];
}): string {
  const normalized = [
    article.articleTitle,
    article.summary,
    ...article.stepByStepInstructions,
    ...article.warnings,
    ...article.troubleshooting,
  ]
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  return createHash('sha256').update(normalized).digest('hex');
}

/** The category a folder belongs to, from the bank's own grouping. */
function categoryForFolder(bank: KnowledgeBankFile, folder: string): string {
  const found = bank.categories.find((entry) => entry.folders.includes(folder));
  return found?.category ?? '';
}

/**
 * Reconciles an article's folder name with the folder catalog's.
 *
 * The two disagree for Readymode iQ: an article says its folder is "Advanced"
 * while the catalog calls the same folder "Readymode iQ Advanced". Left alone,
 * those articles belong to no folder, and the coverage count quietly claims two
 * more articles are missing than actually are.
 */
export function resolveFolderName(
  bank: KnowledgeBankFile,
  category: string,
  folder: string,
): string {
  const catalog = new Set(bank.folder_catalog.map((entry) => entry.folder.toLowerCase()));
  if (catalog.has(folder.toLowerCase())) return folder;

  const qualified = `${category} ${folder}`;
  if (catalog.has(qualified.toLowerCase())) return qualified;

  return folder;
}

/** Article folders that match nothing in the catalog, for the coverage report. */
export function unmatchedFolders(bank = loadKnowledgeBank()): string[] {
  const catalog = new Set(bank.folder_catalog.map((entry) => entry.folder.toLowerCase()));
  return [
    ...new Set(
      bank.articles
        .map((entry) => resolveFolderName(bank, entry.category, entry.folder))
        .filter((folder) => !catalog.has(folder.toLowerCase())),
    ),
  ];
}

export function bankFolders(bank = loadKnowledgeBank()): KnowledgeFolder[] {
  return bank.folder_catalog.map((entry) => ({
    category: categoryForFolder(bank, entry.folder),
    folder: entry.folder,
    url: entry.url,
    expectedArticleCount: entry.count,
    knownArticleTitles: entry.articles,
  }));
}

/** The fully normalized articles: real content, answerable today. */
export function normalizedArticles(bank = loadKnowledgeBank()): KnowledgeArticle[] {
  return bank.articles.map((entry) => {
    const article: KnowledgeArticle = {
      articleUrl: entry.article_url,
      category: entry.category,
      folder: resolveFolderName(bank, entry.category, entry.folder),
      articleTitle: entry.article_title,
      lastUpdated: entry.last_updated ?? null,
      supportedUserRole: entry.supported_user_role,
      product: entry.product,
      summary: entry.summary,
      stepByStepInstructions: entry.step_by_step_instructions,
      warnings: entry.warnings,
      troubleshooting: entry.troubleshooting,
      relatedArticles: entry.related_articles,
      // Every answer cites the official article. If the bank supplied no
      // citation, the article's own URL is the citation.
      sourceCitations: entry.source_citations.length ? entry.source_citations : [entry.article_url],
      syncStatus: 'normalized',
      contentHash: null,
      fetchedAt: null,
    };
    article.contentHash = contentHash(article);
    return article;
  });
}

/**
 * Every article named in the folder catalog that has no content yet.
 *
 * These carry a title, a folder and no URL — the catalog lists titles, not
 * links, so the synchronizer resolves each one against the folder page. Until
 * it does, they exist to be counted and fetched, never to be quoted.
 */
export function catalogedArticles(bank = loadKnowledgeBank()): Array<{
  category: string;
  folder: string;
  folderUrl: string;
  articleTitle: string;
}> {
  const normalizedTitles = new Set(
    bank.articles.map((entry) =>
      `${resolveFolderName(bank, entry.category, entry.folder)}::${entry.article_title}`.toLowerCase(),
    ),
  );

  const pending: Array<{
    category: string;
    folder: string;
    folderUrl: string;
    articleTitle: string;
  }> = [];

  for (const folder of bankFolders(bank)) {
    for (const title of folder.knownArticleTitles) {
      if (normalizedTitles.has(`${folder.folder}::${title}`.toLowerCase())) continue;
      pending.push({
        category: folder.category,
        folder: folder.folder,
        folderUrl: folder.url,
        articleTitle: title,
      });
    }
  }

  return pending;
}

/** What the bank claims to cover, so a report can be honest about the gap. */
export function bankCoverage(bank = loadKnowledgeBank()): {
  folders: number;
  articlesCataloged: number;
  articlesNormalized: number;
  articlesWithoutContent: number;
} {
  const folders = bankFolders(bank);
  const cataloged = folders.reduce((sum, folder) => sum + folder.expectedArticleCount, 0);
  const normalized = bank.articles.length;

  return {
    folders: folders.length,
    articlesCataloged: cataloged,
    articlesNormalized: normalized,
    // Counted from the articles that are actually still without content, not
    // by subtraction — the two disagree whenever a folder name does.
    articlesWithoutContent: catalogedArticles(bank).length,
  };
}
