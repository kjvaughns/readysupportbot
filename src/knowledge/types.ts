import { z } from 'zod';

/**
 * The Help Center knowledge bank.
 *
 * Separate from the interface registry on purpose. This is public
 * documentation, quoted to people with a link to the original. It is never a
 * source of selectors, and nothing in it decides what a browser does.
 */

/** Products with genuinely different screens. Saying which one is meant matters. */
export const PRODUCTS = [
  'Readymode Starter',
  'Readymode iQ',
  'Client Portal',
  'Billing Portal',
] as const;
export type Product = (typeof PRODUCTS)[number];

export const USER_ROLES = [
  'agent',
  'administrator',
  'manager',
  'billing_admin',
  'system_administrator',
  'all_users',
] as const;
export type SupportedRole = (typeof USER_ROLES)[number];

/**
 * How much of an article ReadySupport actually has.
 *
 * `cataloged` is the important one: the title and URL are known and nothing
 * else is. An article in that state is never answered from, because writing
 * instructions from a title is making them up.
 */
export type ArticleSyncStatus = 'cataloged' | 'normalized' | 'fetched' | 'failed' | 'removed';

/** Statuses whose content is real enough to quote. */
export const ANSWERABLE_STATUSES: ArticleSyncStatus[] = ['normalized', 'fetched'];

export function isAnswerable(status: ArticleSyncStatus): boolean {
  return ANSWERABLE_STATUSES.includes(status);
}

export interface KnowledgeArticle {
  articleUrl: string;
  category: string;
  folder: string;
  articleTitle: string;
  /** The article's own statement of when it last changed. */
  lastUpdated: string | null;
  supportedUserRole: string[];
  product: string;
  summary: string;
  stepByStepInstructions: string[];
  warnings: string[];
  troubleshooting: string[];
  relatedArticles: string[];
  sourceCitations: string[];
  syncStatus: ArticleSyncStatus;
  contentHash: string | null;
  /** When ReadySupport last read it, as distinct from when it last changed. */
  fetchedAt: string | null;
  lastError?: string | null;
}

export interface KnowledgeFolder {
  category: string;
  folder: string;
  url: string;
  /** The Help Center's own count, so a partial crawl reads as partial. */
  expectedArticleCount: number;
  knownArticleTitles: string[];
}

export interface SyncRunSummary {
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'partial';
  foldersSeen: number;
  articlesSeen: number;
  articlesFetched: number;
  articlesChanged: number;
  articlesFailed: number;
  /** Only a complete pass may conclude that an article has been removed. */
  completePass: boolean;
  errors: Array<{ url: string; reason: string }>;
}

/* -- the supplied knowledge bank file ------------------------------------- */

const articleSchema = z.object({
  category: z.string(),
  folder: z.string(),
  article_title: z.string(),
  article_url: z.string().url(),
  last_updated: z.string().optional().nullable(),
  supported_user_role: z.array(z.string()).default([]),
  product: z.string().default('Readymode Starter'),
  summary: z.string().default(''),
  step_by_step_instructions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  troubleshooting: z.array(z.string()).default([]),
  related_articles: z.array(z.string()).default([]),
  source_citations: z.array(z.string()).default([]),
});

const folderSchema = z.object({
  folder: z.string(),
  url: z.string().url(),
  count: z.number().int().nonnegative().default(0),
  articles: z.array(z.string()).default([]),
});

export const knowledgeBankSchema = z.object({
  schema_version: z.string(),
  generated_at: z.string(),
  source_home: z.string().url(),
  source_index: z.string().url(),
  categories: z.array(z.object({ category: z.string(), folders: z.array(z.string()) })).default([]),
  articles: z.array(articleSchema).default([]),
  folder_catalog: z.array(folderSchema).default([]),
  coverage: z
    .object({
      folder_count: z.number().int().nonnegative(),
      article_count_from_folder_totals: z.number().int().nonnegative(),
      fully_structured_article_count: z.number().int().nonnegative(),
    })
    .partial()
    .default({}),
});

export type KnowledgeBankFile = z.infer<typeof knowledgeBankSchema>;
