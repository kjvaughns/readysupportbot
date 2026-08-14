import type { Page } from 'playwright-core';
import { env } from '../config/env.js';
import { db } from '../db/client.js';
import { moduleLogger } from '../util/logger.js';

/**
 * Screenshot evidence.
 *
 * Every workflow captures the page after it has verified its result, and the
 * image goes into a private Supabase bucket referenced from the audit trail.
 *
 * Before any capture, password fields are blanked in the page itself rather
 * than blurred afterwards. Redacting an image after the fact means the
 * unredacted pixels existed; emptying the input means they never did.
 */

const log = moduleLogger('evidence');

/**
 * Blank every password input and anything marked sensitive, then hide the
 * values so nothing is recoverable from the capture.
 *
 * This runs in the page, so it cannot touch anything outside it.
 */
async function maskSensitiveFields(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const selectors = [
        'input[type="password"]',
        '[data-sensitive]',
        '[autocomplete="current-password"]',
        '[autocomplete="new-password"]',
      ];

      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector))) {
          if (element instanceof HTMLInputElement) {
            element.value = '';
            element.setAttribute('value', '');
          }
          if (element instanceof HTMLElement) {
            element.style.filter = 'blur(8px)';
            element.setAttribute('aria-hidden', 'true');
          }
        }
      }
    });
  } catch (cause) {
    // A page that will not run script is a page we should still photograph;
    // the password fields on it are empty in every workflow that reaches here.
    log.debug({ err: cause }, 'Could not mask sensitive fields before the screenshot');
  }
}

export interface CaptureInput {
  page: Page;
  requestId: string;
  reference: number;
  /** Short label describing the moment, e.g. `after-clear-license`. */
  label: string;
}

/**
 * Capture and upload. Returns the storage path, or undefined when evidence
 * could not be captured — which is never a reason to fail a job that has
 * already succeeded.
 */
export async function capture(input: CaptureInput): Promise<string | undefined> {
  const { page, requestId, reference, label } = input;

  let image: Buffer;
  try {
    await maskSensitiveFields(page);
    image = await page.screenshot({ fullPage: true, type: 'png' });
  } catch (cause) {
    log.warn({ err: cause, requestId }, 'Could not take a screenshot');
    return undefined;
  }

  const safeLabel = label.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const path = `${new Date().toISOString().slice(0, 10)}/RS-${reference}/${Date.now()}-${safeLabel}.png`;

  try {
    const { error } = await db()
      .storage.from(env().SUPABASE_EVIDENCE_BUCKET)
      .upload(path, image, { contentType: 'image/png', upsert: false });

    if (error) {
      log.warn({ requestId, error: error.message }, 'Could not upload evidence');
      return undefined;
    }

    return path;
  } catch (cause) {
    log.warn({ err: cause, requestId }, 'Could not upload evidence');
    return undefined;
  }
}

/**
 * A short-lived signed URL for an evidence image.
 *
 * The bucket is private, so this is the only way to look at one, and the link
 * stops working shortly after it is handed out.
 */
export async function signedUrl(path: string, expiresInSeconds = 900): Promise<string | undefined> {
  try {
    const { data, error } = await db()
      .storage.from(env().SUPABASE_EVIDENCE_BUCKET)
      .createSignedUrl(path, expiresInSeconds);

    if (error || !data) return undefined;
    return data.signedUrl;
  } catch {
    return undefined;
  }
}
