import { AppError } from '../../security/errors';
import { sanitizePageValue } from '../../security/sanitize';
import { ReadymodeAgent } from '../../types';
import { describeAgent } from '../agents';
import { PLAYLIST_CONTROLS } from '../selectors';
import { discover } from '../selectors/discovery';
import { WorkflowContext, WorkflowDefinition, runWorkflow, step } from './harness';
import { openAgent, reopenAgent, saveAgentForm } from './pageOperations';

/**
 * Playlist membership — what people mean by "put them in a lead pool".
 *
 * Readymode distributes leads to agents through playlist membership, with a
 * level (Primary, Backup, Tertiary) deciding the order in which members are
 * offered work. Assignment adds membership without disturbing what an agent
 * already has; removal takes away only the named playlists.
 */

export type PlaylistLevel = 'primary' | 'backup' | 'tertiary';

export interface PlaylistInput {
  agent: ReadymodeAgent;
  playlists: string[];
  level?: PlaylistLevel;
  operation: 'assign' | 'remove';
}

interface PlaylistOutput extends Record<string, unknown> {
  verified: boolean;
  summary: string;
  previous: string[];
  assigned: string[];
  added: string[];
  removed: string[];
}

/** Reads the playlists an agent currently belongs to. */
async function readMembership(context: WorkflowContext): Promise<string[]> {
  const section = await discover(context.session.page, PLAYLIST_CONTROLS.section);
  const checkboxes = section.locator('input[type="checkbox"]');
  const count = await checkboxes.count().catch(() => 0);
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!(await checkbox.isChecked().catch(() => false))) continue;
    names.push(await labelFor(checkbox));
  }

  return names.filter(Boolean).sort();
}

async function labelFor(checkbox: {
  getAttribute: (name: string) => Promise<string | null>;
  locator: (selector: string) => { innerText: () => Promise<string> };
}): Promise<string> {
  const aria = (await checkbox.getAttribute('aria-label').catch(() => null)) ?? '';
  if (aria) return sanitizePageValue(aria, 80);

  const value = (await checkbox.getAttribute('value').catch(() => null)) ?? '';
  const parentText = await checkbox
    .locator('xpath=..')
    .innerText()
    .catch(() => '');
  return sanitizePageValue(parentText || value, 80);
}

export const playlistWorkflow: WorkflowDefinition<PlaylistInput, PlaylistOutput> = {
  name: 'playlists.membership',

  describe: (input) =>
    input.operation === 'assign'
      ? `Assign ${describeAgent(input.agent)} to playlist(s) ${input.playlists.join(', ')} as ${input.level ?? 'primary'}`
      : `Remove ${describeAgent(input.agent)} from playlist(s) ${input.playlists.join(', ')}`,

  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));

    const previous = await step(context, 'read-membership', () => readMembership(context));
    const wanted = input.playlists.map((name) => name.trim().toLowerCase());
    const previousLower = previous.map((name) => name.toLowerCase());

    const target =
      input.operation === 'assign'
        ? [...new Set([...previousLower, ...wanted])]
        : previousLower.filter((name) => !wanted.includes(name));

    const added = target.filter((name) => !previousLower.includes(name));
    const removed = previousLower.filter((name) => !target.includes(name));

    if (context.dryRun) {
      return {
        verified: false,
        summary:
          `Dry run: no change was saved.\nCurrent playlists: ${previous.join(', ') || 'none'}\n` +
          `New playlists: ${target.join(', ') || 'none'}`,
        previous,
        assigned: target,
        added,
        removed,
      };
    }

    if (added.length === 0 && removed.length === 0) {
      return {
        verified: true,
        summary: `No change was needed. ${describeAgent(input.agent)} is already in: ${previous.join(', ') || 'none'}.`,
        previous,
        assigned: previous,
        added: [],
        removed: [],
      };
    }

    const section = await discover(context.session.page, PLAYLIST_CONTROLS.section);
    const checkboxes = section.locator('input[type="checkbox"]');
    const count = await checkboxes.count();
    const seen = new Set<string>();

    for (let index = 0; index < count; index += 1) {
      const checkbox = checkboxes.nth(index);
      const name = (await labelFor(checkbox)).toLowerCase();
      if (!name) continue;
      seen.add(name);

      const shouldCheck = target.includes(name);
      const isChecked = await checkbox.isChecked().catch(() => false);
      if (shouldCheck === isChecked) continue;
      if (shouldCheck) await checkbox.check({ timeout: 5000 });
      else await checkbox.uncheck({ timeout: 5000 });
    }

    const missing = wanted.filter((name) => !seen.has(name));
    if (missing.length > 0) {
      throw new AppError(
        'playlist_not_available',
        `These playlists do not exist in Readymode, so nothing was saved: ${missing.join(', ')}.`,
        409,
      );
    }

    const saved = await step(context, 'save', () => saveAgentForm(context));
    if (!saved) {
      throw new AppError('save_not_confirmed', 'Readymode did not confirm the save.', 503);
    }

    await step(context, 'reopen', () => reopenAgent(context, input.agent));
    const verified = await readMembership(context);
    const verifiedLower = verified.map((name) => name.toLowerCase()).sort();

    if (verifiedLower.join('|') !== [...target].sort().join('|')) {
      throw new AppError(
        'verification_failed',
        `The saved playlists do not match the request. Readymode now shows: ${verified.join(', ') || 'none'}.`,
        409,
      );
    }

    return {
      verified: true,
      summary: `${describeAgent(input.agent)} is now in playlists: ${verified.join(', ') || 'none'}.`,
      previous,
      assigned: verified,
      added,
      removed,
    };
  },
};

export const viewPlaylistsWorkflow: WorkflowDefinition<
  { agent: ReadymodeAgent },
  PlaylistOutput
> = {
  name: 'playlists.view',
  describe: (input) => `Read playlist membership for ${describeAgent(input.agent)}`,

  async run(context, input) {
    await step(context, 'open-agent', () => openAgent(context, input.agent));
    const membership = await readMembership(context);

    return {
      verified: true,
      summary: `${describeAgent(input.agent)} is in playlists: ${membership.join(', ') || 'none'}.`,
      previous: membership,
      assigned: membership,
      added: [],
      removed: [],
    };
  },
};

export const runPlaylistWorkflow = (context: WorkflowContext, input: PlaylistInput) =>
  runWorkflow(playlistWorkflow, context, input);
export const runViewPlaylistsWorkflow = (
  context: WorkflowContext,
  input: { agent: ReadymodeAgent },
) => runWorkflow(viewPlaylistsWorkflow, context, input);
