import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { Action, AgentTarget, actionSchema } from '../openai/schema';
import { normalizeStateList } from '../readymode/states';
import { config } from '../config';
import { detectTopic } from '../knowledge/troubleshooting';

/**
 * Slash commands. These bypass the language model entirely: options map
 * directly onto the same validated action union that natural language
 * eventually produces.
 */

/**
 * Discord requires every required option to be declared before any optional
 * one, and rejects the whole payload otherwise. The helpers below are therefore
 * split by whether they add a required option, and the required ones are always
 * applied first — `agentOptions(requiredStates(builder))`, never the reverse.
 *
 * `findOptionOrderProblems` below enforces that mechanically, so a future
 * command cannot reintroduce the mistake and only discover it when Discord
 * refuses the registration.
 */
type OptionBuilder = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;

/** Optional targeting. Always applied AFTER any required option. */
const agentOptions = (builder: OptionBuilder): SlashCommandOptionsOnlyBuilder =>
  (builder as SlashCommandBuilder)
    .addStringOption((option) =>
      option
        .setName('agent')
        .setDescription('Username, email address, or full name. Leave empty for yourself.')
        .setMaxLength(128),
    )
    .addUserOption((option) =>
      option.setName('user').setDescription('A linked Discord user, instead of typing a name.'),
    );

const requiredStatesOption = (builder: OptionBuilder): SlashCommandOptionsOnlyBuilder =>
  (builder as SlashCommandBuilder).addStringOption((option) =>
    option
      .setName('states')
      .setDescription('States, for example: TX, VA, OH')
      .setRequired(true)
      .setMaxLength(400),
  );

const requiredPlaylistsOption = (builder: OptionBuilder): SlashCommandOptionsOnlyBuilder =>
  (builder as SlashCommandBuilder).addStringOption((option) =>
    option
      .setName('playlists')
      .setDescription('Playlist names, comma separated.')
      .setRequired(true)
      .setMaxLength(500),
  );

export const commandBuilders: Array<
  SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder
> = [
  new SlashCommandBuilder()
    .setName('create_account')
    .setDescription('Create one Readymode agent account.')
    .addStringOption((option) =>
      option.setName('full_name').setDescription('Full name of the agent.').setRequired(true).setMaxLength(128),
    )
    .addStringOption((option) =>
      option.setName('username').setDescription('Readymode username.').setMaxLength(64),
    )
    .addStringOption((option) =>
      option.setName('email').setDescription('Email address.').setMaxLength(254),
    ),

  new SlashCommandBuilder()
    .setName('create_accounts')
    .setDescription('Create several Readymode agent accounts.')
    .addStringOption((option) =>
      option
        .setName('full_names')
        .setDescription('Full names separated by semicolons, e.g. "Ada Lovelace; Alan Turing"')
        .setRequired(true)
        .setMaxLength(1000),
    ),

  agentOptions(
    new SlashCommandBuilder().setName('clear_license').setDescription('Clear an agent license.'),
  ),
  agentOptions(
    new SlashCommandBuilder().setName('reset_password').setDescription('Reset an agent password.'),
  ),
  agentOptions(
    new SlashCommandBuilder()
      .setName('deactivate_account')
      .setDescription('Deactivate an agent account. Needs a second Owner or Administrator.'),
  ),
  agentOptions(
    new SlashCommandBuilder()
      .setName('agent_status')
      .setDescription('Check whether an agent is logged in.'),
  ),

  new SlashCommandBuilder()
    .setName('clear-licenses')
    .setDescription("Log out inactive Readymode users, freeing the seats they hold."),

  agentOptions(
    new SlashCommandBuilder()
      .setName('force-logout')
      .setDescription('Sign a specific user out of Readymode. Needs a second approver.'),
  ).addBooleanOption((option) =>
    option
      .setName('reset_password')
      .setDescription('Also reset their password so the seat cannot be retaken.'),
  ),

  agentOptions(
    requiredPlaylistsOption(
      new SlashCommandBuilder()
        .setName('add-assignment')
        .setDescription('Assign an agent to a playlist (lead pool).'),
    ),
  ).addStringOption((option) =>
    option
      .setName('level')
      .setDescription('Membership level. Defaults to primary.')
      .addChoices(
        { name: 'Primary', value: 'primary' },
        { name: 'Backup', value: 'backup' },
        { name: 'Tertiary', value: 'tertiary' },
      ),
  ),

  agentOptions(
    requiredPlaylistsOption(
      new SlashCommandBuilder()
        .setName('remove-assignment')
        .setDescription('Remove an agent from a playlist (lead pool).'),
    ),
  ),

  agentOptions(
    new SlashCommandBuilder()
      .setName('view-assignments')
      .setDescription('See which playlists an agent is in.'),
  ),

  new SlashCommandBuilder()
    .setName('troubleshoot')
    .setDescription('Get help with audio, login, dialing, leads, licences or recordings.')
    .addStringOption((option) =>
      option
        .setName('problem')
        .setDescription('Describe what is not working, for example "no audio on calls".')
        .setRequired(true)
        .setMaxLength(400),
    ),

  new SlashCommandBuilder()
    .setName('license_usage')
    .setDescription('See which agents are currently using licenses.'),

  agentOptions(
    requiredStatesOption(
      new SlashCommandBuilder().setName('set_states').setDescription('Replace an agent state assignment.'),
    ),
  ),
  agentOptions(
    requiredStatesOption(
      new SlashCommandBuilder().setName('add_states').setDescription('Add states to an agent.'),
    ),
  ),
  agentOptions(
    requiredStatesOption(
      new SlashCommandBuilder().setName('remove_states').setDescription('Remove states from an agent.'),
    ),
  ),
  agentOptions(
    new SlashCommandBuilder()
      .setName('view_states')
      .setDescription('See which states an agent receives.'),
  ),

  new SlashCommandBuilder()
    .setName('connection_status')
    .setDescription('Check the Readymode connection.'),

  new SlashCommandBuilder()
    .setName('recent_actions')
    .setDescription('See recent ReadySupport activity.')
    .addIntegerOption((option) =>
      option.setName('limit').setDescription('How many entries (1-50).').setMinValue(1).setMaxValue(50),
    ),

  new SlashCommandBuilder().setName('help').setDescription('What ReadySupport can do.'),
];

