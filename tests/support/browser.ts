import { chromium, type Browser } from 'playwright-core';

/**
 * A real Chromium, when one is available.
 *
 * The browser-side collector cannot be proven by a fake: the bug it is guarding
 * against was a wrong argument shape crossing the Node/browser boundary, which
 * only a real `page.evaluate` exercises.
 *
 * The image's browser build can differ from the one playwright-core expects, so
 * the executable is located explicitly and the suite skips rather than fails
 * where no browser exists.
 */

const CANDIDATE_PATHS = [
  process.env.READYSUPPORT_CHROMIUM_PATH,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean) as string[];

export async function launchBrowser(): Promise<Browser | null> {
  for (const executablePath of CANDIDATE_PATHS) {
    try {
      return await chromium.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
    } catch {
      // Try the next candidate.
    }
  }

  try {
    return await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch {
    return null;
  }
}
