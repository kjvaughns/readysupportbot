import * as cheerio from 'cheerio';
import { KnowledgeArticle } from './types';
import { contentHash } from './bank';

/**
 * Parsing an official Help Center article.
 *
 * Selector-tolerant, for the same reason the browser side is: a fixed selector
 * that silently stops matching produces an empty article that looks like a
 * short one. Several content containers are tried in order, the strategy that
 * matched is recorded, and an article that yields no content is a failure
 * rather than an article with nothing in it.
 *
 * Nothing here writes instructions. Every field comes from the fetched page, so
 * an article whose body could not be read has no steps — not plausible ones.
 */

/** Containers to try, most specific first. */
const CONTENT_SELECTORS = [
  '.article-body',
  '#article-body',
  'article .content',
  '.article .content',
  'article',
  'main',
  '.content',
];

/** Everything that is page furniture rather than the article. */
const STRIP_SELECTORS = [
  'nav',
  'header',
  'footer',
  'script',
  'style',
  'noscript',
  'form',
  '.breadcrumb',
  '.breadcrumbs',
  '.related-articles',
  '.article-feedback',
  '.helpful',
  '.sidebar',
  '.side-nav',
  '.search',
  '.cookie',
];

const WARNING_PATTERN = /^\s*(?:note|warning|caution|important|tip|be aware|please note)\b[:\s-]/i;
const TROUBLESHOOTING_HEADING = /troubleshoot|problem|issue|error|not working|if (?:you|this)/i;

export interface ParsedArticle {
  title: string;
  lastUpdated: string | null;
  summary: string;
  steps: string[];
  warnings: string[];
  troubleshooting: string[];
  relatedArticles: string[];
  /** Which content container matched, so parse quality is auditable. */
  matchedStrategy: string;
  /** Total characters of body text found. */
  contentLength: number;
}

export class ArticleParseError extends Error {
  constructor(readonly url: string, reason: string) {
    super(`Could not parse ${url}: ${reason}`);
    this.name = 'ArticleParseError';
  }
}

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Parses one article's HTML.
 *
 * Throws rather than returning an empty article: an article with no steps and
 * no summary would be stored as though it had been read, and then answered from.
 */
export function parseArticle(html: string, url: string): ParsedArticle {
  const $ = cheerio.load(html);

  const title =
    clean($('h1').first().text()) ||
    clean($('meta[property="og:title"]').attr('content') ?? '') ||
    clean($('title').text());

  // Freshdesk prints "Modified on: Wed, 8 Jan, 2026 at 7:33 AM".
  const modifiedText = clean($('body').text().match(/Modified on:?[^\n.]{0,60}/i)?.[0] ?? '');
  const lastUpdated = modifiedText ? modifiedText.replace(/^Modified on:?\s*/i, '') : null;

  let body: cheerio.Cheerio<any> | null = null;
  let matchedStrategy = '';

  for (const selector of CONTENT_SELECTORS) {
    const found = $(selector).first();
    if (found.length && clean(found.text()).length > 40) {
      body = found;
      matchedStrategy = selector;
      break;
    }
  }

  if (!body) {
    // Last resort: the largest block of text on the page. Recorded as such, so
    // a run that leans on it can be spotted and the selector list updated.
    let best: { element: cheerio.Cheerio<any>; length: number } | null = null;
    $('div, section').each((_, element) => {
      const candidate = $(element);
      const length = clean(candidate.text()).length;
      if (!best || length > best.length) best = { element: candidate, length };
    });
    if (best && (best as { length: number }).length > 120) {
      body = (best as { element: cheerio.Cheerio<any> }).element;
      matchedStrategy = 'largest-text-block';
    }
  }

  if (!body) throw new ArticleParseError(url, 'no content container matched');

  for (const selector of STRIP_SELECTORS) body.find(selector).remove();

  const relatedArticles: string[] = [];
  $('.related-articles a, .related a').each((_, element) => {
    const text = clean($(element).text());
    if (text) relatedArticles.push(text);
  });

  const paragraphs: string[] = [];
  const steps: string[] = [];
  const warnings: string[] = [];
  const troubleshooting: string[] = [];

  let inTroubleshooting = false;

  body.find('h1, h2, h3, h4, p, li').each((_, element) => {
    const node = $(element);
    const tag = (element as { tagName?: string }).tagName?.toLowerCase() ?? '';
    const text = clean(node.text());
    if (!text) return;

    if (/^h[1-4]$/.test(tag)) {
      inTroubleshooting = TROUBLESHOOTING_HEADING.test(text);
      return;
    }

    if (WARNING_PATTERN.test(text)) {
      warnings.push(text);
      return;
    }

    if (inTroubleshooting) {
      troubleshooting.push(text);
      return;
    }

    if (tag === 'li') {
      steps.push(text);
      return;
    }

    paragraphs.push(text);
  });

  const contentLength = clean(body.text()).length;
  if (contentLength < 40) throw new ArticleParseError(url, 'the content container was empty');

  return {
    title,
    lastUpdated,
    // The first substantial paragraph. A summary that is really the first
    // sentence of the article is honest; an invented one would not be.
    summary: paragraphs.find((paragraph) => paragraph.length > 40) ?? paragraphs[0] ?? '',
    steps: steps.slice(0, 60),
    warnings: warnings.slice(0, 20),
    troubleshooting: troubleshooting.slice(0, 30),
    relatedArticles: [...new Set(relatedArticles)].slice(0, 20),
    matchedStrategy,
    contentLength,
  };
}

/** Turns a parsed article into the record that gets stored. */
export function toKnowledgeArticle(
  parsed: ParsedArticle,
  context: { url: string; category: string; folder: string; product: string; fetchedAt: string },
): KnowledgeArticle {
  const article: KnowledgeArticle = {
    articleUrl: context.url,
    category: context.category,
    folder: context.folder,
    articleTitle: parsed.title,
    lastUpdated: parsed.lastUpdated,
    supportedUserRole: [],
    product: context.product,
    summary: parsed.summary,
    stepByStepInstructions: parsed.steps,
    warnings: parsed.warnings,
    troubleshooting: parsed.troubleshooting,
    relatedArticles: parsed.relatedArticles,
    // The article is its own citation. Every answer carries the official link.
    sourceCitations: [context.url],
    syncStatus: 'fetched',
    contentHash: null,
    fetchedAt: context.fetchedAt,
  };

  article.contentHash = contentHash(article);
  return article;
}

/**
 * Which product an article is about.
 *
 * Starter and iQ are different products with different screens, so an answer
 * that does not know which one it is describing is wrong half the time.
 */
export function detectProduct(text: string, folder: string): string {
  const haystack = `${folder} ${text}`.toLowerCase();
  if (/\breadymode\s*iq\b/.test(haystack)) return 'Readymode iQ';
  if (/\bbilling portal\b/.test(haystack)) return 'Billing Portal';
  if (/\bclient portal\b/.test(haystack)) return 'Client Portal';
  return 'Readymode Starter';
}
