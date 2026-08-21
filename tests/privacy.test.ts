import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './support/browser';
import { inspectCurrentPage } from '../src/readymode/discovery/inspector';
import { scrubDeep, scrubPersonalData } from '../src/security/personalData';
import { redact } from '../src/security/redaction';

/**
 * The privacy rules, checked against the code and against a real browser.
 *
 * ReadySupport must never read, log, store, return or send passwords, cookies,
 * session tokens, authentication headers, customer or lead information, phone
 * numbers, email addresses, input field values, or the contents of a user
 * table. Evidence is metadata: labels, element types, routes, frame names,
 * table headers, selector attributes.
 *
 * A page designed to tempt every one of those out of the collector is below.
 */

const TEMPTING_PAGE = `
<!doctype html>
<html>
  <head><title>License Usage</title></head>
  <body>
    <h1>License Usage</h1>

    <form>
      <label for="user">User Account</label>
      <input id="user" name="username" type="text" value="jsmith" />

      <label for="pwd">Password</label>
      <input id="pwd" name="password" type="password" value="hunter2-do-not-read" />

      <label for="phone">Phone</label>
      <input id="phone" name="phone" type="tel" value="415-555-0134" />

      <label><input type="checkbox" name="active" checked /> Active</label>

      <select id="owner" name="owner">
        <option value="1" selected>Barbara Jones</option>
      </select>
    </form>

    <table id="license-table">
      <thead>
        <tr><th>User Id</th><th>User Account</th><th>User Name</th><th>License Type</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>4821</td><td>jsmith</td><td>John Smith</td><td>Agent</td>
          <td><a id="sign-out-btn" class="button primary" href="#">Sign Out</a></td>
        </tr>
        <tr>
          <td>4822</td><td>bjones</td><td>Barbara Jones</td><td>Agent</td>
          <td><a id="sign-out-btn" class="button primary" href="#">Sign Out</a></td>
        </tr>
      </tbody>
    </table>

    <p>Lead: Maria Alvarez, maria.alvarez@example.com, 415-555-0199, 88 Willow Lane</p>
  </body>
</html>`;

let browser: Browser | null = null;
let server: Server | null = null;
let page: Page;
let evidenceText = '';

beforeAll(async () => {
  browser = await launchBrowser();
  if (!browser) return;

  // Served over http rather than set directly: cookies and localStorage need a
  // real origin, and a collector that cannot reach them has not been tested
  // against them.
  server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html',
      'set-cookie': 'session=super-secret-session-token; Path=/',
    });
    response.end(TEMPTING_PAGE);
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('access_token', 'sk-live-should-never-appear');
  });

  const evidence = await inspectCurrentPage(
    page,
    'privacy',
    { personalDataDropped: 0, passwordFieldsSeen: 0 },
    { screenshot: false },
  );

  evidenceText = JSON.stringify(evidence);
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
});

describe('the collector, read as source', () => {
  const source = readFileSync(
    join(__dirname, '..', 'src', 'readymode', 'discovery', 'collector.ts'),
    'utf8',
  );

  /** The source with its comments removed, so a comment cannot fail a scan. */
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('never reads a field value', () => {
    // `getAttribute('value')` on a button is that button's label — its own
    // markup. Reading the live `.value` property is reading what somebody typed.
    expect(code).not.toMatch(/\.value\b(?!\s*=)/);
    expect(code).not.toMatch(/\bdefaultValue\b/);
  });

  it('never reads whether a box is ticked', () => {
    expect(code).not.toMatch(/\.checked\b/);
  });

  it('never touches cookies or storage', () => {
    expect(code).not.toMatch(/document\.cookie/);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });

  it('never reads the body of a table', () => {
    // Headings and repeated control labels only. `td` appears solely inside the
    // row-control query, which reads control labels, not cells.
    expect(code).not.toMatch(/tbody\s+td|querySelectorAll\('td'\)/);
  });
});

