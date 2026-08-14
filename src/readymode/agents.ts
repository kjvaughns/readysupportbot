import { LinkedAgent, ReadymodeAgent } from '../types';
import { AgentTarget } from '../openai/schema';
import { sanitizePageValue } from '../security/sanitize';

/**
 * Recipient resolution.
 *
 * An action is never performed on the strength of a first name. A target has to
 * resolve to exactly one Readymode account through one of the accepted
 * strategies, in this order:
 *
 *   1. Readymode user id
 *   2. Exact username
 *   3. Exact email address
 *   4. Unique exact full name
 *   5. Linked Discord user
 *
 * Anything else stops and asks the requester to choose.
 */

export type AgentMatch =
  | { status: 'unique'; agent: ReadymodeAgent; strategy: MatchStrategy }
  | { status: 'ambiguous'; candidates: ReadymodeAgent[]; strategy: MatchStrategy }
  | { status: 'not_found' }
  | { status: 'not_linked' }
  | { status: 'needs_full_name'; provided: string };

export type MatchStrategy =
  | 'readymode_user_id'
  | 'username'
  | 'email'
  | 'full_name'
  | 'linked_discord_user';

function normalize(value: string | null | undefined): string {
  return sanitizePageValue(String(value ?? '')).toLowerCase().replace(/\s+/g, ' ').trim();
}

function isFullName(value: string): boolean {
  // Two or more parts, each at least two characters. "Marcus" alone is not enough.
  const parts = normalize(value).split(' ').filter((part) => part.length >= 2);
  return parts.length >= 2;
}

function decide(matches: ReadymodeAgent[], strategy: MatchStrategy): AgentMatch {
  if (matches.length === 1) return { status: 'unique', agent: matches[0], strategy };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches, strategy };
  return { status: 'not_found' };
}

export interface MatchContext {
  /** Every agent visible in the organization's Readymode account. */
  agents: ReadymodeAgent[];
  /** Discord-to-Readymode links stored for this organization. */
  linkedAgents: LinkedAgent[];
  /** Discord user making the request, used to resolve "me" and "my". */
  requesterDiscordUserId?: string | null;
}

/** Resolves the target of a request to exactly one Readymode account. */
export function matchAgent(target: AgentTarget, context: MatchContext): AgentMatch {
  const agents = context.agents ?? [];

  switch (target.kind) {
    case 'self': {
      if (!context.requesterDiscordUserId) return { status: 'not_linked' };
      return matchByDiscordUser(context.requesterDiscordUserId, context);
    }

    case 'discord_user':
      return matchByDiscordUser(target.discordUserId, context);

    case 'readymode_user_id': {
      const wanted = String(target.readymodeUserId).trim();
      return decide(
        agents.filter((agent) => String(agent.readymodeUserId).trim() === wanted),
        'readymode_user_id',
      );
    }

    case 'username': {
      const wanted = normalize(target.username);
      return decide(
        agents.filter((agent) => normalize(agent.username) === wanted),
        'username',
      );
    }

    case 'email': {
      const wanted = normalize(target.email);
      return decide(
        agents.filter((agent) => normalize(agent.email) === wanted),
        'email',
      );
    }

    case 'name': {
      const wanted = normalize(target.name);

      // A username or email that arrived labelled as a name still resolves,
      // because those are exact identifiers.
      const byUsername = agents.filter((agent) => normalize(agent.username) === wanted);
      if (byUsername.length === 1) {
        return { status: 'unique', agent: byUsername[0], strategy: 'username' };
      }
      const byEmail = agents.filter((agent) => normalize(agent.email) === wanted);
      if (byEmail.length === 1) {
        return { status: 'unique', agent: byEmail[0], strategy: 'email' };
      }

      if (!isFullName(wanted)) {
        return { status: 'needs_full_name', provided: target.name };
      }

      return decide(
        agents.filter((agent) => normalize(agent.fullName) === wanted),
        'full_name',
      );
    }

    default:
      return { status: 'not_found' };
  }
}

function matchByDiscordUser(discordUserId: string, context: MatchContext): AgentMatch {
  const links = (context.linkedAgents ?? []).filter(
    (link) => link.discordUserId === discordUserId,
  );

  if (links.length === 0) return { status: 'not_linked' };

  const matched = links
    .map((link) =>
      context.agents.find(
        (agent) => String(agent.readymodeUserId) === String(link.readymodeUserId),
      ) ?? {
        readymodeUserId: link.readymodeUserId,
        username: link.username,
        fullName: link.fullName ?? null,
        email: link.email ?? null,
      },
    )
    .filter(Boolean) as ReadymodeAgent[];

  if (matched.length > 1) {
    return { status: 'ambiguous', candidates: matched, strategy: 'linked_discord_user' };
  }
  if (matched.length === 0) return { status: 'not_found' };
  return { status: 'unique', agent: matched[0], strategy: 'linked_discord_user' };
}

/** Human-readable description used in Discord replies. */
export function describeAgent(agent: ReadymodeAgent): string {
  const name = sanitizePageValue(agent.fullName ?? agent.username);
  const username = sanitizePageValue(agent.username);
  return name && name !== username ? `${name} (${username})` : name || username;
}

/** Message shown when a target could not be resolved to one account. */
export function describeMatchFailure(match: AgentMatch): string {
  switch (match.status) {
    case 'ambiguous':
      return [
        'More than one Readymode account matches that. Reply with the exact username of the one you mean:',
        ...match.candidates
          .slice(0, 10)
          .map((agent) => `- ${describeAgent(agent)} (id ${agent.readymodeUserId})`),
      ].join('\n');
    case 'not_linked':
      return 'Your Discord account is not linked to exactly one Readymode account, so I cannot tell who you are. Ask an Owner to link it, or name the agent explicitly.';
    case 'needs_full_name':
      return `"${sanitizePageValue(match.provided)}" is only part of a name. Give the full name, the username, or the email address.`;
    case 'not_found':
      return 'I could not find a Readymode account matching that.';
    default:
      return 'I could not identify that agent.';
  }
}