export const COMMAND_NAMES = commandBuilders.map((builder) => builder.name);

export interface OptionOrderProblem {
  command: string;
  /** The required option that arrives too late. */
  option: string;
  index: number;
  /** The optional option it wrongly follows. */
  after: string;
}

/**
 * Finds required options declared after an optional one.
 *
 * Discord rejects the entire registration payload when this happens, and the
 * error it returns names an index rather than a command, so catching it here
 * turns a confusing 400 into a precise local failure.
 */
export function findOptionOrderProblems(
  commands: Array<Record<string, unknown>>,
): OptionOrderProblem[] {
  const problems: OptionOrderProblem[] = [];

  const walk = (path: string, options: Array<Record<string, unknown>>): void => {
    let lastOptional: string | null = null;

    options.forEach((option, index) => {
      const name = String(option.name ?? index);
      const type = Number(option.type ?? 0);

      // Subcommands (1) and subcommand groups (2) carry their own option lists,
      // each ordered independently.
      if (type === 1 || type === 2) {
        walk(`${path} ${name}`, (option.options as Array<Record<string, unknown>>) ?? []);
        return;
      }

      if (option.required === true) {
        if (lastOptional) {
          problems.push({ command: path, option: name, index, after: lastOptional });
        }
      } else {
        lastOptional = name;
      }
    });
  };

  for (const command of commands) {
    walk(String(command.name ?? 'unknown'), (command.options as Array<Record<string, unknown>>) ?? []);
  }

  return problems;
}

/** The registration payload, as Discord will receive it. */
export function buildCommandPayload(): Array<Record<string, unknown>> {
  return commandBuilders.map((builder) => builder.toJSON() as unknown as Record<string, unknown>);
}


export interface CommandParseResult {
  status: 'ok' | 'needs_information';
  action?: Action;
  message?: string;
}

/** Builds a target from the agent / user options. Defaults to the requester. */
function targetFrom(interaction: ChatInputCommandInteraction): AgentTarget {
  const user = interaction.options.getUser('user');
  if (user) return { kind: 'discord_user', discordUserId: user.id };

  const agent = interaction.options.getString('agent')?.trim();
  if (!agent) return { kind: 'self' };

  if (agent.includes('@')) return { kind: 'email', email: agent };
  if (/\s/.test(agent)) return { kind: 'name', name: agent };
  return { kind: 'username', username: agent };
}