describe('evidence from a page full of things it must not take', () => {
  it('ran against a real browser', () => {
    expect(browser, 'no browser available').not.toBeNull();
    expect(evidenceText.length).toBeGreaterThan(100);
  });

  it('carries no password, cookie or token', () => {
    expect(evidenceText).not.toContain('hunter2-do-not-read');
    expect(evidenceText).not.toContain('super-secret-session-token');
    expect(evidenceText).not.toContain('sk-live-should-never-appear');
  });

  it('carries no value anybody typed', () => {
    expect(evidenceText).not.toContain('jsmith');
    expect(evidenceText).not.toContain('415-555-0134');
  });

  it('carries no lead or customer information', () => {
    expect(evidenceText).not.toContain('Maria Alvarez');
    expect(evidenceText).not.toContain('maria.alvarez@example.com');
    expect(evidenceText).not.toContain('88 Willow Lane');
  });

  it('carries no row from the user table', () => {
    expect(evidenceText).not.toContain('John Smith');
    expect(evidenceText).not.toContain('4821');
  });

  it('withholds the options of a dropdown that lists people', () => {
    // Found by this test: an owner picker's options are names, and no pattern
    // can tell a person's name from a campaign's. The count is kept; the
    // labels are not, and the record says so.
    expect(evidenceText).not.toContain('Barbara Jones');

    const evidence = JSON.parse(evidenceText);
    const selects = evidence.roots.flatMap((root: { selects: unknown[] }) => root.selects);
    const owner = (selects as Array<{ id?: string; optionsWithheld?: boolean; optionCount: number }>).find(
      (select) => select.id === 'owner',
    );

    expect(owner?.optionsWithheld).toBe(true);
    expect(owner?.optionCount).toBe(1);
  });

  it('does keep the structure it needs to work', () => {
    // The column headings, which identify the table.
    expect(evidenceText).toContain('User Id');
    expect(evidenceText).toContain('License Type');
    // The repeated row control, which is a label and not a person.
    expect(evidenceText).toContain('Sign Out');
    // The panel heading, which says where the session is.
    expect(evidenceText).toContain('License Usage');
    // Field identity, without field contents.
    expect(evidenceText).toContain('password');
  });

  it('counts what it refused to look at', () => {
    const evidence = JSON.parse(evidenceText);
    const inputs = evidence.roots.flatMap((root: { inputs: unknown[] }) => root.inputs);
    const passwordField = (inputs as Array<{ type: string; sensitive: boolean }>).find(
      (input) => input.type === 'password',
    );

    expect(passwordField?.sensitive).toBe(true);
    // A password field keeps its structural identity and nothing else.
    expect(Object.keys(passwordField ?? {})).not.toContain('placeholder');
  });
});

describe('scrubbing, wherever text travels', () => {
  it('masks personal data before it reaches a log, a record or a model', () => {
    const scrubbed = scrubPersonalData(
      'Call Maria at 415-555-0199 or maria.alvarez@example.com about 88 Willow Lane.',
    );

    expect(scrubbed.text).not.toContain('415-555-0199');
    expect(scrubbed.text).not.toContain('maria.alvarez@example.com');
    expect(scrubbed.dropped).toEqual(expect.arrayContaining(['email', 'phone']));
  });

  it('leaves structural identifiers intact, so selectors keep working', () => {
    const scrubbed = scrubDeep(
      { id: 'uMgmtViewFolderBut', cssPath: 'table:nth-of-type(2) > tbody > tr', name: 'username' },
      { dropped: 0 },
    ) as Record<string, string>;

    expect(scrubbed.id).toBe('uMgmtViewFolderBut');
    expect(scrubbed.cssPath).toBe('table:nth-of-type(2) > tbody > tr');
    expect(scrubbed.name).toBe('username');
  });

  it('redacts secrets out of anything that gets logged', () => {
    const redacted = redact({
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      password: 'hunter2',
      cookie: 'session=abc',
      note: 'safe to keep',
    }) as Record<string, unknown>;

    const text = JSON.stringify(redacted);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(text).not.toContain('session=abc');
    expect(text).toContain('safe to keep');
  });
});
