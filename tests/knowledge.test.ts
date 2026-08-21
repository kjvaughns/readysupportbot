import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setStore, getStore } from '../src/database';
import {
  bankCoverage,
  bankFolders,
  catalogedArticles,
  contentHash,
  normalizedArticles,
  unmatchedFolders,
} from '../src/knowledge/bank';
import {
  HelpCenterCrawler,
  articleLinksIn,
  folderLinksIn,
  isAllowedUrl,
  nextPageIn,
  normalizeUrl,
} from '../src/knowledge/crawler';
import { ArticleParseError, detectProduct, parseArticle } from '../src/knowledge/parser';
import { composeAnswer, explainConflict, rankArticles } from '../src/knowledge/retrieval';
import { seedKnowledgeBank, syncKnowledge } from '../src/knowledge/sync';
import { KnowledgeArticle } from '../src/knowledge/types';

/**
 * The rule these hold: an article ReadySupport has not read is never answered
 * from. A title is not content, and instructions written from a title are
 * invented instructions that happen to sound official.
 *
 * The HTML below is written for this repository. It is not copied Readymode
 * content — it exists to prove the pipeline's mechanics.
 */

beforeEach(() => {
  setStore(new MemoryStore());
});

describe('the supplied knowledge bank', () => {
  it('reports its own coverage honestly', () => {
    const coverage = bankCoverage();
    expect(coverage.folders).toBe(38);
    expect(coverage.articlesCataloged).toBe(147);
    // Thirteen articles have real content. The other 134 are titles.
    expect(coverage.articlesNormalized).toBe(13);
    expect(coverage.articlesWithoutContent).toBe(134);
  });

  it('reconciles folder names that the two halves of the file disagree on', () => {
    // Articles call the folder "Advanced"; the catalog calls it "Readymode iQ
    // Advanced". Left alone, those articles belong to no folder at all.
    expect(unmatchedFolders()).toEqual([]);
    const folders = bankFolders().map((folder) => folder.folder);
    expect(normalizedArticles().every((article) => folders.includes(article.folder))).toBe(true);
  });

  it('never lists a normalized article as still needing content', () => {
    const normalizedTitles = new Set(normalizedArticles().map((article) => article.articleTitle));
    for (const pending of catalogedArticles()) {
      expect(normalizedTitles.has(pending.articleTitle)).toBe(false);
    }
  });

  it('gives every normalized article an official citation', () => {
    for (const article of normalizedArticles()) {
      expect(article.sourceCitations.length).toBeGreaterThan(0);
      for (const citation of article.sourceCitations) {
        expect(citation).toMatch(/^https:\/\/help\.readymode\.com\//);
      }
    }
  });

  it('hashes content, not formatting', () => {
    const base = {
      articleTitle: 'How to Configure Queues',
      summary: 'Queues decide which leads are dialed.',
      stepByStepInstructions: ['Open Lead Management.'],
      warnings: [],
      troubleshooting: [],
    };
    const spaced = { ...base, summary: '  Queues   decide which leads are dialed.  ' };
    expect(contentHash(base)).toBe(contentHash(spaced));

    const different = { ...base, summary: 'Queues decide something else.' };
    expect(contentHash(base)).not.toBe(contentHash(different));
  });
});

describe('what the crawler is allowed to fetch', () => {
  it('accepts official Help Center support pages', () => {
    expect(isAllowedUrl('https://help.readymode.com/support/solutions/articles/11000076985-x')).toBe(
      true,
    );
  });

  it('refuses anything else, however plausible', () => {
    expect(isAllowedUrl('https://help.readymode.com/other/page')).toBe(false);
    expect(isAllowedUrl('https://readymode.com/support/solutions')).toBe(false);
    expect(isAllowedUrl('https://help-readymode.com/support/solutions')).toBe(false);
    expect(isAllowedUrl('http://help.readymode.com/support/solutions')).toBe(false);
    expect(isAllowedUrl('https://blog.example.com/readymode-tutorial')).toBe(false);
  });

  it('refuses to fetch an off-limits URL even when asked directly', async () => {
    const crawler = new HelpCenterCrawler({
      fetchImpl: async () => new Response('should never be requested'),
      sleepImpl: async () => undefined,
    });

    await expect(crawler.fetchPage('https://blog.example.com/x')).rejects.toThrow(/Refusing/);
  });

  it('gives one page one identity', () => {
    expect(normalizeUrl('https://help.readymode.com/support/solutions/articles/1-x?utm=a#top')).toBe(
      'https://help.readymode.com/support/solutions/articles/1-x',
    );
  });

  it('finds article and folder links, and ignores everything else', () => {
    const html = `
      <a href="/support/solutions/folders/11000014048">Welcome</a>
      <a href="/support/solutions/articles/11000076985-how-to-navigate">Navigate</a>
      <a href="/support/login">Sign in</a>
      <a href="https://example.com/support/solutions/articles/1-fake">Fake</a>
    `;
    const base = 'https://help.readymode.com/support/solutions';

    expect(articleLinksIn(html, base)).toEqual([
      'https://help.readymode.com/support/solutions/articles/11000076985-how-to-navigate',
    ]);
    expect(folderLinksIn(html, base)).toEqual([
      'https://help.readymode.com/support/solutions/folders/11000014048',
    ]);
  });

  it('follows pagination', () => {
    const html = '<a rel="next" href="/support/solutions/folders/1?page=2">Next</a>';
    expect(nextPageIn(html, 'https://help.readymode.com/support/solutions/folders/1')).toBe(
      'https://help.readymode.com/support/solutions/folders/1?page=2',
    );
    expect(nextPageIn('<a href="/support/x">x</a>', 'https://help.readymode.com/support/')).toBeNull();
  });

  it('sends conditional headers so an unchanged article costs nothing', async () => {
    const seen: Record<string, string> = {};
    const crawler = new HelpCenterCrawler({
      sleepImpl: async () => undefined,
      fetchImpl: async (_url, init) => {
        Object.assign(seen, init?.headers);
        return new Response(null, { status: 304 });
      },
    });

    const page = await crawler.fetchPage(
      'https://help.readymode.com/support/solutions/articles/1-x',
      { etag: 'W/"abc"' },
    );

    expect(seen['if-none-match']).toBe('W/"abc"');
    expect(page.notModified).toBe(true);
  });

  it('backs off and retries when the Help Center throttles it', async () => {
    let calls = 0;
    const crawler = new HelpCenterCrawler({
      sleepImpl: async () => undefined,
      fetchImpl: async () => {
        calls += 1;
        return calls < 3 ? new Response('', { status: 429 }) : new Response('<p>ok</p>');
      },
    });

    const page = await crawler.fetchPage('https://help.readymode.com/support/solutions/articles/1-x');
    expect(page.status).toBe(200);
    expect(calls).toBe(3);
  });
});

describe('parsing an article', () => {
  const article = `
    <html><body>
      <nav><a href="/support/solutions">Solutions</a></nav>
      <h1>Configure Queues in Readymode</h1>
      <div class="article-body">
        <p>Queues decide which leads are dialed and in what order they reach agents.</p>
        <h2>Steps</h2>
        <ul><li>Open Lead Management.</li><li>Choose the Queues tab.</li></ul>
        <p>Note: changing a queue affects every agent assigned to it.</p>
        <h2>Troubleshooting</h2>
        <p>If the queue does not dial, check that it has members.</p>
      </div>
      <div class="related-articles"><a href="#">Understanding Queues</a></div>
      <p>Modified on: Wed, 6 Nov, 2025 at 6:24 AM</p>
      <footer>Readymode</footer>
    </body></html>`;

  it('reads the real content out of the page', () => {
    const parsed = parseArticle(article, 'https://help.readymode.com/support/solutions/articles/1-x');

    expect(parsed.title).toBe('Configure Queues in Readymode');
    expect(parsed.summary).toContain('Queues decide which leads are dialed');
    expect(parsed.steps).toEqual(['Open Lead Management.', 'Choose the Queues tab.']);
    expect(parsed.warnings[0]).toMatch(/^Note: changing a queue/);
    expect(parsed.troubleshooting[0]).toMatch(/does not dial/);
    expect(parsed.relatedArticles).toContain('Understanding Queues');
    expect(parsed.lastUpdated).toMatch(/6 Nov, 2025/);
  });

  it('records which container matched, so parse quality is auditable', () => {
    const parsed = parseArticle(article, 'https://help.readymode.com/support/solutions/articles/1-x');
    expect(parsed.matchedStrategy).toBe('.article-body');
  });

  it('falls back to the largest text block, and says so', () => {
    const unusual = `<html><body><div id="odd"><p>${'Queues matter. '.repeat(20)}</p></div></body></html>`;
    const parsed = parseArticle(unusual, 'https://help.readymode.com/support/solutions/articles/1-x');
    expect(parsed.matchedStrategy).toBe('largest-text-block');
  });

  it('fails rather than returning an article with nothing in it', () => {
    expect(() =>
      parseArticle('<html><body><nav>menu</nav></body></html>', 'https://help.readymode.com/support/solutions/articles/1-x'),
    ).toThrow(ArticleParseError);
  });

  it('tells Starter and iQ apart', () => {
    expect(detectProduct('State Calling Restrictions', 'Readymode iQ Advanced')).toBe('Readymode iQ');
    expect(detectProduct('How to Configure Queues', 'Queues')).toBe('Readymode Starter');
  });
});

describe('seeding', () => {
  it('stores content as normalized and titles as cataloged', async () => {
    const result = await seedKnowledgeBank();

    expect(result.folders).toBe(38);
    expect(result.normalized).toBe(13);
    expect(result.cataloged).toBe(134);

    const store = getStore();
    expect(await store.listKnowledgeArticles({ statuses: ['normalized'] })).toHaveLength(13);
    expect((await store.listKnowledgeArticles({ statuses: ['cataloged'] })).length).toBe(134);
  });

  it('is safe to run twice', async () => {
    await seedKnowledgeBank();
    await seedKnowledgeBank();
    expect((await getStore().listKnowledgeArticles({ limit: 1000 })).length).toBe(147);
  });
});

describe('answering', () => {
  const answerable = (overrides: Partial<KnowledgeArticle>): KnowledgeArticle => ({
    articleUrl: 'https://help.readymode.com/support/solutions/articles/1-queues',
    category: 'Managing Leads',
    folder: 'Queues',
    articleTitle: 'How to Configure Queues in Readymode',
    lastUpdated: '2025-11-06 06:24 AM',
    supportedUserRole: ['administrator'],
    product: 'Readymode Starter',
    summary: 'Queues decide which leads are dialed.',
    stepByStepInstructions: ['Open Lead Management.', 'Choose the Queues tab.'],
    warnings: ['Changing a queue affects every assigned agent.'],
    troubleshooting: [],
    relatedArticles: [],
    sourceCitations: ['https://help.readymode.com/support/solutions/articles/1-queues'],
    syncStatus: 'normalized',
    contentHash: 'abc',
    fetchedAt: null,
    ...overrides,
  });

  it('never ranks an article nobody has read', () => {
    const cataloged = answerable({
      articleTitle: 'How to Configure Queues in Readymode',
      syncStatus: 'cataloged',
      summary: '',
      stepByStepInstructions: [],
    });

    expect(rankArticles('how do I configure a queue', [cataloged])).toEqual([]);
  });

  it('finds the article whose title is about the question', () => {
    const hits = rankArticles('how do I configure a queue', [
      answerable({}),
      answerable({
        articleUrl: 'https://help.readymode.com/support/solutions/articles/2-users',
        articleTitle: 'Managing Users in Readymode',
        summary: 'Users can be added to a queue later.',
      }),
    ]);

    expect(hits[0].article.articleTitle).toMatch(/Configure Queues/);
  });

  it('prefers the product this account actually uses', () => {
    const starter = answerable({});
    const iq = answerable({
      articleUrl: 'https://help.readymode.com/support/solutions/articles/3-iq-queues',
      articleTitle: 'How to Configure Queues in Readymode iQ',
      product: 'Readymode iQ',
    });

    const hits = rankArticles('configure a queue', [iq, starter], { product: 'Readymode Starter' });
    expect(hits[0].article.product).toBe('Readymode Starter');
    // The other product's article is still offered, not hidden.
    expect(hits.some((hit) => hit.article.product === 'Readymode iQ')).toBe(true);
  });

  it('says it does not know rather than assembling something plausible', () => {
    const answer = composeAnswer('how do I reset the billing cycle', [
      { article: answerable({}), score: 2, matchedOn: ['body:reset'] },
    ]);

    expect(answer.unanswered).toBe(true);
    expect(answer.citations).toEqual([]);
    expect(answer.text).toMatch(/does not answer that/i);
  });

  it('cites the official article in every answer it gives', () => {
    const answer = composeAnswer('how do I configure a queue', [
      { article: answerable({}), score: 30, matchedOn: ['title:queue'] },
    ]);

    expect(answer.unanswered).toBe(false);
    expect(answer.citations).toEqual([
      'https://help.readymode.com/support/solutions/articles/1-queues',
    ]);
    expect(answer.text).toContain('Readymode Starter');
    expect(answer.text).toContain('Open Lead Management.');
  });

  it('warns when the other product has its own article', () => {
    const answer = composeAnswer('configure a queue', [
      { article: answerable({}), score: 30, matchedOn: [] },
      {
        article: answerable({
          articleUrl: 'https://help.readymode.com/support/solutions/articles/3-iq',
          articleTitle: 'Configure Queues in Readymode iQ',
          product: 'Readymode iQ',
        }),
        score: 20,
        matchedOn: [],
      },
    ]);

    expect(answer.text).toMatch(/different interface/);
    expect(answer.citations).toHaveLength(2);
  });
});

describe('explaining a conflict with the live interface', () => {
  it('blames the interface version when the products differ', () => {
    const explanation = explainConflict({
      articleTitle: 'State Calling Restrictions',
      articleProduct: 'Readymode iQ',
      observedInterfaceVersion: 'starter',
      controlWasFound: false,
    });

    expect(explanation).toMatch(/different screens/);
    expect(explanation).toMatch(/interface version/);
  });

  it('offers permissions or outdated documentation when a control is missing', () => {
    const explanation = explainConflict({
      articleTitle: 'Managing Users in Readymode',
      articleProduct: 'Readymode Starter',
      observedInterfaceVersion: 'starter',
      controlWasFound: false,
      articleLastUpdated: '2025-10-14',
    });

    expect(explanation).toMatch(/permission/);
    expect(explanation).toMatch(/older version/);
    expect(explanation).toMatch(/2025-10-14/);
  });
});

describe('syncing', () => {
  const folderPage = `
    <a href="/support/solutions/articles/11000076985-navigate">How to Navigate Readymode</a>`;

  const articlePage = `
    <h1>How to Navigate Readymode</h1>
    <div class="article-body">
      <p>The Dashboard opens system areas, and the Workspace holds what you opened.</p>
      <ul><li>Use Dashboard items to open system areas.</li></ul>
    </div>`;

  function fakeHelpCenter(pages: Record<string, string>): typeof fetch {
    return (async (url: string) => {
      // Longest match wins: "/support/solutions" is a prefix of every other
      // path, so first-match would answer every request with the index.
      const match = Object.entries(pages)
        .filter(([key]) => url.includes(key))
        .sort((a, b) => b[0].length - a[0].length)[0];
      return new Response(match?.[1] ?? '', { status: match ? 200 : 404 });
    }) as unknown as typeof fetch;
  }

  it('fetches the real article and marks it read', async () => {
    await seedKnowledgeBank();

    const summary = await syncKnowledge({
      sleepImpl: async () => undefined,
      fetchImpl: fakeHelpCenter({
        '/support/solutions': '<a href="/support/solutions/folders/11000014048">Welcome</a>',
        '/support/solutions/folders/11000014048': folderPage,
        '/support/solutions/articles/11000076985': articlePage,
      }),
    });

    expect(summary.articlesFetched).toBe(1);
    expect(summary.articlesFailed).toBe(0);

    const stored = await getStore().getKnowledgeArticle(
      'https://help.readymode.com/support/solutions/articles/11000076985-navigate',
    );
    expect(stored?.syncStatus).toBe('fetched');
    expect(stored?.stepByStepInstructions).toContain('Use Dashboard items to open system areas.');
  });

  it('keeps the previous version when an article changes', async () => {
    const store = getStore();
    const url = 'https://help.readymode.com/support/solutions/articles/1-x';

    const first: KnowledgeArticle = {
      articleUrl: url,
      category: 'Managing Leads',
      folder: 'Queues',
      articleTitle: 'Queues',
      lastUpdated: null,
      supportedUserRole: [],
      product: 'Readymode Starter',
      summary: 'The first version.',
      stepByStepInstructions: [],
      warnings: [],
      troubleshooting: [],
      relatedArticles: [],
      sourceCitations: [url],
      syncStatus: 'fetched',
      contentHash: 'hash-one',
      fetchedAt: '2026-01-01T00:00:00.000Z',
    };

    await store.upsertKnowledgeArticle(first);
    await store.upsertKnowledgeArticle({
      ...first,
      summary: 'The second version.',
      contentHash: 'hash-two',
      fetchedAt: '2026-02-01T00:00:00.000Z',
    });

    const versions = await store.listKnowledgeVersions(url, 10);
    expect(versions).toHaveLength(1);
    expect(versions[0].contentHash).toBe('hash-one');

    const current = await store.getKnowledgeArticle(url);
    expect(current?.summary).toBe('The second version.');
  });

  it('reports an unchanged article as unchanged', async () => {
    const store = getStore();
    const article: KnowledgeArticle = {
      articleUrl: 'https://help.readymode.com/support/solutions/articles/2-y',
      category: '',
      folder: '',
      articleTitle: 'Same',
      lastUpdated: null,
      supportedUserRole: [],
      product: 'Readymode Starter',
      summary: 'Unchanged.',
      stepByStepInstructions: [],
      warnings: [],
      troubleshooting: [],
      relatedArticles: [],
      sourceCitations: [],
      syncStatus: 'fetched',
      contentHash: 'same-hash',
      fetchedAt: null,
    };

    expect((await store.upsertKnowledgeArticle(article)).changed).toBe(true);
    expect((await store.upsertKnowledgeArticle(article)).changed).toBe(false);
  });

  it('keeps the old content when an article cannot be read', async () => {
    await seedKnowledgeBank();
    const url = 'https://help.readymode.com/support/solutions/articles/11000076985-how-to-navigate-readymode';

    const before = await getStore().getKnowledgeArticle(url);
    expect(before?.summary).toBeTruthy();

    const summary = await syncKnowledge({
      sleepImpl: async () => undefined,
      fetchImpl: fakeHelpCenter({
        '/support/solutions': '<a href="/support/solutions/folders/11000014048">Welcome</a>',
        '/support/solutions/folders/11000014048':
          '<a href="/support/solutions/articles/11000076985-how-to-navigate-readymode">Navigate</a>',
        // The article itself is not served, so reading it fails.
      }),
    });

    expect(summary.articlesFailed).toBe(1);
    expect(summary.status).not.toBe('succeeded');

    const after = await getStore().getKnowledgeArticle(url);
    // Content that was good yesterday is better than nothing today.
    expect(after?.summary).toBe(before?.summary);
    expect(after?.syncStatus).toBe('failed');
    // The reason is recorded, whichever way reading it failed.
    expect(after?.lastError).toMatch(/could not parse|http 4\d\d/i);
  });

  it('does not call a partial crawl complete', async () => {
    const summary = await syncKnowledge({
      sleepImpl: async () => undefined,
      fetchImpl: (async () => new Response('', { status: 500 })) as unknown as typeof fetch,
    });

    expect(summary.completePass).toBe(false);
    expect(summary.status).toBe('failed');
  });
});
