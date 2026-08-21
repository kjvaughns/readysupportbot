import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { launchBrowser } from './support/browser';
import {
  findContinueFrame,
  findExistingSessionForm,
  submitExistingSessionForm,
} from '../src/readymode/continueSubmit';

/**
 * The screen as it actually is, against real Chromium and a real server.
 *
 *   <form method="post" class="login-form">
 *     <input type="hidden" name="logout_other_sessions" value="on">
 *     <input type="submit" value="Continue" class="button primary primary-1 sign-in">
 *
 * The notice is the login form re-rendered with `logout_other_sessions` already
 * set, so the page is asking for a POST. This proves the POST is made, that it
 * carries the hidden fields, and that the resulting page is the signed-in
 * shell — none of which a fake can answer.
 *
 * The form is deliberately made unclickable: the submit control is covered by a
 * full-page overlay. A click cannot succeed here, which is the point.
 */

let browser: Browser | null = null;
let server: Server | null = null;
let page: Page;
let posted: Array<{ path: string; fields: string[] }> = [];

const NOTICE = `
<!doctype html>
<html><body>
  <p>K.Vaughns is already logged in. If you choose to continue, you will log out all your other sessions.</p>
  <form method="post" action="/login_new/" class="login-form">
    <input type="hidden" name="login_account" value="unread">
    <input type="hidden" name="login_password" value="never-read-this">
    <input type="hidden" name="logout_other_sessions" value="on">
    <input type="hidden" name="then" value="/">
    <input type="hidden" name="use_phone_module" value="1">
    <input type="submit" value="Continue" class="button primary primary-1 sign-in">
    <a href="/cancel">Cancel</a>
  </form>
  <!-- An overlay across the whole viewport: a real click cannot reach the control. -->
  <div style="position:fixed;inset:0;background:rgba(0,0,0,0.01);z-index:9999"></div>
</body></html>`;

const SHELL = `
<!doctype html>
<html><head><title>Readymode Inc. CRM</title></head><body>
  <input id="hotbar_search" placeholder="Search..">
  <select id="CCS_Session_Statebox"><option>Ready</option></select>
  <h1>Dashboard</h1>
</body></html>`;

