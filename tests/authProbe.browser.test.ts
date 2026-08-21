import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './support/browser';
import { findContinueCandidates } from '../src/readymode/authProbe';

/**
 * The recorded screen, in a real browser, served over http.
 *
 * A fake cannot answer the question this asks. `hasText` does not see an
 * input's `value`, an element inside a frame is invisible to a page-level
 * locator, and a zero-sized element reports as present. All three would look
 * identical to "no Continue on the page", which is what the recording showed —
 * so all three are reproduced here against real Chromium.
 */

const NOTICE = `
<!doctype html>
<html><body>
  <p>K.Vaughns is already logged in. If you choose to continue, you will log out all your other sessions.</p>
  <form method="post" action="/continue">
    <input type="password" name="password" />
    <!-- Readymode styles controls as links, so the real one may be an anchor. -->
    <a href="/continue" class="button primary" id="continue-link">Continue</a>
    <a href="/cancel" class="button">Cancel</a>
  </form>
  <iframe name="inner" src="/inner"></iframe>
</body></html>`;

const INNER = `
<!doctype html>
<html><body>
  <input type="submit" value="Continue" name="framed" />
  <button style="display:none">Continue</button>
</body></html>`;

let browser: Browser | null = null;
let server: Server | null = null;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  if (!browser) return;

  server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(request.url === '/inner' ? INNER : NOTICE);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
});

describe('finding Continue on the recorded screen', () => {
  it('ran against a real browser', () => {
    expect(browser, 'no browser available').not.toBeNull();
  });

  it('finds the anchor Readymode styles as a button', async () => {
    const candidates = await findContinueCandidates(page);
    const anchor = candidates.find((candidate) => candidate.tag === 'a' && candidate.visible);

    expect(anchor).toBeDefined();
    expect(anchor?.id).toBe('continue-link');
  });

  it('finds an input, whose label lives in its value rather than its text', async () => {
    // `filter({ hasText })` cannot see a value attribute. An input addressed
    // that way matches nothing, which reads exactly like an empty page.
    const candidates = await findContinueCandidates(page);
    const input = candidates.find((candidate) => candidate.tag === 'input');

    expect(input, 'the framed submit input was not found').toBeDefined();
    expect(input?.type).toBe('submit');
  });

  it('searches inside frames, not just the top document', async () => {
    const candidates = await findContinueCandidates(page);
    const frames = new Set(candidates.map((candidate) => candidate.frameName));

    expect(frames.has('main document')).toBe(true);
    expect([...frames].some((name) => name.startsWith('frame'))).toBe(true);
  });

  it('reports a hidden control as present but not visible', async () => {
    const candidates = await findContinueCandidates(page);
    const hidden = candidates.find((candidate) => candidate.tag === 'button' && !candidate.visible);

    // Recorded rather than dropped: "found but invisible" and "not found" have
    // different causes and different fixes.
    expect(hidden).toBeDefined();
    expect(hidden?.width).toBe(0);
  });

  it('never picks Cancel', async () => {
    const candidates = await findContinueCandidates(page);
    expect(candidates.every((candidate) => candidate.text === 'Continue')).toBe(true);
  });

  it('returns nothing but structure — no page text, no field values', async () => {
    const serialized = JSON.stringify(await findContinueCandidates(page));

    expect(serialized).not.toContain('K.Vaughns');
    expect(serialized).not.toContain('already logged in');
    expect(serialized).not.toContain('password');
  });
});
