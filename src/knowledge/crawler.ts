import { logger } from '../security/logger';

/**
 * Fetching from the official Help Center.
 *
 * Polite by construction: one request at a time, a delay between them, an
 * upper bound on how many pages a run may take, and conditional requests so an
 * unchanged article costs a 304 rather than a download. It only ever reads
 * `help.readymode.com/support/`, and a link that leads anywhere else is
 * refused — so no crawl can wander onto a blog, a forum, or somebody's
 * tutorial and come back with it as though it were official.
 */

export const KNOWLEDGE_HOST = 'help.readymode.com';
export const KNOWLEDGE_PREFIX = '/support/';
export const SOLUTIONS_INDEX = 'https://help.readymode.com/support/solutions';

export interface FetchOptions {
  /** Milliseconds between requests. */
  delayMs?: number;
  /** Hard cap on pages fetched in one run. */
  maxPages?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Injected so the crawler can be tested without network access. */
  fetchImpl?: typeof fetch;
  /** Injected so tests do not wait. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface FetchedPage {
  url: string;
  status: number;
  html: string;
  etag: string | null;
  lastModified: string | null;
  /** True when the server said the content had not changed. */
  notModified: boolean;
}

/** Only official Help Center support pages are ever fetched. */
export function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== KNOWLEDGE_HOST) return false;
    return parsed.pathname.startsWith(KNOWLEDGE_PREFIX);
  } catch {
    return false;
  }
}

/** Drops the fragment and any tracking query, so one page has one identity. */
export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HelpCenterCrawler {
  private fetched = 0;

  private lastRequestAt = 0;

  constructor(private readonly options: FetchOptions = {}) {}

  get pagesFetched(): number {
    return this.fetched;
  }

  private get fetcher(): typeof fetch {
    return this.options.fetchImpl ?? fetch;
  }

  private async pace(): Promise<void> {
    const delay = this.options.delayMs ?? 1000;
    const sleep = this.options.sleepImpl ?? defaultSleep;
    const waited = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt > 0 && waited < delay) await sleep(delay - waited);
    this.lastRequestAt = Date.now();
  }

  /**
   * Fetches one page, with the conditional headers that make a re-run cheap.
   *
   * Retries a 429 or a 5xx with a widening delay; anything else is returned as
   * it came, because a 404 is an answer and retrying it is just noise.
   */
  async fetchPage(
    url: string,
    conditional: { etag?: string | null; lastModified?: string | null } = {},
  ): Promise<FetchedPage> {
    if (!isAllowedUrl(url)) {
      throw new Error(`Refusing to fetch ${url}: it is not an official Help Center support page.`);
    }
    if (this.fetched >= (this.options.maxPages ?? 400)) {
      throw new Error('The page limit for this run has been reached.');
    }

    const headers: Record<string, string> = {
      'user-agent':
        this.options.userAgent ??
        'ReadySupport/1.0 (+https://github.com/kjvaughns/readysupportbot) documentation sync',
      accept: 'text/html',
    };
    if (conditional.etag) headers['if-none-match'] = conditional.etag;
    if (conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;

    let attempt = 0;
    for (;;) {
      await this.pace();
      attempt += 1;

      const response = await this.fetcher(url, {
        headers,
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });

      this.fetched += 1;

      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        const backoff = 1000 * 2 ** attempt;
        logger.warn({ url, status: response.status, attempt }, 'Help Center throttled the sync');
        await (this.options.sleepImpl ?? defaultSleep)(backoff);
        continue;
      }

      const notModified = response.status === 304;

      return {
        url,
        status: response.status,
        html: notModified ? '' : await response.text(),
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        notModified,
      };
    }
  }
}

/**
 * Article links on a folder page.
 *
 * Freshdesk article URLs look like `/support/solutions/articles/<id>-<slug>`.
 * Matching that shape means a link to a category, a login page or an
 * attachment is not mistaken for an article.
 */
export function articleLinksIn(html: string, baseUrl: string): string[] {
  const found = new Set<string>();
  const pattern = /href=["']([^"']+)["']/gi;

  for (const match of html.matchAll(pattern)) {
    let href = match[1];
    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!isAllowedUrl(href)) continue;
    if (!/\/support\/solutions\/articles\/\d+/.test(href)) continue;
    found.add(normalizeUrl(href));
  }

  return [...found];
}

/** Folder links on the solutions index, by the same reasoning. */
export function folderLinksIn(html: string, baseUrl: string): string[] {
  const found = new Set<string>();

  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    let href = match[1];
    try {
      href = new URL(href, baseUrl).toString();
    } catch {
      continue;
    }
    if (!isAllowedUrl(href)) continue;
    if (!/\/support\/solutions\/folders\/\d+/.test(href)) continue;
    found.add(normalizeUrl(href));
  }

  return [...found];
}

/** The `rel="next"` link on a paginated folder, when there is one. */
export function nextPageIn(html: string, baseUrl: string): string | null {
  const match = html.match(/<a[^>]+rel=["']next["'][^>]*href=["']([^"']+)["']/i)
    ?? html.match(/<a[^>]+href=["']([^"']+)["'][^>]*rel=["']next["']/i);
  if (!match) return null;

  try {
    const url = new URL(match[1], baseUrl).toString();
    return isAllowedUrl(url) ? url : null;
  } catch {
    return null;
  }
}
