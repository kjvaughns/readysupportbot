import type { Locator, Page } from 'playwright-core';
import type { AccountRef } from '../domain/actions.js';
import { errorFor } from '../domain/errors.js';
import { sanitizeObservedText } from '../nlp/guards.js';
import { moduleLogger } from '../util/logger.js';
import { confirmPage, goToRoute, isVisibleIfConfigured, locate, readText } from './browser.js';
import { requireUniqueMatch } from './matching.js';
import { getRoute, getSelector, UNKNOWN } from './selectors.js';
import type { ReadymodeAccount } from './port.js';

/**
 * Reading agents out of the Readymode interface.
 *
 * Everything here treats what is on the page as untrusted. An agent name, a
 * campaign, a status banner — any of those is text somebody typed into a form
 * at some point, and it is sanitized before it is compared, displayed, logged
 * or put in an audit record. None of it is ever interpreted as an instruction.
 */

const log = moduleLogger('agents');

/** Selector ids needed to search the agent list. */
export const SEARCH_SELECTORS = [
  'page.agents.marker',
  'agents.search.input',
  'agents.results.row',
] as const;

/** Selector ids needed to read a single agent's page. */
export const DETAIL_SELECTORS = ['page.agentDetail.marker'] as const;

async function cell(row: Locator, selectorId: string): Promise<string | undefined> {
  const spec = getSelector(selectorId);
  if (spec.value === UNKNOWN) return undefined;

  const text = await readText(row, selectorId, 1_500);
  return text ? sanitizeObservedText(text, 120) : undefined;
}

/** Turn one result row into an account. */
async function readRow(row: Locator): Promise<ReadymodeAccount> {
  const [readymodeUserId, username, email, fullName] = await Promise.all([
    cell(row, 'agents.row.userId'),
    cell(row, 'agents.row.username'),
    cell(row, 'agents.row.email'),
    cell(row, 'agents.row.fullName'),
  ]);

  return {
    ...(readymodeUserId ? { readymodeUserId } : {}),
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
    ...(fullName ? { fullName } : {}),
  };
}

/** The most specific text we have for a reference, used as the search term. */
export function searchTermFor(ref: AccountRef): string {
  return ref.username ?? ref.email ?? ref.readymodeUserId ?? ref.fullName ?? '';
}

/**
 * Search the agent list and return every row that came back.
 *
 * Deliberately returns all of them rather than picking one: choosing is the
 * matcher's job, and it refuses to choose when the answer is not unique.
 */
export async function searchAgents(page: Page, term: string): Promise<ReadymodeAccount[]> {
  await goToRoute(page, getRoute('route.agents').path);
  // Confirm where we are before typing into anything.
  await confirmPage(page, 'page.agents.marker', 'the agent list');

  const searchBox = locate(page, 'agents.search.input').first();
  await searchBox.fill(term);

  // Some instances filter as you type; others need the search submitted. The
  // button is optional in the registry for exactly that reason.
  if (getSelector('agents.search.submit').value !== UNKNOWN) {
    await locate(page, 'agents.search.submit').first().click();
  } else {
    await searchBox.press('Enter').catch(() => undefined);
  }

  // Bounded deliberately: a page that never goes fully quiet should not hold a
  // job for the whole navigation timeout. The row wait below is the real check.
  await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);

  const rows = locate(page, 'agents.results.row');

  let count: number;
  try {
    await rows.first().waitFor({ state: 'visible', timeout: 8_000 });
    count = await rows.count();
  } catch {
    // No rows appeared. When an empty-state marker is mapped, confirm that is
    // what happened rather than a page that failed to render.
    const emptyState = await isVisibleIfConfigured(page, 'agents.results.empty.marker', 2_000);
    if (!emptyState) {
      log.debug({ term }, 'Search returned no rows and no empty-state marker');
    }
    return [];
  }

  const accounts: ReadymodeAccount[] = [];
  for (let index = 0; index < count; index += 1) {
    accounts.push(await readRow(rows.nth(index)));
  }

  return accounts;
}

/**
 * Open a single agent from the result list.
 *
 * Takes the row index the matcher settled on rather than re-searching, so
 * there is no window in which the list could change between deciding and
 * clicking.
 */
export async function openAgentAtIndex(page: Page, index: number): Promise<void> {
  const rows = locate(page, 'agents.results.row');
  const row = rows.nth(index);

  const openSpec = getSelector('agents.row.open');
  if (openSpec.value !== UNKNOWN) {
    await locate(row, 'agents.row.open').first().click();
  } else {
    await row.click();
  }

  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
}

