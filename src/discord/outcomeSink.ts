import {
  ActionRowBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type RepliableInteraction,
} from 'discord.js';
import type { ExecutionOutcome } from '../queue/executor.js';
import type { OutcomeSink } from '../queue/queue.js';
import * as audit from '../audit/audit.js';
import * as vault from '../security/secretVault.js';
import { forgetSecret } from '../security/redact.js';
import type {
  CreatedAccount,
  LicenseUsage,
  PasswordResetResult,
  ReadymodeAccount,
  StateChange,
} from '../readymode/port.js';
import {
  accountCreatedEmbed,
  agentStatusEmbed,
  failureEmbed,
  licenseUsageEmbed,
  stateChangeEmbed,
} from './embeds.js';
import { encodeComponentId } from './customIds.js';
import * as replies from './replyRegistry.js';
import { newNonce } from '../util/ids.js';
import { moduleLogger } from '../util/logger.js';
import { escapeForDiscord, truncate } from '../util/text.js';

/**
 * Reporting a finished job back to Discord.
 *
 * Two things here are load-bearing rather than cosmetic. Credentials go out
 * through a private reply and nowhere else — if that reply is not available the
 * password is destroyed rather than posted. And an ambiguous match comes back
 * as a menu of the actual candidates, because the alternative is asking someone
 * to retype a name that already matched two people.
 */

const log = moduleLogger('outcome');

export class DiscordOutcomeSink implements OutcomeSink {
  constructor(private readonly client: Client) {}

  async deliver(outcome: ExecutionOutcome): Promise<void> {
    const pending = replies.take(outcome.request.id);

    try {
      if (outcome.succeeded) {
        await this.deliverSuccess(outcome, pending);
      } else {
        await this.deliverFailure(outcome, pending);
      }
    } catch (cause) {
      log.error({ err: cause, requestId: outcome.request.id }, 'Could not report a job outcome');
    } finally {
      // Whatever happened above, no plaintext survives this call.
      this.destroyCredential(outcome);
    }
  }

  private destroyCredential(outcome: ExecutionOutcome): void {
    const key = vault.keys.deliverablePassword(outcome.request.id);
    const remaining = vault.take(key);
    if (remaining) {
      forgetSecret(remaining);
      log.warn(
        { requestId: outcome.request.id },
        'A temporary password could not be delivered and has been destroyed',
      );
    }
  }

  private async deliverSuccess(
    outcome: ExecutionOutcome,
    pending: replies.PendingReply | undefined,
  ): Promise<void> {
    const { request, action, result } = outcome;
    if (!result) return;

    const completedAt = request.completed_at ?? new Date().toISOString();

    switch (action.action) {
      case 'CREATE_ACCOUNT': {
        const data = result.data as CreatedAccount;
        await this.deliverWithCredential({
          outcome,
          pending,
          embed: accountCreatedEmbed({
            reference: request.reference,
            account: data.account,
            completedAt,
            dryRun: result.dryRun,
          }),
          credentialIntro: result.dryRun
            ? 'This was a test run, so no account exists yet. The password below is the one that would have been set.'
            : 'Here are the sign-in details. Only you can see this message.',
          username: data.account.username ?? '',
        });
        return;
      }

      case 'RESET_PASSWORD': {
        const data = result.data as PasswordResetResult;
        await this.deliverWithCredential({
          outcome,
          pending,
          embed: stateChangeEmbed({
            reference: request.reference,
            title: 'Password reset',
            before: data.account,
            after: data.account,
            completedAt,
            dryRun: result.dryRun,
          }),
          credentialIntro: result.dryRun
            ? 'This was a test run, so the password was not changed. Below is what would have been set.'
            : 'Here is the new temporary password. Only you can see this message.',
          username: data.account.username ?? '',
        });
        return;
      }

      case 'CLEAR_LICENSE': {
        const data = result.data as StateChange;
        await this.send(pending, {
          embeds: [
            stateChangeEmbed({
              reference: request.reference,
              title: 'License cleared',
              before: data.before,
              after: data.after,
              completedAt,
              dryRun: result.dryRun,
            }),
          ],
        });
        return;
      }

      case 'DEACTIVATE_ACCOUNT': {
        const data = result.data as StateChange;
        await this.send(pending, {
          embeds: [
            stateChangeEmbed({
              reference: request.reference,
              title: 'Account deactivated',
              before: data.before,
              after: data.after,
              completedAt,
              dryRun: result.dryRun,
            }),
          ],
        });
        return;
      }

      case 'CHECK_AGENT_STATUS': {
        await this.send(pending, {
          embeds: [
            agentStatusEmbed({
              reference: request.reference,
              account: result.data as ReadymodeAccount,
            }),
          ],
        });
        return;
      }

      case 'CHECK_LICENSE_USAGE': {
        await this.send(pending, {
          embeds: [
            licenseUsageEmbed({
              reference: request.reference,
              usage: result.data as LicenseUsage,
              ...(action.licenseType ? { licenseType: action.licenseType } : {}),
            }),
          ],
        });
        return;
      }

      case 'LIST_RECENT_ACTIONS':
        return;
    }
  }

