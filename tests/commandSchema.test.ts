import { describe, expect, it } from 'vitest';
import { SlashCommandBuilder } from 'discord.js';
import {
  COMMAND_NAMES,
  buildCommandPayload,
  commandBuilders,
  findOptionOrderProblems,
} from '../src/discord/commands';
import {
  CommandSchemaError,
  describeRegistrationError,
} from '../src/discord/registerCommands';

/**
 * Discord rejects an entire registration payload when a required option is
 * declared after an optional one, and the error it returns names an array index
 * rather than a command. These tests catch that here instead.
 */

describe('slash command option ordering', () => {
  it('declares every required option before any optional one', () => {
    const problems = findOptionOrderProblems(buildCommandPayload());

    // Reported in full so a failure names the command and both options.
    expect(problems, JSON.stringify(problems, null, 2)).toEqual([]);
  });

  it('checks every command, not a subset', () => {
    const payload = buildCommandPayload();
    expect(payload).toHaveLength(commandBuilders.length);
    expect(payload.map((command) => command.name)).toEqual(COMMAND_NAMES);
  });

  it('produces a payload Discord will accept structurally', () => {
    for (const command of buildCommandPayload()) {
      expect(String(command.name)).toMatch(/^[-_a-z0-9]{1,32}$/);
      expect(String(command.description).length).toBeGreaterThan(0);
      expect(String(command.description).length).toBeLessThanOrEqual(100);
    }
  });

  it('catches the ordering mistake that caused the failure', () => {
    // The shape the state and assignment commands previously had: optional
    // agent/user added first, then a required option.
    const broken = new SlashCommandBuilder()
      .setName('broken')
      .setDescription('Optional first, required second.')
      .addStringOption((option) => option.setName('agent').setDescription('Optional.'))
      .addStringOption((option) =>
        option.setName('states').setDescription('Required.').setRequired(true),
      );

    const problems = findOptionOrderProblems([
      broken.toJSON() as unknown as Record<string, unknown>,
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ command: 'broken', option: 'states', after: 'agent' });
  });

  it('accepts required-then-optional', () => {
    const fixed = new SlashCommandBuilder()
      .setName('fixed')
      .setDescription('Required first.')
      .addStringOption((option) =>
        option.setName('states').setDescription('Required.').setRequired(true),
      )
      .addStringOption((option) => option.setName('agent').setDescription('Optional.'));

    expect(
      findOptionOrderProblems([fixed.toJSON() as unknown as Record<string, unknown>]),
    ).toEqual([]);
  });

  it('keeps the commands that carry required options', () => {
    // Regression guard: these are the five that Discord rejected.
    for (const name of [
      'add-assignment',
      'remove-assignment',
      'set_states',
      'add_states',
      'remove_states',
    ]) {
      const command = buildCommandPayload().find((entry) => entry.name === name);
      expect(command, `${name} is missing`).toBeTruthy();

      const options = (command!.options as Array<Record<string, unknown>>) ?? [];
      expect(options[0]?.required, `${name} must lead with its required option`).toBe(true);
    }
  });
});

describe('registration failure reporting', () => {
  it('names the offending option when the schema is wrong locally', () => {
    const failure = describeRegistrationError(
      new CommandSchemaError([
        { command: 'set_states', option: 'states', index: 2, after: 'agent' },
      ]),
    );

    expect(failure.reason).toMatch(/required option was declared after an optional one/i);
    expect(failure.fields).toEqual(['set_states.states']);
  });

  it('reports a rejected schema plainly, with the field paths', () => {
    const failure = describeRegistrationError({
      code: 50035,
      status: 400,
      method: 'PUT',
      url: 'https://discord.com/api/v10/applications/123/guilds/456/commands?x=1',
      message: 'Invalid Form Body',
      rawError: {
        errors: { '5': { options: { '2': { _errors: [{ code: 'X', message: 'bad' }] } } } },
      },
    });

    expect(failure.reason).toBe('Discord rejected the command schema.');
    expect(failure.code).toBe(50035);
    expect(failure.status).toBe(400);
    expect(failure.method).toBe('PUT');
    expect(failure.fields).toContain('5.options.2');
  });

  it('drops the query string from the route it reports', () => {
    const failure = describeRegistrationError({
      status: 400,
      url: 'https://discord.com/api/v10/applications/123/commands?token=supersecretvalue',
    });

    expect(failure.route).toBe('/api/v10/applications/123/commands');
    expect(JSON.stringify(failure)).not.toContain('supersecretvalue');
  });

  it('distinguishes credential, permission and rate limit failures', () => {
    expect(describeRegistrationError({ status: 401 }).reason).toMatch(/bot credentials/i);
    expect(describeRegistrationError({ status: 403 }).reason).toMatch(/applications\.commands/i);
    expect(describeRegistrationError({ status: 404 }).reason).toMatch(/could not find/i);
    expect(describeRegistrationError({ status: 429 }).reason).toMatch(/rate limited/i);
  });

  it('never leaks a bot token, however the error carries it', () => {
    // Assembled at runtime rather than written as one literal: a token-shaped
    // string in source trips secret scanners, and committing one is a bad habit
    // even when the value is invented.
    const token = ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz1234567890'].join(
      '.',
    );
    const failure = describeRegistrationError({
      status: 500,
      message: `Request failed with Authorization: Bot ${token}`,
      url: `https://discord.com/api/v10/applications/123/commands?auth=${token}`,
    });

    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain(token);
    // The message is not surfaced at all — only a classified reason is.
    expect(serialized).not.toContain('Authorization');
  });

  it('falls back to a safe sentence for an unrecognized failure', () => {
    const failure = describeRegistrationError(new Error('socket hang up'));
    expect(failure.reason).toBe('Discord did not accept the command registration.');
    expect(JSON.stringify(failure)).not.toContain('socket hang up');
  });
});
