import { SlashCommandBuilder } from 'discord.js';
import {
  checkAgentStatusSchema,
  checkLicenseUsageSchema,
  listRecentActionsSchema,
} from '../../domain/actions.js';
import { submit } from '../requestFlow.js';
import {
  addTargetOptions,
  firstIssueMessage,
  readTarget,
  type CommandDefinition,
} from './shared.js';

/**
 * The read-only commands. None of these needs confirmation — they change
 * nothing — so they go straight into the queue and answer when they land.
 */

export const licenseUsageCommand: CommandDefinition = {
  name: 'license_usage',
  action: 'CHECK_LICENSE_USAGE',
  budget: 'read',
  ephemeral: false,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('license_usage')
      .setDescription('Show which agents are currently using licenses');

    builder.addStringOption((option) =>
      option
        .setName('license_type')
        .setDescription('Narrow to one license type, exactly as it appears in Readymode')
        .setMaxLength(80),
    );

    return builder;
  },

  async handle({ interaction, principal }) {
    const licenseType = interaction.options.getString('license_type')?.trim();

    const parsed = checkLicenseUsageSchema.safeParse({
      action: 'CHECK_LICENSE_USAGE',
      ...(licenseType ? { licenseType } : {}),
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({ interaction, principal, action: parsed.data, source: 'SLASH_COMMAND' });
  },
};

export const agentStatusCommand: CommandDefinition = {
  name: 'agent_status',
  action: 'CHECK_AGENT_STATUS',
  budget: 'read',
  ephemeral: false,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('agent_status')
      .setDescription('Check whether a specific agent is active, signed in, or holding a license');

    addTargetOptions(builder);
    return builder;
  },

  async handle({ interaction, principal }) {
    const target = readTarget(interaction);
    if (!target.ok) {
      await interaction.editReply({ content: target.message });
      return;
    }

    const parsed = checkAgentStatusSchema.safeParse({
      action: 'CHECK_AGENT_STATUS',
      target: target.target,
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({ interaction, principal, action: parsed.data, source: 'SLASH_COMMAND' });
  },
};

export const recentActionsCommand: CommandDefinition = {
  name: 'recent_actions',
  action: 'LIST_RECENT_ACTIONS',
  budget: 'read',
  ephemeral: false,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('recent_actions')
      .setDescription('List recent completed and failed ReadySupport actions');

    builder.addIntegerOption((option) =>
      option.setName('limit').setDescription('How many to show (1-25)').setMinValue(1).setMaxValue(25),
    );
    builder.addStringOption((option) =>
      option
        .setName('filter')
        .setDescription('Show everything, or only successes or only failures')
        .addChoices(
          { name: 'Everything', value: 'ALL' },
          { name: 'Completed only', value: 'COMPLETED' },
          { name: 'Failed only', value: 'FAILED' },
        ),
    );

    return builder;
  },

  async handle({ interaction, principal }) {
    const parsed = listRecentActionsSchema.safeParse({
      action: 'LIST_RECENT_ACTIONS',
      limit: interaction.options.getInteger('limit') ?? 10,
      status: interaction.options.getString('filter') ?? 'ALL',
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({ interaction, principal, action: parsed.data, source: 'SLASH_COMMAND' });
  },
};
