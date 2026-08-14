import type { Locator } from 'playwright-core';
import type { CheckLicenseUsageAction } from '../../domain/actions.js';
import { sanitizeObservedText } from '../../nlp/guards.js';
import { normalizeForComparison } from '../../util/text.js';
import { goToRoute, locate, readText } from '../browser.js';
import { getRoute, getSelector, UNKNOWN } from '../selectors.js';
import { requirePage } from '../session.js';
import { runWorkflow } from '../workflowRunner.js';
import type { LicenseUsage, ReadymodeAccount, WorkflowContext, WorkflowResult } from '../port.js';

/**
 * Who is consuming licenses right now.
 *
 * Read-only. The interesting part is what it does not do: it reports what the
 * license view shows and nothing more. It does not open each agent to fill in
 * missing detail, because a list of twenty agents would become twenty page
 * loads, and it does not fall back to the cached directory, because a cache
 * would answer a question about *right now* with something that was true
 * earlier.
 */

export const CHECK_LICENSE_USAGE_SELECTORS = ['page.licenses.marker', 'licenses.row'] as const;
export const CHECK_LICENSE_USAGE_ROUTES = ['route.licenses'] as const;

async function readCell(row: Locator, selectorId: string): Promise<string | undefined> {
  if (getSelector(selectorId).value === UNKNOWN) return undefined;
  const text = await readText(row, selectorId, 1_500);
  return text ? sanitizeObservedText(text, 120) : undefined;
}

function statusFlags(status: string | undefined): Pick<ReadymodeAccount, 'loggedIn' | 'onCall'> {
  if (!status) return {};
  const normalized = status.toLowerCase();

  const onCall = /on a call|on call|in call|talking|connected/.test(normalized);
  const loggedIn = onCall || /logged in|signed in|online|available|ready/.test(normalized);

  return { loggedIn, onCall };
}

async function readTotal(page: Locator, selectorId: string): Promise<number | undefined> {
  if (getSelector(selectorId).value === UNKNOWN) return undefined;
  const text = await readText(page, selectorId, 1_500);
  if (!text) return undefined;

  const digits = /\d+/.exec(text.replace(/,/g, ''));
  if (!digits) return undefined;

  const parsed = Number.parseInt(digits[0], 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function checkLicenseUsage(
  action: CheckLicenseUsageAction,
  context: WorkflowContext,
): Promise<WorkflowResult<LicenseUsage>> {
  return runWorkflow<LicenseUsage>({
    name: 'check license usage',
    selectorIds: CHECK_LICENSE_USAGE_SELECTORS,
    routeIds: CHECK_LICENSE_USAGE_ROUTES,
    context,

    async run({ page }) {
      await goToRoute(page, getRoute('route.licenses').path);
      await requirePage(page, 'page.licenses.marker', 'the license view');

      const rows = locate(page, 'licenses.row');

      let count = 0;
      try {
        await rows.first().waitFor({ state: 'visible', timeout: 8_000 });
        count = await rows.count();
      } catch {
        // No rows is a legitimate answer: nobody is holding a license.
        count = 0;
      }

      const holders: ReadymodeAccount[] = [];

      for (let index = 0; index < count; index += 1) {
        const row = rows.nth(index);
        const [agent, licenseType, status] = await Promise.all([
          readCell(row, 'licenses.row.agent'),
          readCell(row, 'licenses.row.licenseType'),
          readCell(row, 'licenses.row.status'),
        ]);

        // Filtering happens here rather than by typing into the page, because
        // a filter control is one more thing that has to be mapped and one
        // more thing that can silently change what is on screen.
        if (
          action.licenseType &&
          licenseType &&
          normalizeForComparison(licenseType) !== normalizeForComparison(action.licenseType)
        ) {
          continue;
        }

        holders.push({
          ...(agent ? { fullName: agent } : {}),
          ...(licenseType ? { licenseType } : {}),
          ...(status ? { statusText: status } : {}),
          licenseInUse: true,
          ...statusFlags(status),
        });
      }

      const body = page.locator('body');
      const totalInUse = await readTotal(body, 'licenses.total.inUse');
      const totalAvailable = await readTotal(body, 'licenses.total.available');

      return {
        data: {
          holders,
          totalInUse: totalInUse ?? holders.length,
          ...(totalAvailable === undefined ? {} : { totalAvailable }),
        },
        verified: true,
        evidenceLabel: 'license-usage',
      };
    },
  });
}
