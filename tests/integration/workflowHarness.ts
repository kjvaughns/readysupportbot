import { chromium, type Browser, type Page } from 'playwright-core';
import { vi } from 'vitest';
import { applyOverlay, DEFAULT_ROUTES, DEFAULT_SELECTORS, setRegistry } from '../../src/readymode/selectors.js';
import { FIXTURE_OVERLAY, ReadymodeFixture, type FixtureOptions } from '../fixtures/readymodeFixtureServer.js';
import type { WorkflowContext } from '../../src/readymode/port.js';

/**
 * The harness the workflow integration tests share.
 *
 * A real Chromium drives a real page against the fixture app. What is mocked
 * is only what would reach outside this machine: the Browserbase session
 * (replaced with a local browser), the evidence upload, and the two database
 * repositories the session layer writes to.
 *
 * Everything under test is the actual production code path — the same
 * workflowRunner, the same session checks, the same selector resolution, the
 * same matching. That is the point: a workflow that clicks the wrong thing,
 * skips its verification step, or acts in dry run fails here.
 */

let browser: Browser | undefined;

/** Chromium is preinstalled in this environment; do not download one. */
const EXECUTABLE_PATH = process.env['PLAYWRIGHT_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium';

export async function launchBrowser(): Promise<Browser> {
  if (browser) return browser;

  try {
    browser = await chromium.launch({ headless: true, executablePath: EXECUTABLE_PATH });
  } catch {
    // Fall back to whatever Playwright can find on its own.
    browser = await chromium.launch({ headless: true });
  }

  return browser;
}

export async function closeBrowser(): Promise<void> {
  await browser?.close();
  browser = undefined;
}

/** Install the selector map matching the fixture markup. */
export function installFixtureSelectors(): void {
  const registry = {
    routes: structuredClone(DEFAULT_ROUTES),
    selectors: structuredClone(DEFAULT_SELECTORS),
    overlayPath: 'test-fixture',
    loadedAt: new Date().toISOString(),
  };

  applyOverlay(FIXTURE_OVERLAY, registry);
  setRegistry({ routes: registry.routes, selectors: registry.selectors });
}

/** Leave the registry as it ships: everything UNKNOWN. */
export function installEmptySelectors(): void {
  setRegistry(undefined);
}

export interface Harness {
  fixture: ReadymodeFixture;
  baseUrl: string;
  page: Page;
  /** Sessions the workflow runner opened, so tests can assert they closed. */
  opened: Array<{ closed: boolean; status?: string }>;
  stop(): Promise<void>;
}

/**
 * Start a fixture server, point the environment at it, and make openSession()
 * hand back a page on the local browser rather than a Browserbase one.
 */
export async function startHarness(options: FixtureOptions = {}): Promise<Harness> {
  const fixture = new ReadymodeFixture(options);
  const baseUrl = await fixture.start();

  process.env['READYMODE_LOGIN_URL'] = `${baseUrl}/login`;
  process.env['READYMODE_ADMIN_USERNAME'] = options.username ?? 'admin';
  process.env['READYMODE_ADMIN_PASSWORD'] = options.password ?? 'correct-horse-battery';

  const { resetEnvCache } = await import('../../src/config/env.js');
  resetEnvCache();

  const activeBrowser = await launchBrowser();
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(5_000);

  const opened: Harness['opened'] = [];

  const browserModule = await import('../../src/readymode/browser.js');
  vi.spyOn(browserModule, 'openSession').mockImplementation(async () => {
    const record = { closed: false } as { closed: boolean; status?: string };
    opened.push(record);

    return {
      browser: activeBrowser,
      context,
      page,
      sessionId: 'test-session',
      recordId: 'test-record',
      async close(status = 'CLOSED') {
        record.closed = true;
        record.status = status;
      },
    };
  });

  installFixtureSelectors();

  return {
    fixture,
    baseUrl,
    page,
    opened,
    async stop() {
      vi.restoreAllMocks();
      await context.close();
      await fixture.stop();
      setRegistry(undefined);
    },
  };
}

export function workflowContext(overrides: Partial<WorkflowContext> = {}): WorkflowContext {
  return { requestId: 'req-test', reference: 1042, dryRun: false, ...overrides };
}
