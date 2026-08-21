import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './support/browser';
import { collectFromRoot } from '../src/readymode/discovery/collector';
import { EVIDENCE_CAPS, STABLE_ATTRIBUTES } from '../src/readymode/discovery/evidence';
import { inspectCurrentPage } from '../src/readymode/discovery/inspector';

/**
 * Runs the collector in a real browser, through a real `page.evaluate`, with the
 * real argument.
 *
 * This is the test that would have caught the bug: the collector took two
 * positional parameters while `evaluate` passes exactly one, so
 * `stableAttributes` arrived undefined and every root threw before collecting
 * anything. The failure was swallowed into empty evidence, so discovery
 * reported pages captured and zero controls found.
 */

const PAGE = `
<!doctype html>
<html>
  <head><title>Readymode Admin</title></head>
  <body>
    <nav>
      <a href="/users">Users</a>
      <a href="/campaigns">Campaigns</a>
    </nav>

    <form action="/admin/save" method="post" id="agent-form">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" placeholder="Login" required />

      <label for="pwd">Password</label>
      <input id="pwd" name="password" type="password" />

      <label for="states">States</label>
      <select id="states" name="states" multiple>
        <option value="TX">Texas</option>
        <option value="VA">Virginia</option>
      </select>

      <label><input type="checkbox" name="playlist_gold" value="Gold" /> Gold</label>

      <button type="submit" data-testid="save-agent">Save</button>
      <button type="button">Log Out Inactive Users</button>
    </form>

    <table>
      <thead><tr><th>User</th><th>Status</th></tr></thead>
      <tbody><tr><td>Jane Doe</td><td>Ready</td></tr></tbody>
    </table>

    <iframe name="body" srcdoc="&lt;button&gt;Inside Frame&lt;/button&gt;"></iframe>
  </body>
</html>`;

let browser: Browser | null = null;
let page: Page;

beforeAll(async () => {
  browser = await launchBrowser();
  if (!browser) return;
  page = await browser.newPage();
  await page.setContent(PAGE, { waitUntil: 'load' });
});

afterAll(async () => {
  await browser?.close().catch(() => undefined);
});

describe('collector in a real browser', () => {
  it('has a browser to run against', () => {
    // Stated explicitly: without this, every assertion below would pass
    // vacuously and the suite would look green while proving nothing.
    expect(browser, 'no Chromium available — the collector was not exercised').toBeTruthy();
  });

  it('is called with one object argument and returns evidence', async () => {
    if (!browser) return;

    const result = await page.evaluate(collectFromRoot, {
      caps: EVIDENCE_CAPS,
      stableAttributes: STABLE_ATTRIBUTES,
    });

    expect(result.title).toBe('Readymode Admin');

    // The exact symptom of the bug: everything empty.
    expect(result.buttons.length).toBeGreaterThan(0);
    expect(result.inputs.length).toBeGreaterThan(0);
    expect(result.links.length).toBeGreaterThan(0);
    expect(result.tables.length).toBeGreaterThan(0);
    expect(result.nav.length).toBeGreaterThan(0);
    expect(result.selects.length).toBeGreaterThan(0);
    expect(result.checkboxes.length).toBeGreaterThan(0);
    expect(result.forms.length).toBeGreaterThan(0);
  });

  it('reads the stable attributes it was given', async () => {
    if (!browser) return;

    const result = await page.evaluate(collectFromRoot, {
      caps: EVIDENCE_CAPS,
      stableAttributes: STABLE_ATTRIBUTES,
    });

    const save = result.buttons.find((button) => button.attrs?.['data-testid'] === 'save-agent');
    expect(save, 'the data-testid attribute was not read').toBeTruthy();
    expect(save!.label).toBe('Save');
  });

  it('captures labels, types and option values without reading any value', async () => {
    if (!browser) return;

    // A value that must never appear anywhere in the evidence.
    await page.fill('#username', 'secret-typed-value');

    const result = await page.evaluate(collectFromRoot, {
      caps: EVIDENCE_CAPS,
      stableAttributes: STABLE_ATTRIBUTES,
    });

    const username = result.inputs.find((input) => input.name === 'username');
    expect(username?.labelText).toBe('Username');
    expect(username?.required).toBe(true);

    const password = result.inputs.find((input) => input.type === 'password');
    expect(password?.sensitive).toBe(true);
    expect(password?.placeholder).toBeUndefined();

    expect(result.selects[0].optionValues).toEqual(['TX', 'VA']);
    expect(result.tables[0].headings).toEqual(['User', 'Status']);

    // Table bodies and input values are never collected.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-typed-value');
    expect(serialized).not.toContain('Jane Doe');
  });

  it('finds the frame as well as the page', async () => {
    if (!browser) return;

    const counters = { personalDataDropped: 0, passwordFieldsSeen: 0 };
    const evidence = await inspectCurrentPage(page, 'test', counters, { screenshot: false });

    expect(evidence.roots.length).toBeGreaterThan(1);
    expect(evidence.roots.every((root) => !root.error), JSON.stringify(evidence.roots.map((r) => r.error))).toBe(true);

    const frame = evidence.roots.find((root) => !root.isMain);
    expect(frame?.buttons.some((button) => button.label === 'Inside Frame')).toBe(true);
    expect(counters.passwordFieldsSeen).toBeGreaterThan(0);
  });
});