/**
 * Interpret a status cell without inventing meaning that is not there.
 *
 * Negatives are checked first, and that ordering is load-bearing. English
 * status text buries the positive inside the negative: "Deactivated" contains
 * "active", "No license assigned" contains "assigned", "Not on a call"
 * contains "on a call". Checking positives first reads every one of those
 * backwards — and reading "deactivated" as active is exactly how a workflow
 * concludes it succeeded when it did nothing at all.
 *
 * Text matching neither list returns undefined, which callers treat as "could
 * not determine" and refuse to act on.
 */
function readsAs(text: string | undefined, positives: string[], negatives: string[]): boolean | undefined {
  if (!text) return undefined;
  const normalized = text.toLowerCase();
  if (negatives.some((phrase) => normalized.includes(phrase))) return false;
  if (positives.some((phrase) => normalized.includes(phrase))) return true;
  return undefined;
}

/**
 * Read everything the agent page shows about one account.
 *
 * Any field whose selector is unmapped simply comes back absent. A workflow
 * that genuinely needs a field declares it in its selector list and is stopped
 * before it starts if it is missing, so an absent value here always means
 * "Readymode does not show this", never "we forgot to look".
 */
export async function readAgentDetail(page: Page): Promise<ReadymodeAccount> {
  const [
    readymodeUserId,
    username,
    email,
    fullName,
    agentRole,
    licenseType,
    team,
    campaign,
    queue,
    activeText,
    licenseText,
    loginText,
    callText,
  ] = await Promise.all([
    cell(page.locator('body'), 'agent.detail.userId'),
    cell(page.locator('body'), 'agent.detail.username'),
    cell(page.locator('body'), 'agent.detail.email'),
    cell(page.locator('body'), 'agent.detail.fullName'),
    cell(page.locator('body'), 'agent.detail.role'),
    cell(page.locator('body'), 'agent.detail.licenseType'),
    cell(page.locator('body'), 'agent.detail.team'),
    cell(page.locator('body'), 'agent.detail.campaign'),
    cell(page.locator('body'), 'agent.detail.queue'),
    cell(page.locator('body'), 'agent.detail.activeState'),
    cell(page.locator('body'), 'agent.detail.licenseState'),
    cell(page.locator('body'), 'agent.detail.loginState'),
    cell(page.locator('body'), 'agent.detail.callState'),
  ]);

  const active = readsAs(
    activeText,
    ['active', 'enabled'],
    ['inactive', 'deactivated', 'disabled', 'suspended'],
  );
  const licenseInUse = readsAs(
    licenseText,
    ['in use', 'assigned', 'active'],
    ['no license', 'not assigned', 'unassigned', 'not in use', 'none', 'available'],
  );
  const loggedIn = readsAs(
    loginText,
    ['logged in', 'signed in', 'online'],
    ['logged out', 'signed out', 'not logged in', 'offline'],
  );
  const onCall = readsAs(
    callText,
    ['on a call', 'on call', 'in call', 'talking', 'connected'],
    ['not on a call', 'no call', 'idle', 'available'],
  );

  return {
    ...(readymodeUserId ? { readymodeUserId } : {}),
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
    ...(fullName ? { fullName } : {}),
    ...(agentRole ? { agentRole } : {}),
    ...(licenseType ? { licenseType } : {}),
    ...(team ? { team } : {}),
    ...(campaign ? { campaign } : {}),
    ...(queue ? { queue } : {}),
    ...(active === undefined ? {} : { active }),
    ...(licenseInUse === undefined ? {} : { licenseInUse }),
    ...(loggedIn === undefined ? {} : { loggedIn }),
    ...(onCall === undefined ? {} : { onCall }),
    ...(activeText || licenseText || loginText || callText
      ? { statusText: sanitizeObservedText([activeText, licenseText, loginText, callText].filter(Boolean).join(' · '), 200) }
      : {}),
  };
}

/**
 * Find exactly one agent and open its page.
 *
 * Returns the account as read from the list plus the index it was found at, so
 * the caller can open it without searching again.
 */
export async function findOne(
  page: Page,
  ref: AccountRef,
  describe: string,
): Promise<{ account: ReadymodeAccount; index: number; candidates: ReadymodeAccount[] }> {
  const term = searchTermFor(ref);
  if (!term) {
    throw errorFor('NO_MATCH', {
      message: 'I was not given anything specific enough to search for.',
    });
  }

  const candidates = await searchAgents(page, term);
  const { account } = requireUniqueMatch(ref, candidates, describe);

  const index = candidates.indexOf(account);
  return { account, index: index < 0 ? 0 : index, candidates };
}
