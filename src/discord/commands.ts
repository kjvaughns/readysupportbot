import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from 'discord.js';
import { Action, AgentTarget, actionSchema } from '../openai/schema';
import { normalizeStateList } from '../readymode/states';
import { config } from '../config';

/**
 * Slash commands. These bypass the language model entirely: options map
 * directly onto the same validated action union that natural language
 * eventually produces.
 */

const agentOption = (builder: SlashCommandBuilder) =>
  builder
    .addStringOption((option) =>
      option
        .setName('agent')
        .setDescription('Username, email address, or full name. Leave empty for yourself.')
        .setMaxLength(128),
    )
    .addUserOption((option) =>
      option.setName('user').setDescription('A linked Discord user, instead of typing a name.'),
    );

const statesOption = (builder: SlashCommandBuilder) =>
  builder.addStringOption((option) =>
    option
      .setName('states')
      .setDescription('States, for example: TX, VA, OH')
      .setRequired(true)
      .setMaxLength(400),
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

  agentOption(
    new SlashCommandBuilder().setName('clear_license').setDescription('Clear an agent license.'),
  ),
  agentOption(
    new SlashCommandBuilder().setName('reset_password').setDescription('Reset an agent password.'),
  ),
  agentOption(
    new SlashCommandBuilder()
      .setName('deactivate_account')
      .setDescription('Deactivate an agent account. Needs a second Owner or Administrator.'),
  ),
  agentOption(
    new SlashCommandBuilder()
      .setName('agent_status')
      .setDescription('Check whether an agent is logged in.'),
  ),

  new SlashCommandBuilder()
    .setName('license_usage')
    .setDescription('See which agents are currently using licenses.'),

  statesOption(
    agentOption(
      new SlashCommandBuilder()
        .setName('set_states')
        .setDescription('Replace an agent state assignment.'),
    ) as SlashCommandBuilder,
  ),
  statesOption(
    agentOption(
      new SlashCommandBuilder().setName('add_states').setDescription('Add states to an agent.'),
    ) as SlashCommandBuilder,
  ),
  statesOption(
    agentOption(
      new SlashCommandBuilder()
        .setName('remove_states')
        .setDescription('Remove states from an agent.'),
    ) as SlashCommandBuilder,
  ),
  agentOption(
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
