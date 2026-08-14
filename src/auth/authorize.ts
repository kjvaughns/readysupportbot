import type { ActionType } from '../domain/actions.js';
import { errorFor, ReadySupportError } from '../domain/errors.js';
import { allowedActions, can, type BotRole } from '../domain/roles.js';
import * as botUsers from '../db/repositories/botUsers.js';
import * as approvedPlaces from '../db/repositories/approvedPlaces.js';
import { rateLimiter, RateLimiter, type BudgetKind } from '../security/ratelimit.js';
import type { ChannelPurpose } from '../db/types.js';

/**
 * Authorization.
 *
 * Four independent gates, checked in this order, all of which must pass:
 *
 *   1. the server is on the allow-list
 *   2. the channel is on the allow-list for this purpose
 *   3. the Discord user maps to an active bot_users row
 *   4. that user's role permits the action
 *
 * Discord's own roles and permissions are never consulted. Someone with
 * Administrator in the server has no standing here unless they are in
 * bot_users, and a server owner cannot grant themselves access by editing
 * roles.
 */

export interface Principal {
  discordUserId: string;
  discordUsername: string | null;
  botUserId: string;
  role: BotRole;
}

export interface AuthorizeInput {
  discordUserId: string;
  discordUsername?: string | null;
  guildId: string | null;
  channelId: string;
  purpose: ChannelPurpose;
  action?: ActionType;
  /** Which rate-limit budget to draw from. Omit to skip rate limiting. */
  budget?: BudgetKind;
}

export interface AuthorizationDenied {
  ok: false;
  error: ReadySupportError;
  /**
   * True when the denial is worth alerting an OWNER about — an unknown user or
   * an unapproved server, rather than a VIEWER reaching for something above
   * their level.
   */
  suspicious: boolean;
}

export interface AuthorizationGranted {
  ok: true;
  principal: Principal;
}

export type AuthorizationResult = AuthorizationGranted | AuthorizationDenied;

function deny(
  error: ReadySupportError,
  suspicious = false,
): AuthorizationDenied {
  return { ok: false, error, suspicious };
}

/**
 * Resolve and authorize a Discord interaction.
 *
 * Note the deliberately vague wording of the denials. Someone probing the bot
 * from an unapproved server learns only that it will not answer them, not
 * which of the four gates they failed or who is allowed.
 */
export async function authorize(
  input: AuthorizeInput,
  limiter: RateLimiter = rateLimiter,
): Promise<AuthorizationResult> {
  // 1. Server allow-list. A DM has no guild and is never a valid channel for
  //    a request, because the audit trail needs a server context.
  if (!input.guildId) {
    return deny(
      errorFor('PERMISSION_DENIED', {
        message: 'ReadySupport only works inside an approved server channel, not in direct messages.',
      }),
    );
  }

  if (!(await approvedPlaces.isGuildApproved(input.guildId))) {
    return deny(
      errorFor('PERMISSION_DENIED', {
        message: 'ReadySupport is not set up for this server.',
        details: { guildId: input.guildId },
      }),
      true,
    );
  }

  // 2. Channel allow-list, scoped to what the channel is for.
  if (!(await approvedPlaces.isChannelApproved(input.channelId, input.purpose))) {
    return deny(
      errorFor('PERMISSION_DENIED', {
        message:
          input.purpose === 'NATURAL_LANGUAGE'
            ? 'This channel is not set up for free-form requests.'
            : 'ReadySupport is not enabled in this channel.',
        details: { channelId: input.channelId, purpose: input.purpose },
      }),
    );
  }

  // 3. Known, active user.
  const user = await botUsers.findActiveByDiscordId(input.discordUserId);
  if (!user) {
    return deny(
      errorFor('PERMISSION_DENIED', {
        message: 'You are not set up to use ReadySupport. Ask an owner to add you.',
        details: { discordUserId: input.discordUserId },
      }),
      true,
    );
  }

  const principal: Principal = {
    discordUserId: user.discord_user_id,
    discordUsername: input.discordUsername ?? user.discord_username,
    botUserId: user.id,
    role: user.role,
  };

  // 4. Role permits the action.
  if (input.action && !can(principal.role, input.action)) {
    return deny(
      errorFor('PERMISSION_DENIED', {
        message:
          `Your ReadySupport role (${principal.role}) does not allow that. ` +
          `You can use: ${allowedActions(principal.role).join(', ')}.`,
        details: { role: principal.role, action: input.action },
      }),
    );
  }

  // Rate limit last, so a blocked-but-authorized user still gets a useful
  // message and an unauthorized one never consumes their own budget.
  if (input.budget) {
    const decision = limiter.consume(principal.discordUserId, input.budget);
    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      return deny(
        errorFor('RATE_LIMITED', {
          message: `That is a lot of requests at once. Try again in about ${seconds} second${seconds === 1 ? '' : 's'}.`,
          details: { retryAfterMs: decision.retryAfterMs },
        }),
      );
    }
  }

  return { ok: true, principal };
}

/**
 * Resolve a user without the guild/channel checks. Used when an already
 * authorized interaction needs the role of a *different* user, such as the
 * second approver clicking Confirm.
 */
export async function resolvePrincipal(discordUserId: string): Promise<Principal | null> {
  const user = await botUsers.findActiveByDiscordId(discordUserId);
  if (!user) return null;
  return {
    discordUserId: user.discord_user_id,
    discordUsername: user.discord_username,
    botUserId: user.id,
    role: user.role,
  };
}