beforeAll(async () => {
  browser = await launchBrowser();
  if (!browser) return;

  server = createServer((request, response) => {
    if (request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        // Field names only. The values are never inspected, here or anywhere.
        posted.push({
          path: request.url ?? '',
          fields: body
            .split('&')
            .map((pair) => decodeURIComponent(pair.split('=')[0] ?? ''))
            .filter(Boolean),
        });
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(SHELL);
      });
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(NOTICE);
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
}, 60_000);

afterAll(async () => {
  await browser?.close().catch(() => undefined);
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
});

async function openNotice(): Promise<void> {
  const { port } = server!.address() as AddressInfo;
  posted = [];
  page = await browser!.newPage();
  await page.goto(`http://127.0.0.1:${port}/login_new/`, { waitUntil: 'domcontentloaded' });
}

describe('submitting the existing-session form', () => {
  it('ran against a real browser', () => {
    expect(browser, 'no browser available').not.toBeNull();
  });

  it('finds the form even though an overlay blocks the control', async () => {
    await openNotice();
    expect(await findContinueFrame(page)).not.toBeNull();
    await page.close();
  });

  it('POSTs the form and reaches the signed-in shell', async () => {
    await openNotice();

    const result = await submitExistingSessionForm(page);

    expect(result.attempted).toBe(true);
    expect(result.formFound).toBe(true);
    // The faithful mechanism, first try — no click involved.
    expect(result.method).toBe('requestSubmit');
    expect(result.authenticated).toBe(true);
    expect(result.authenticatedMarker).toBe('hotbar search');

    await page.close();
  });

  it('sends the hidden fields, including logout_other_sessions', async () => {
    await openNotice();
    await submitExistingSessionForm(page);

    expect(posted).toHaveLength(1);
    expect(posted[0].path).toBe('/login_new/');
    // This field is why the screen exists: it is what continuing means.
    expect(posted[0].fields).toContain('logout_other_sessions');
    expect(posted[0].fields).toContain('login_account');

    await page.close();
  });

  it('reports the field names without ever reading a value', async () => {
    await openNotice();
    const result = await submitExistingSessionForm(page);

    expect(result.hiddenFieldNames).toContain('logout_other_sessions');
    expect(result.hiddenFieldNames).toContain('login_password');

    // The name of the password field is structure. Its value is not, and
    // nothing in the result carries it.
    expect(JSON.stringify(result)).not.toContain('never-read-this');

    await page.close();
  });

  it('records the form it submitted, by method and path', async () => {
    await openNotice();
    const result = await submitExistingSessionForm(page);

    expect(result.formMethod).toBe('post');
    expect(result.formActionPath).toBe('/login_new/');

    await page.close();
  });

  it('succeeds where a click cannot', async () => {
    await openNotice();

    // The overlay intercepts pointer events, so this is what the click path was
    // up against.
    const clickFailed = await page
      .locator('input[type="submit"][value="Continue"]')
      .click({ timeout: 1500 })
      .then(() => false)
      .catch(() => true);

    expect(clickFailed, 'the overlay should have blocked a real click').toBe(true);

    const result = await submitExistingSessionForm(page);
    expect(result.authenticated).toBe(true);

    await page.close();
  });
});

describe('when the form does not go anywhere', () => {
  it('reports the refusal rather than claiming success', async () => {
    const stubborn = createServer((request, response) => {
      // Answers every POST with the notice again: Readymode refusing.
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(NOTICE);
    });
    await new Promise<void>((resolve) => stubborn.listen(0, '127.0.0.1', resolve));
    const { port } = stubborn.address() as AddressInfo;

    const stubbornPage = await browser!.newPage();
    await stubbornPage.goto(`http://127.0.0.1:${port}/login_new/`, { waitUntil: 'domcontentloaded' });

    const result = await submitExistingSessionForm(stubbornPage);

    expect(result.authenticated).toBe(false);
    expect(result.submitted).toBe(false);
    // Every mechanism was tried, and each is recorded.
    expect(result.attempts.map((attempt) => attempt.method)).toEqual([
      'requestSubmit',
      'formSubmit',
      'click',
    ]);
    expect(result.error).toBeTruthy();

    await stubbornPage.close();
    await new Promise<void>((resolve) => stubborn.close(() => resolve()));
  }, 120_000);
});

describe('recognizing the screen from its structure', () => {
  it('identifies it by logout_other_sessions, not by any sentence', async () => {
    await openNotice();

    const detected = await findExistingSessionForm(page);

    expect(detected).not.toBeNull();
    expect(detected?.hasLogoutOtherSessions).toBe(true);
    expect(detected?.hasContinueSubmit).toBe(true);
    expect(detected?.formMethod).toBe('post');

    await page.close();
  });

  it('is unaffected by whatever else the page says', async () => {
    // The real page carries a footer reading "If you are not authorized to
    // access Readymode Inc.'s software..." — which a text classifier read as a
    // refusal, so the notice was never acted on. The form does not care.
    const { port } = server!.address() as AddressInfo;
    const noisy = await browser!.newPage();
    await noisy.goto(`http://127.0.0.1:${port}/login_new/`, { waitUntil: 'domcontentloaded' });
    await noisy.evaluate(() => {
      const footer = document.createElement('div');
      footer.textContent =
        "If you are not authorized to access Readymode Inc.'s software, please close this browser window/tab.";
      document.body.appendChild(footer);
    });

    const detected = await findExistingSessionForm(noisy);
    expect(detected?.found).toBe(true);

    await noisy.close();
  });

  it('does not fire on an ordinary login form', async () => {
    const plain = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<form method="post" class="login-form">
        <input type="password" name="password">
        <input type="submit" value="Sign in">
      </form>`);
    });
    await new Promise<void>((resolve) => plain.listen(0, '127.0.0.1', resolve));
    const { port } = plain.address() as AddressInfo;

    const plainPage = await browser!.newPage();
    await plainPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });

    // No logout_other_sessions, no Continue: not this screen.
    expect(await findExistingSessionForm(plainPage)).toBeNull();

    await plainPage.close();
    await new Promise<void>((resolve) => plain.close(() => resolve()));
  });

  it('reports the field names without reading a single value', async () => {
    await openNotice();
    const detected = await findExistingSessionForm(page);

    expect(detected?.hiddenFieldNames).toContain('logout_other_sessions');
    expect(detected?.hiddenFieldNames).toContain('login_password');
    expect(JSON.stringify(detected)).not.toContain('never-read-this');

    await page.close();
  });
});
