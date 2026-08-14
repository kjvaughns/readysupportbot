import type { Locator, Page } from 'playwright-core';
import { ReadymodeAgent } from '../../types';
import { sanitizePageValue } from '../../security/sanitize';
import { WorkflowNeedsConfigurationError } from '../../security/errors';
import {
  AGENT_CONTROLS,
  ROUTES,
  SAVE_SUCCESS_CONDITIONS,
  STATE_CONTROLS,
} from '../selectors';
import { anyPresent, discover, tryDiscover } from '../selectors/discovery';
import { normalizeState, sortStates } from '../states';
import { assertNoHumanVerification, navigate, WorkflowContext, waitForResult } from './harness';

/**
 * Page-level operations shared by the workflows.
 *
 * Everything read from the page is treated as untrusted display data: names and
 * labels are sanitized, and no text found on a page is ever interpreted as an
 * instruction.
 */

/** Reads the agent directory. */
export async function listAgents(context: WorkflowContext, query?: string): Promise<ReadymodeAgent[]> {
  const { page } = context.session;
  await navigate(context, query ? `${ROUTES.agentSearch}${encodeURIComponent(query)}` : ROUTES.agents);

  const search = await tryDiscover(page, AGENT_CONTROLS.search, { timeoutMs: 1200 });
  if (query && search.locator) {
    await search.locator.fill(query);
    await search.locator.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => undefined);
  }

  const rows = await discover(page, AGENT_CONTROLS.resultRows, { allowFirstOfMany: true });
  const rowLocator = rows.first().locator('xpath=..').locator('tr');
  const candidates = (await rowLocator.count()) > 0 ? rowLocator : rows;

  const total = Math.min(await candidates.count(), 500);
  const agents: ReadymodeAgent[] = [];

  for (let index = 0; index < total; index += 1) {
    const row = candidates.nth(index);
    const agent = await readAgentRow(row);
    if (agent) agents.push(agent);
  }

  return agents;
}

async function readAgentRow(row: Locator): Promise<ReadymodeAgent | null> {
  const cells = row.locator('td');
  const cellCount = await cells.count().catch(() => 0);
  if (cellCount === 0) return null;

  const values: string[] = [];
  for (let index = 0; index < Math.min(cellCount, 12); index += 1) {
    values.push(sanitizePageValue(await cells.nth(index).innerText().catch(() => '')));
  }

  const rowId =
    (await row.getAttribute('data-user-id').catch(() => null)) ??
    (await row.getAttribute('data-id').catch(() => null));

  const email = values.find((value) => value.includes('@')) ?? null;
  const username = values.find((value) => /^[a-z0-9._-]{2,}$/i.test(value) && !value.includes('@'));
  const fullName = values.find((value) => /\s/.test(value) && !value.includes('@')) ?? null;

  const readymodeUserId = rowId ?? username ?? email;
  if (!readymodeUserId) return null;

  const rowText = values.join(' ').toLowerCase();

  return {
    readymodeUserId,
    username: username ?? readymodeUserId,
    fullName,
    email,
    active: !/inactive|disabled|deactivated/.test(rowText),
    loggedIn: /logged in|online|on call|available/.test(rowText),
    licenseInUse: /licen[cs]e/.test(rowText) && !/no licen[cs]e|available/.test(rowText),
  };
}

/** Opens one agent and confirms the page really is that agent. */
export async function openAgent(context: WorkflowContext, agent: ReadymodeAgent): Promise<void> {
  const { page } = context.session;
  await navigate(context, ROUTES.agentDetail(agent.readymodeUserId));
  await assertNoHumanVerification(page);

  const identifier = agent.username || agent.readymodeUserId;
  const confirmed = await waitForResult(
    page,
    async () => {
      const content = sanitizePageValue(await page.innerText('body').catch(() => ''), 20000);
      return content.toLowerCase().includes(String(identifier).toLowerCase());
    },
    { what: 'agent detail page', timeoutMs: 8000 },
  );

  if (!confirmed) {
    throw new WorkflowNeedsConfigurationError(
      `agent detail page for ${sanitizePageValue(identifier)}`,
    );
  }
}

export interface StateControl {
  kind: 'select' | 'checkboxes';
  locator: Locator;
}

/** Locates whichever control Readymode uses for state assignment. */
export async function findStateControl(context: WorkflowContext): Promise<StateControl> {
  const { page } = context.session;

  const select = await tryDiscover(page, STATE_CONTROLS.multiSelect, { timeoutMs: 1200 });
  if (select.locator) return { kind: 'select', locator: select.locator };

  const checkboxes = await tryDiscover(page, STATE_CONTROLS.checkboxContainer, {
    timeoutMs: 1200,
    allowFirstOfMany: true,
  });
  if (checkboxes.locator) {
    const section = await tryDiscover(page, STATE_CONTROLS.section, { timeoutMs: 1200 });
    return { kind: 'checkboxes', locator: section.locator ?? checkboxes.locator };
  }

  // Neither shape was found. Stop rather than guess which control holds states.
  throw new WorkflowNeedsConfigurationError('state assignment');
}

