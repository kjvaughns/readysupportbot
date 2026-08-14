import { EmbedBuilder, SlashCommandBuilder } from 'discord.js';
import { env } from '../../config/env.js';
import { allowedActions } from '../../domain/roles.js';
import { ACTION_LABELS } from '../../domain/actions.js';
import * as settings from '../../db/repositories/settings.js';
import * as audit from '../../audit/audit.js';
import { runHealthChecks, type CheckState } from '../../health/checks.js';
import { resumeAfterReconnect } from '../../queue/queue.js';
import { getReadymodeService } from '../../runtime.js';
import * as notifier from '../../notify/notifier.js';
import { COLORS, helpEmbed } from '../embeds.js';
import { escapeForDiscord } from '../../util/text.js';
import type { CommandDefinition } from './shared.js';

/**
 * Commands about ReadySupport itself rather than about Readymode accounts.
 */

const STATE_ICON: Record<CheckState, string> = {
  ok: '🟢',
  degraded: '🟡',
  failing: '🔴',
  unknown: '⚪',
};

export const loginStatusCommand: CommandDefinition = {
  name: 'login_status',
  budget: 'read',
  ephemeral: true,

  build() {
    return new SlashCommandBuilder()
      .setName('login_status')
      .setDescription('Show whether ReadySupport can reach Readymode, and how everything else is doing');
  },

  async handle({ interaction }) {
    const report = await runHealthChecks();

    const embed = new EmbedBuilder()
      .setColor(
        report.state === 'ok' ? COLORS.success : report.state === 'failing' ? COLORS.failure : COLORS.warning,
      )
      .setTitle(
        report.state === 'ok'
          ? 'Everything is working'
          : report.state === 'failing'
            ? 'Something needs attention'
            : 'Working, with a caveat',
      )
      .setDescription(
        report.checks
          .map((check) => `${STATE_ICON[check.state]} **${label(check.name)}** — ${escapeForDiscord(check.detail, 200)}`)
          .join('\n'),
      )
      .setFooter({ text: `Up for ${formatUptime(report.uptimeSeconds)} • mode: ${env().READYSUPPORT_MODE}` })
      .setTimestamp(new Date(report.checkedAt));

    await interaction.editReply({ embeds: [embed] });
  },
};

function label(name: string): string {
  switch (name) {
    case 'discord':
      return 'Discord';
    case 'supabase':
      return 'Database';
    case 'browserbase':
      return 'Browser service';
    case 'readymode_auth':
      return 'Readymode sign-in';
    case 'queue':
      return 'Job queue';
    case 'last_success':
      return 'Last success';
    case 'failures':
      return 'Recent failures';
    default:
      return name;
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export const reconnectCommand: CommandDefinition = {
  name: 'reconnect_readymode',
  budget: 'write',
  ephemeral: true,

  build() {
    return new SlashCommandBuilder()
      .setName('reconnect_readymode')
      .setDescription('Sign ReadySupport back in to Readymode and resume any work that was waiting');
  },

  async handle({ interaction, principal }) {
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN') {
      await interaction.editReply({
        content: 'Only an owner or an admin can reconnect the Readymode session.',
      });
      return;
    }

    const service = getReadymodeService();
    if (!service) {
      await interaction.editReply({ content: 'The Readymode driver has not started yet. Try again in a moment.' });
      return;
    }

    await interaction.editReply({ content: 'Trying to sign back in to Readymode…' });

    const status = await service.reconnect();

    await settings.set('readymode_auth_state', {
      state: status.state,
      checkedAt: status.checkedAt,
      detail: status.detail ?? null,
    });

    if (status.state === 'AUTHENTICATED') {
      const resumed = await resumeAfterReconnect();

      await audit.recordSystemEvent('AUTHENTICATION_RESTORED', {
        discordUserId: principal.discordUserId,
        userRole: principal.role,
        metadata: { resumed, reusedSession: status.reusedSession ?? false },
      });
      await notifier.alertAuthenticationRestored();

      await interaction.editReply({
        content:
          `Signed back in to Readymode.` +
          (resumed > 0
            ? ` ${resumed} request${resumed === 1 ? '' : 's'} that had been waiting will now run.`
            : ' Nothing was waiting.'),
      });
      return;
    }

    if (status.state === 'VERIFICATION_REQUIRED') {
      await interaction.editReply({
        content:
          'Readymode is asking for a verification step I am not permitted to complete — a security check or a ' +
          'code sent to you. Sign in manually in a browser, then run this command again.\n\n' +
          (status.detail ? `What it showed: ${escapeForDiscord(status.detail, 300)}` : ''),
      });
      return;
    }

    await interaction.editReply({
      content:
        'I still cannot get in to Readymode. The stored credentials may have changed. ' +
        (status.detail ? `\n\nWhat happened: ${escapeForDiscord(status.detail, 300)}` : ''),
    });
  },
};

export const helpCommand: CommandDefinition = {
  name: 'help',
  budget: 'read',
  ephemeral: true,

  build() {
    return new SlashCommandBuilder().setName('help').setDescription('What ReadySupport can do, and how to ask');
  },

  async handle({ interaction, principal }) {
    const nlChannelId = env().DISCORD_NL_CHANNEL_ID;

    await interaction.editReply({
      embeds: [
        helpEmbed({
          role: principal.role,
          availableActions: allowedActions(principal.role).map((action) => ACTION_LABELS[action]),
          ...(nlChannelId ? { nlChannelId } : {}),
        }),
      ],
    });
  },
};
