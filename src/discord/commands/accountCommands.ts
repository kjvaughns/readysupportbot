import { SlashCommandBuilder } from 'discord.js';
import {
  clearLicenseSchema,
  createAccountSchema,
  deactivateAccountSchema,
  resetPasswordSchema,
} from '../../domain/actions.js';
import { checkPasswordStrength } from '../../util/password.js';
import { submit } from '../requestFlow.js';
import {
  addTargetOptions,
  firstIssueMessage,
  readTarget,
  type CommandDefinition,
  type CommandHandlerInput,
} from './shared.js';

/**
 * The four commands that change Readymode.
 *
 * None of them acts. Each one validates its input, then hands a structured
 * action to the shared submission path, which shows it for confirmation before
 * anything is queued.
 */

function trimmed(input: CommandHandlerInput, name: string): string | undefined {
  const value = input.interaction.options.getString(name);
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export const createAccountCommand: CommandDefinition = {
  name: 'create_account',
  action: 'CREATE_ACCOUNT',
  budget: 'write',
  // The result carries a temporary password, so the whole exchange stays
  // private from the start rather than turning private at the last moment.
  ephemeral: true,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('create_account')
      .setDescription('Create a new Readymode agent account');

    builder.addStringOption((option) =>
      option.setName('first_name').setDescription('First name').setRequired(true).setMaxLength(60),
    );
    builder.addStringOption((option) =>
      option.setName('last_name').setDescription('Last name').setRequired(true).setMaxLength(60),
    );
    builder.addStringOption((option) =>
      option.setName('email').setDescription('Email address').setRequired(true).setMaxLength(254),
    );
    builder.addStringOption((option) =>
      option.setName('username').setDescription('Readymode username').setRequired(true).setMaxLength(64),
    );
    builder.addStringOption((option) =>
      option
        .setName('role')
        .setDescription('Agent role, exactly as it appears in Readymode')
        .setRequired(true)
        .setMaxLength(80),
    );
    builder.addStringOption((option) =>
      option
        .setName('license_type')
        .setDescription('License type, exactly as it appears in Readymode')
        .setRequired(true)
        .setMaxLength(80),
    );
    builder.addStringOption((option) =>
      option.setName('team').setDescription('Team').setMaxLength(80),
    );
    builder.addStringOption((option) =>
      option.setName('campaign').setDescription('Campaign').setMaxLength(80),
    );
    builder.addStringOption((option) =>
      option.setName('queue').setDescription('Queue').setMaxLength(80),
    );
    builder.addBooleanOption((option) =>
      option.setName('active').setDescription('Create the account active (default: yes)'),
    );
    builder.addStringOption((option) =>
      option
        .setName('temporary_password')
        .setDescription('Leave blank and I will generate a secure one. Never reuse a real password here.')
        .setMinLength(12)
        .setMaxLength(128),
    );

    return builder;
  },

  async handle(input) {
    const { interaction } = input;
    const providedPassword = trimmed(input, 'temporary_password');

    if (providedPassword) {
      const strength = checkPasswordStrength(providedPassword);
      if (!strength.ok) {
        await interaction.editReply({
          content: `That temporary password ${strength.problems.join(', ')}. Leave the option blank and I will generate one.`,
        });
        return;
      }
    }

    const parsed = createAccountSchema.safeParse({
      action: 'CREATE_ACCOUNT',
      firstName: interaction.options.getString('first_name', true),
      lastName: interaction.options.getString('last_name', true),
      email: interaction.options.getString('email', true),
      username: interaction.options.getString('username', true),
      agentRole: interaction.options.getString('role', true),
      licenseType: interaction.options.getString('license_type', true),
      ...(trimmed(input, 'team') ? { team: trimmed(input, 'team') } : {}),
      ...(trimmed(input, 'campaign') ? { campaign: trimmed(input, 'campaign') } : {}),
      ...(trimmed(input, 'queue') ? { queue: trimmed(input, 'queue') } : {}),
      active: interaction.options.getBoolean('active') ?? true,
      ...(providedPassword ? { temporaryPassword: providedPassword } : {}),
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({
      interaction,
      principal: input.principal,
      action: parsed.data,
      source: 'SLASH_COMMAND',
      ...(providedPassword ? { providedPassword } : {}),
    });
  },
};

export const clearLicenseCommand: CommandDefinition = {
  name: 'clear_license',
  action: 'CLEAR_LICENSE',
  budget: 'write',
  ephemeral: false,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('clear_license')
      .setDescription('Release the license an agent is currently holding');

    addTargetOptions(builder);
    builder.addBooleanOption((option) =>
      option
        .setName('even_if_on_a_call')
        .setDescription('Admins only: continue even if the agent is mid-call. This will drop the call.'),
    );

    return builder;
  },

  async handle(input) {
    const { interaction, principal } = input;

    const target = readTarget(interaction);
    if (!target.ok) {
      await interaction.editReply({ content: target.message });
      return;
    }

    const override = interaction.options.getBoolean('even_if_on_a_call') ?? false;
    if (override && principal.role !== 'OWNER' && principal.role !== 'ADMIN') {
      await interaction.editReply({
        content:
          'Only an owner or an admin can clear a license from someone who is on a call. ' +
          'Ask one of them, or run this again without that option.',
      });
      return;
    }

    const parsed = clearLicenseSchema.safeParse({
      action: 'CLEAR_LICENSE',
      target: target.target,
      overrideActiveCall: override,
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({ interaction, principal, action: parsed.data, source: 'SLASH_COMMAND' });
  },
};

export const resetPasswordCommand: CommandDefinition = {
  name: 'reset_password',
  action: 'RESET_PASSWORD',
  budget: 'write',
  ephemeral: true,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('reset_password')
      .setDescription("Set a new temporary password on an agent's account");

    addTargetOptions(builder);
    builder.addStringOption((option) =>
      option
        .setName('temporary_password')
        .setDescription('Leave blank and I will generate a secure one.')
        .setMinLength(12)
        .setMaxLength(128),
    );

    return builder;
  },

  async handle(input) {
    const { interaction, principal } = input;

    const target = readTarget(interaction);
    if (!target.ok) {
      await interaction.editReply({ content: target.message });
      return;
    }

    const providedPassword = trimmed(input, 'temporary_password');
    if (providedPassword) {
      const strength = checkPasswordStrength(providedPassword);
      if (!strength.ok) {
        await interaction.editReply({
          content: `That temporary password ${strength.problems.join(', ')}. Leave the option blank and I will generate one.`,
        });
        return;
      }
    }

    const parsed = resetPasswordSchema.safeParse({
      action: 'RESET_PASSWORD',
      target: target.target,
      ...(providedPassword ? { temporaryPassword: providedPassword } : {}),
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({
      interaction,
      principal,
      action: parsed.data,
      source: 'SLASH_COMMAND',
      ...(providedPassword ? { providedPassword } : {}),
    });
  },
};

export const deactivateAccountCommand: CommandDefinition = {
  name: 'deactivate_account',
  action: 'DEACTIVATE_ACCOUNT',
  budget: 'write',
  ephemeral: false,

  build() {
    const builder = new SlashCommandBuilder()
      .setName('deactivate_account')
      .setDescription('Deactivate an agent account (needs a second owner or admin to confirm)');

    addTargetOptions(builder);
    builder.addStringOption((option) =>
      option.setName('reason').setDescription('Why, for the record').setMaxLength(300),
    );

    return builder;
  },

  async handle(input) {
    const { interaction, principal } = input;

    const target = readTarget(interaction);
    if (!target.ok) {
      await interaction.editReply({ content: target.message });
      return;
    }

    const parsed = deactivateAccountSchema.safeParse({
      action: 'DEACTIVATE_ACCOUNT',
      target: target.target,
      ...(trimmed(input, 'reason') ? { reason: trimmed(input, 'reason') } : {}),
    });

    if (!parsed.success) {
      await interaction.editReply({ content: firstIssueMessage(parsed.error) });
      return;
    }

    await submit({ interaction, principal, action: parsed.data, source: 'SLASH_COMMAND' });
  },
};