  /**
   * Deliver a result that carries a password.
   *
   * The password is only ever put in a reply that Discord will show to one
   * person. If the private channel back to the requester is gone — the token
   * expired, the process restarted — nothing is posted and the password is
   * discarded. There is no fallback that makes it public, and there is no
   * stored copy to retrieve later, because it is never written down.
   */
  private async deliverWithCredential(input: {
    outcome: ExecutionOutcome;
    pending: replies.PendingReply | undefined;
    embed: ReturnType<typeof accountCreatedEmbed>;
    credentialIntro: string;
    username: string;
  }): Promise<void> {
    const { outcome, pending, embed, credentialIntro, username } = input;
    const password = vault.take(vault.keys.deliverablePassword(outcome.request.id));

    if (!password) {
      await this.send(pending, { embeds: [embed] });
      return;
    }

    const credentialBody =
      `${credentialIntro}\n\n` +
      `**Username:** \`${escapeForDiscord(username)}\`\n` +
      `**Temporary password:** ||\`${password}\`||\n\n` +
      'Give this to them over a private channel and have them change it at first sign-in. ' +
      'I do not keep a copy — if you lose it, run the reset again.';

    const deliveredPrivately = await this.sendPrivately(pending, outcome, {
      embeds: [embed],
      content: credentialBody,
    });

    forgetSecret(password);

    if (deliveredPrivately) {
      await audit.recordForRequest(outcome.request, 'CREDENTIALS_DELIVERED', {
        metadata: { method: deliveredPrivately, passwordDelivered: true },
      });
      return;
    }

    // Could not reach them privately. Say so publicly without the password.
    await this.send(pending, {
      embeds: [embed],
      content:
        'I could not send the temporary password privately, so I have destroyed it rather than post it here. ' +
        'Run the password reset again and I will send a fresh one.',
    });
    await audit.recordForRequest(outcome.request, 'CREDENTIALS_DELIVERED', {
      metadata: { method: 'none', passwordDelivered: false },
      errorMessage: 'No private channel was available; the password was destroyed undelivered.',
    });
  }

  /**
   * Try the ephemeral reply first, then a direct message. Returns how it was
   * delivered, or null if neither worked.
   */
  private async sendPrivately(
    pending: replies.PendingReply | undefined,
    outcome: ExecutionOutcome,
    payload: { embeds: unknown[]; content: string },
  ): Promise<'ephemeral' | 'direct_message' | null> {
    if (pending?.ephemeral) {
      try {
        await editOrFollowUp(pending.interaction, payload);
        return 'ephemeral';
      } catch (cause) {
        log.warn({ err: cause, requestId: outcome.request.id }, 'Ephemeral credential delivery failed');
      }
    }

    try {
      const user = await this.client.users.fetch(outcome.request.requester_discord_id);
      await user.send(payload as never);
      return 'direct_message';
    } catch (cause) {
      log.warn({ err: cause, requestId: outcome.request.id }, 'Direct message credential delivery failed');
      return null;
    }
  }

  private async deliverFailure(
    outcome: ExecutionOutcome,
    pending: replies.PendingReply | undefined,
  ): Promise<void> {
    const { request, error } = outcome;
    if (!error) return;

    const embed = failureEmbed({
      reference: request.reference,
      message: error.userMessage,
    });

    // An ambiguous match is the one failure with a next step attached, so it
    // comes back with the actual candidates rather than just an apology.
    if (error.category === 'AMBIGUOUS_MATCH') {
      const menu = this.buildCandidateMenu(request.id, error.details);
      if (menu) {
        await this.send(pending, { embeds: [embed], components: [menu] });
        return;
      }
    }

    if (error.category === 'AUTH_EXPIRED' || error.category === 'VERIFICATION_REQUIRED') {
      await this.send(pending, {
        embeds: [embed],
        content:
          'Your request has been kept and will run once an administrator reconnects Readymode. ' +
          'You do not need to submit it again.',
      });
      return;
    }

    await this.send(pending, { embeds: [embed] });
  }

  private buildCandidateMenu(
    requestId: string,
    details: Record<string, unknown>,
  ): ActionRowBuilder<StringSelectMenuBuilder> | undefined {
    const raw = details['candidates'];
    if (!Array.isArray(raw) || raw.length === 0) return undefined;

    const options = raw
      .slice(0, 25)
      .map((candidate) => candidate as { key?: unknown; label?: unknown })
      .filter(
        (candidate): candidate is { key: string; label: string } =>
          typeof candidate.key === 'string' && typeof candidate.label === 'string',
      )
      .map((candidate) =>
        new StringSelectMenuOptionBuilder()
          .setValue(truncate(candidate.key, 100))
          .setLabel(truncate(escapeForDiscord(candidate.label, 90), 100)),
      );

    if (options.length === 0) return undefined;

    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(encodeComponentId({ kind: 'pick_account', requestId, nonce: newNonce() }))
        .setPlaceholder('Select the correct account')
        .addOptions(options),
    );
  }

  /**
   * Send through the original interaction when it is still usable, otherwise
   * post into the channel. The result is recorded either way; this only
   * decides where the person reads it.
   */
  private async send(
    pending: replies.PendingReply | undefined,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (pending) {
      try {
        await editOrFollowUp(pending.interaction, payload);
        return;
      } catch (cause) {
        log.warn({ err: cause }, 'Could not edit the original reply; falling back to the channel');
      }
    }

    const channelId = pending?.channelId;
    if (!channelId) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel?.isTextBased() && 'send' in channel) {
        const mention = pending?.requesterDiscordId
          ? { content: `<@${pending.requesterDiscordId}>` }
          : {};
        await channel.send({ ...payload, ...mention } as never);
      }
    } catch (cause) {
      log.error({ err: cause, channelId }, 'Could not post the outcome to the channel either');
    }
  }
}

async function editOrFollowUp(
  interaction: RepliableInteraction,
  payload: Record<string, unknown>,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(payload as never);
    return;
  }
  await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral } as never);
}