function parseStates(interaction: ChatInputCommandInteraction): CommandParseResult | string[] {
  const raw = interaction.options.getString('states', true);
  const { states, invalid } = normalizeStateList(raw);

  if (invalid.length > 0) {
    return {
      status: 'needs_information',
      message: `These are not recognized states: ${invalid.join(', ')}. Use full names or postal abbreviations.`,
    };
  }
  if (states.length === 0) {
    return { status: 'needs_information', message: 'Name at least one state.' };
  }
  return states;
}

/** Converts a slash command into the validated action union. */
export function commandToAction(interaction: ChatInputCommandInteraction): CommandParseResult {
  const name = interaction.commandName;

  const finish = (candidate: unknown): CommandParseResult => {
    const parsed = actionSchema.safeParse(candidate);
    if (!parsed.success) {
      return {
        status: 'needs_information',
        message: parsed.error.issues[0]?.message ?? 'That command could not be validated.',
      };
    }
    return { status: 'ok', action: parsed.data };
  };

  switch (name) {
    case 'create_account':
      return finish({
        action: 'CREATE_ACCOUNT',
        account: {
          fullName: interaction.options.getString('full_name', true),
          ...(interaction.options.getString('username')
            ? { username: interaction.options.getString('username')! }
            : {}),
          ...(interaction.options.getString('email')
            ? { email: interaction.options.getString('email')! }
            : {}),
        },
      });

    case 'create_accounts': {
      const names = interaction.options
        .getString('full_names', true)
        .split(/[;\n]/)
        .map((value) => value.trim())
        .filter(Boolean);

      if (names.length === 0) {
        return { status: 'needs_information', message: 'List at least one full name.' };
      }
      if (names.length > config.maxBulkAccounts) {
        return {
          status: 'needs_information',
          message: `That is more than the ${config.maxBulkAccounts} accounts allowed in one request.`,
        };
      }
      return finish({
        action: 'CREATE_ACCOUNTS',
        accounts: names.map((fullName) => ({ fullName })),
      });
    }

    case 'clear_license':
      return finish({ action: 'CLEAR_LICENSE', target: targetFrom(interaction) });
    case 'clear-licenses':
      return finish({ action: 'CLEAR_ALL_LICENSES' });
    case 'force-logout':
      return finish({
        action: 'FORCE_LOGOUT',
        target: targetFrom(interaction),
        resetPassword: interaction.options.getBoolean('reset_password') ?? false,
      });

    case 'add-assignment':
    case 'remove-assignment': {
      const playlists = interaction.options
        .getString('playlists', true)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (playlists.length === 0) {
        return { status: 'needs_information', message: 'Name at least one playlist.' };
      }

      return finish(
        name === 'add-assignment'
          ? {
              action: 'ASSIGN_PLAYLIST',
              target: targetFrom(interaction),
              playlists,
              level: interaction.options.getString('level') ?? 'primary',
            }
          : { action: 'REMOVE_PLAYLIST', target: targetFrom(interaction), playlists },
      );
    }

    case 'view-assignments':
      return finish({ action: 'VIEW_PLAYLISTS', target: targetFrom(interaction) });

    case 'troubleshoot': {
      const problem = interaction.options.getString('problem', true);
      return finish({ action: 'TROUBLESHOOT', topic: detectTopic(problem), question: problem });
    }
    case 'reset_password':
      return finish({ action: 'RESET_PASSWORD', target: targetFrom(interaction) });
    case 'deactivate_account':
      return finish({ action: 'DEACTIVATE_ACCOUNT', target: targetFrom(interaction) });
    case 'agent_status':
      return finish({ action: 'AGENT_STATUS', target: targetFrom(interaction) });
    case 'license_usage':
      return finish({ action: 'LICENSE_USAGE' });
    case 'view_states':
      return finish({ action: 'VIEW_STATES', target: targetFrom(interaction) });

    case 'set_states':
    case 'add_states':
    case 'remove_states': {
      const states = parseStates(interaction);
      if (!Array.isArray(states)) return states;
      const actionType =
        name === 'set_states' ? 'SET_STATES' : name === 'add_states' ? 'ADD_STATES' : 'REMOVE_STATES';
      return finish({ action: actionType, target: targetFrom(interaction), states });
    }

    case 'connection_status':
      return finish({ action: 'CONNECTION_STATUS' });
    case 'recent_actions':
      return finish({
        action: 'RECENT_ACTIONS',
        limit: interaction.options.getInteger('limit') ?? 10,
      });
    case 'help':
      return finish({ action: 'HELP' });

    default:
      return { status: 'needs_information', message: 'That command is not supported.' };
  }
}