/** Reads the states currently assigned, normalized to postal abbreviations. */
export async function readAssignedStates(context: WorkflowContext): Promise<string[]> {
  const control = await findStateControl(context);
  const found: string[] = [];

  if (control.kind === 'select') {
    const options = control.locator.locator('option');
    const count = await options.count();
    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const selected = await option.evaluate((element: any) => Boolean(element.selected));
      if (!selected) continue;
      const label = sanitizePageValue(await option.innerText().catch(() => ''));
      const value = sanitizePageValue((await option.getAttribute('value')) ?? '');
      const normalized = normalizeState(value) ?? normalizeState(label);
      if (normalized) found.push(normalized);
    }
    return sortStates(found);
  }

  const checkboxes = control.locator.locator('input[type="checkbox"]');
  const count = await checkboxes.count();
  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!(await checkbox.isChecked().catch(() => false))) continue;
    const label = await stateLabelFor(checkbox);
    const normalized = normalizeState(label);
    if (normalized) found.push(normalized);
  }
  return sortStates(found);
}

async function stateLabelFor(checkbox: Locator): Promise<string> {
  const value = (await checkbox.getAttribute('value').catch(() => null)) ?? '';
  if (normalizeState(value)) return value;

  const name = (await checkbox.getAttribute('name').catch(() => null)) ?? '';
  const fromName = name.replace(/^.*?[[_-]([a-z]{2})]?$/i, '$1');
  if (normalizeState(fromName)) return fromName;

  const aria = (await checkbox.getAttribute('aria-label').catch(() => null)) ?? '';
  if (normalizeState(aria)) return aria;

  const parentText = await checkbox
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  return sanitizePageValue(parentText, 60);
}

/**
 * Applies the target set of states. Returns false when the control could not be
 * driven, so the caller can stop instead of reporting a change that never
 * happened.
 */
export async function writeAssignedStates(
  context: WorkflowContext,
  target: string[],
): Promise<boolean> {
  const control = await findStateControl(context);
  const wanted = new Set(sortStates(target));

  if (control.kind === 'select') {
    const options = control.locator.locator('option');
    const count = await options.count();
    const values: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const option = options.nth(index);
      const label = sanitizePageValue(await option.innerText().catch(() => ''));
      const value = sanitizePageValue((await option.getAttribute('value')) ?? '');
      const normalized = normalizeState(value) ?? normalizeState(label);
      if (normalized && wanted.has(normalized)) values.push(value || label);
    }

    if (values.length !== wanted.size) return false;
    await control.locator.selectOption(values.map((value) => ({ value })));
    return true;
  }

  const checkboxes = control.locator.locator('input[type="checkbox"]');
  const count = await checkboxes.count();
  const seen = new Set<string>();

  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    const normalized = normalizeState(await stateLabelFor(checkbox));
    if (!normalized) continue;
    seen.add(normalized);

    const shouldBeChecked = wanted.has(normalized);
    const isChecked = await checkbox.isChecked().catch(() => false);
    if (shouldBeChecked === isChecked) continue;

    if (shouldBeChecked) await checkbox.check({ timeout: 5000 });
    else await checkbox.uncheck({ timeout: 5000 });
  }

  // Every requested state has to exist as a control on the page.
  return [...wanted].every((state) => seen.has(state));
}

/** Saves the agent form and waits for a success signal. */
export async function saveAgentForm(context: WorkflowContext): Promise<boolean> {
  const { page } = context.session;

  const save =
    (await tryDiscover(page, STATE_CONTROLS.save, { timeoutMs: 1200 })).locator ??
    (await discover(page, AGENT_CONTROLS.saveButton));

  await save.click();
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await assertNoHumanVerification(page);

  return waitForResult(page, async () => anyPresent(page, SAVE_SUCCESS_CONDITIONS, 500), {
    what: 'save confirmation',
    timeoutMs: 10_000,
  });
}

/** Reloads the agent so verification reads fresh values, not the form state. */
export async function reopenAgent(context: WorkflowContext, agent: ReadymodeAgent): Promise<void> {
  await context.session.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  await openAgent(context, agent);
}

export async function pageText(page: Page, limit = 20000): Promise<string> {
  return sanitizePageValue(await page.innerText('body').catch(() => ''), limit);
}
