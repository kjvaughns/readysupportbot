import { getStore } from '../database';
import { KnowledgeArticle, isAnswerable } from './types';

/**
 * Finding the right official article, and answering from it.
 *
 * Deterministic ranking rather than an embedding service: the corpus is a few
 * hundred articles, the scoring is inspectable, and it keeps working when
 * OpenAI is not configured. Every answer carries the official link, and an
 * article ReadySupport has not actually read is never one of them.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'my', 'of', 'on', 'or', 'the', 'to', 'we', 'what', 'when',
  'where', 'which', 'who', 'why', 'with', 'you', 'your',
]);

export function keywordsOf(question: string): string[] {
  return [
    ...new Set(
      question
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    ),
  ];
}

export interface RetrievalHit {
  article: KnowledgeArticle;
  score: number;
  /** Which words matched where, so a ranking can be explained. */
  matchedOn: string[];
}

export interface RetrievalOptions {
  /** Prefer articles about this product, when the organization's is known. */
  product?: string | null;
  limit?: number;
}

/**
 * Ranks the articles that have actually been read.
 *
 * A title match counts for more than a body match, because an article called
 * "How to Configure Queues" is what somebody asking how to configure a queue
 * wants — and a passing mention of queues in an unrelated article is not.
 */
export function rankArticles(
  question: string,
  articles: KnowledgeArticle[],
  options: RetrievalOptions = {},
): RetrievalHit[] {
  const words = keywordsOf(question);
  if (words.length === 0) return [];

  const hits: RetrievalHit[] = [];

  for (const article of articles) {
    // Never rank an article nobody has read. Its title may look relevant, and
    // answering from a title is the failure this guards against.
    if (!isAnswerable(article.syncStatus)) continue;

    const title = article.articleTitle.toLowerCase();
    const folder = `${article.folder} ${article.category}`.toLowerCase();
    const body = [
      article.summary,
      ...article.stepByStepInstructions,
      ...article.warnings,
      ...article.troubleshooting,
    ]
      .join(' ')
      .toLowerCase();

    let score = 0;
    const matchedOn: string[] = [];

    for (const word of words) {
      if (title.includes(word)) {
        score += 10;
        matchedOn.push(`title:${word}`);
      }
      if (folder.includes(word)) {
        score += 4;
        matchedOn.push(`folder:${word}`);
      }
      if (body.includes(word)) {
        score += 2;
        matchedOn.push(`body:${word}`);
      }
    }

    if (score === 0) continue;

    // Starter and iQ describe different screens. When the organization's
    // product is known, its own documentation comes first — but the other
    // product's article is still offered rather than hidden, because sometimes
    // it is the answer.
    if (options.product) {
      if (article.product === options.product) score += 6;
      else score -= 4;
    }

    // A fetched article beats one that came from the supplied bank, all else
    // equal: it is what the page says now.
    if (article.syncStatus === 'fetched') score += 1;

    hits.push({ article, score, matchedOn: [...new Set(matchedOn)] });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 5);
}

export async function retrieve(
  question: string,
  options: RetrievalOptions = {},
): Promise<RetrievalHit[]> {
  const articles = await getStore().listKnowledgeArticles({
    statuses: ['normalized', 'fetched'],
    limit: 1000,
  });
  return rankArticles(question, articles, options);
}

export interface KnowledgeAnswer {
  /** The answer text, or an honest statement that there is not one. */
  text: string;
  /** Official article links. Always present when an article was used. */
  citations: string[];
  /** Which product the answer is about. */
  product: string | null;
  /** True when nothing sufficiently relevant had been read. */
  unanswered: boolean;
  /** A conflict between the documentation and the inspected interface. */
  conflictNote?: string;
}

/**
 * Composes an answer from the best article.
 *
 * Prefers saying it does not know. An article that mentions a word is not an
 * answer to a question about it, and the failure mode worth avoiding is a
 * confident paragraph assembled out of a passing mention.
 */
export function composeAnswer(question: string, hits: RetrievalHit[]): KnowledgeAnswer {
  const best = hits[0];

  if (!best || best.score < 10) {
    return {
      text:
        'The official Readymode documentation ReadySupport has read does not answer that. ' +
        'Rather than guess, here is what it can do: search the Help Center directly, or an ' +
        'administrator can ask Readymode support.',
      citations: [],
      product: null,
      unanswered: true,
    };
  }

  const article = best.article;
  const lines: string[] = [];

  lines.push(`**${article.articleTitle}** — ${article.product}`);
  if (article.summary) lines.push(article.summary);

  if (article.stepByStepInstructions.length > 0) {
    lines.push('');
    lines.push('Steps:');
    article.stepByStepInstructions.slice(0, 10).forEach((step, index) => {
      lines.push(`${index + 1}. ${step}`);
    });
  }

  if (article.warnings.length > 0) {
    lines.push('');
    for (const warning of article.warnings.slice(0, 3)) lines.push(`⚠️ ${warning}`);
  }

  if (article.lastUpdated) {
    lines.push('');
    lines.push(`_Readymode last updated this article on ${article.lastUpdated}._`);
  }

  // A second article about the other product, when there is one, so nobody
  // follows Starter steps on iQ or the other way round.
  const otherProduct = hits.find((hit) => hit.article.product !== article.product);
  if (otherProduct) {
    lines.push('');
    lines.push(
      `There is also **${otherProduct.article.articleTitle}** for ${otherProduct.article.product}, ` +
        'which describes a different interface.',
    );
  }

  const citations = [
    ...new Set([
      ...article.sourceCitations,
      article.articleUrl,
      ...(otherProduct ? [otherProduct.article.articleUrl] : []),
    ]),
  ].filter((url) => url.startsWith('https://help.readymode.com/'));

  return {
    text: lines.join('\n'),
    citations,
    product: article.product,
    unanswered: false,
  };
}

/**
 * Explains a disagreement between an article and the inspected interface.
 *
 * There are only three honest explanations, and saying which one it probably is
 * beats asserting that the documentation or the screen is simply wrong.
 */
export function explainConflict(input: {
  articleTitle: string;
  articleProduct: string;
  observedInterfaceVersion: 'starter' | 'iq' | 'unknown';
  controlWasFound: boolean;
  articleLastUpdated?: string | null;
}): string {
  const productMismatch =
    (input.articleProduct === 'Readymode iQ' && input.observedInterfaceVersion === 'starter') ||
    (input.articleProduct === 'Readymode Starter' && input.observedInterfaceVersion === 'iq');

  if (productMismatch) {
    return (
      `"${input.articleTitle}" describes ${input.articleProduct}, and this account signs in to ` +
      `${input.observedInterfaceVersion === 'iq' ? 'Readymode iQ' : 'Readymode Starter'}. ` +
      'The two have different screens, so the steps will not match. This is an interface version difference.'
    );
  }

  if (!input.controlWasFound) {
    return (
      `"${input.articleTitle}" describes a control ReadySupport could not find on this account. ` +
      'That is usually one of two things: the signed-in administrator may not have permission to see it, ' +
      'or the article may be describing an older version of the screen' +
      (input.articleLastUpdated ? ` (Readymode last updated it on ${input.articleLastUpdated})` : '') +
      '. An administrator can confirm which by opening the screen themselves.'
    );
  }

  return (
    `"${input.articleTitle}" and the live interface agree on the screen, but differ in detail. ` +
    'Trust what is on screen, and treat the article as the explanation of why the setting exists.'
  );
}
