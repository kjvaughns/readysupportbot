import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAccess, requireRole } from '../../auth';
import { getStore } from '../../database';
import { recordEvent } from '../../audit';
import { bankCoverage } from '../../knowledge/bank';
import { seedKnowledgeBank, syncKnowledge } from '../../knowledge/sync';
import { retrieve, composeAnswer } from '../../knowledge/retrieval';
import { logger } from '../../security/logger';
import { sanitizeUntrustedText } from '../../security/sanitize';

/**
 * The Help Center knowledge bank, over HTTP.
 *
 * Syncing is exposed as an endpoint for the same reason command registration
 * is: a Railway deployment has no shell, and requiring one would mean the
 * documentation never gets loaded. It is Owner-only and it reaches only
 * help.readymode.com.
 */

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  /** What has actually been read, as opposed to what is known to exist. */
  app.get('/knowledge/status', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const store = getStore();
    const coverage = bankCoverage();

    const [answerable, cataloged, failed, lastRun] = await Promise.all([
      store.listKnowledgeArticles({ statuses: ['normalized', 'fetched'], limit: 1000 }),
      store.listKnowledgeArticles({ statuses: ['cataloged'], limit: 1000 }),
      store.listKnowledgeArticles({ statuses: ['failed'], limit: 1000 }),
      store.latestKnowledgeSyncRun(),
    ]);

    return {
      organizationId: context.organizationId,
      bank: coverage,
      stored: {
        // The number that matters: articles ReadySupport can answer from.
        answerable: answerable.length,
        // Known to exist, never read, never quoted.
        cataloged: cataloged.length,
        failed: failed.length,
      },
      lastSync: lastRun,
      message:
        answerable.length === 0
          ? 'No documentation has been loaded yet. Run the sync, or POST /api/knowledge/sync as an Owner.'
          : `${answerable.length} article(s) can be answered from; ${cataloged.length} are known but unread.`,
    };
  });

  /**
   * Loads the supplied bank and fetches the real articles.
   *
   * Long-running by nature — it is paced at roughly a request a second — so the
   * article budget is bounded per call and re-running it is cheap: an unchanged
   * article costs a 304.
   */
  app.post('/knowledge/sync', async (request) => {
    const context = await requireRole(request, ['owner']);
    const body = z
      .object({
        maxArticles: z.coerce.number().int().min(1).max(400).optional(),
        seedOnly: z.boolean().optional(),
      })
      .parse(request.body ?? {});

    const seeded = await seedKnowledgeBank();

    if (body.seedOnly) {
      await recordEvent({
        organizationId: context.organizationId,
        type: 'connection.updated',
        message: `Knowledge bank seeded: ${seeded.normalized} article(s) with content, ${seeded.cataloged} cataloged.`,
      });
      return { ok: true, seeded, synced: null };
    }

    const summary = await syncKnowledge({ maxArticles: body.maxArticles ?? 60 });

    await recordEvent({
      organizationId: context.organizationId,
      type: 'connection.updated',
      message:
        `Help Center sync ${summary.status}: ${summary.articlesFetched} fetched, ` +
        `${summary.articlesChanged} changed, ${summary.articlesFailed} failed.`,
      data: {
        status: summary.status,
        completePass: summary.completePass,
        // Counts only. The errors carry URLs, which are already public, but the
        // audit record does not need them.
        errors: summary.errors.length,
      },
    });

    logger.info({ ...summary, errors: summary.errors.length }, 'Help Center sync requested');

    return {
      ok: summary.status !== 'failed',
      seeded,
      synced: summary,
      message:
        summary.status === 'succeeded'
          ? `Read ${summary.articlesFetched} article(s); ${summary.articlesChanged} had changed.`
          : summary.status === 'partial'
            ? `Read ${summary.articlesFetched} article(s). ${summary.articlesFailed} could not be read and kept whatever content they already had.`
            : 'Nothing could be read. Check that the deployment can reach help.readymode.com.',
    };
  });

  /**
   * Answers a documentation question, with citations.
   *
   * The same path the Discord bot uses, exposed so the frontend can show what an
   * answer would look like — and, more usefully, so an operator can see when the
   * honest answer is that nothing relevant has been read.
   */
  app.post('/knowledge/ask', async (request) => {
    const context = await requireAccess(request, 'view_activity');
    const body = z
      .object({ question: z.string().min(3).max(500), product: z.string().max(60).optional() })
      .parse(request.body ?? {});

    // The question reaches a ranking function and a reply, never a browser, but
    // it is still untrusted text from a person.
    const question = sanitizeUntrustedText(body.question, 500).text;

    let product = body.product ?? null;
    if (!product) {
      const profile = await getStore()
        .getActiveInterfaceProfile(context.organizationId)
        .catch(() => null);
      if (profile?.interfaceVersion === 'iq') product = 'Readymode iQ';
      else if (profile?.interfaceVersion === 'starter') product = 'Readymode Starter';
    }

    const hits = await retrieve(question, { product });
    const answer = composeAnswer(question, hits);

    return {
      answer: answer.text,
      citations: answer.citations,
      product: answer.product,
      unanswered: answer.unanswered,
      considered: hits.map((hit) => ({
        title: hit.article.articleTitle,
        url: hit.article.articleUrl,
        product: hit.article.product,
        score: hit.score,
        status: hit.article.syncStatus,
      })),
    };
  });
}
