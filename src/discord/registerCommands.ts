import { REST, Routes } from 'discord.js';
import { env } from '../config';
import { logger } from '../security/logger';
import { redactString } from '../security/redaction';
import { buildCommandPayload, findOptionOrderProblems } from './commands';

/**
 * Registers slash commands with Discord. Run after deploying, or whenever the
 * command list changes:
 *
 *   npm run register:commands              (global)
 *   GUILD_ID=... npm run register:commands (single guild, applies immediately)
 *
 * Also exposed as POST /api/discord/register-commands for deployments without
 * shell access.
 */

export class CommandSchemaError extends Error {
  constructor(readonly problems: ReturnType<typeof findOptionOrderProblems>) {
    super(
      `Discord requires required options to come before optional ones. ${problems
        .map((problem) => `/${problem.command}: "${problem.option}" follows optional "${problem.after}"`)
        .join('; ')}`,
    );
    this.name = 'CommandSchemaError';
  }
}

export async function registerCommands(guildId?: string): Promise<number> {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_CLIENT_ID) {
    throw new Error('DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID are required to register commands.');
  }

  const body = buildCommandPayload();

  // Fail locally with a precise message rather than sending a payload Discord
  // will reject with an error that names an array index and nothing else.
  const problems = findOptionOrderProblems(body);
  if (problems.length > 0) throw new CommandSchemaError(problems);

  const rest = new REST({ version: '10' }).setToken(env.DISCORD_BOT_TOKEN);
  const route = guildId
    ? Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, guildId)
    : Routes.applicationCommands(env.DISCORD_CLIENT_ID);

  await rest.put(route, { body });
  return body.length;
}

/** What went wrong, in a form that is safe to log and to return to an Owner. */
export interface RegistrationFailure {
  /** Safe, user-facing sentence. */
  reason: string;
  /** Discord's own error code, when it supplied one. */
  code?: number;
  status?: number;
  method?: string;
  /** API route only — never carries the token, which travels in a header. */
  route?: string;
  /**
   * Structural paths Discord rejected, for example
   * `2.options.1`. These name positions in the payload, not user data.
   */
  fields?: string[];
}

interface DiscordRestError {
  code?: number | string;
  status?: number;
  method?: string;
  url?: string;
  message?: string;
  rawError?: { errors?: unknown };
}

/** Walks Discord's nested `errors` object and collects the field paths only. */
function collectFieldPaths(node: unknown, path: string[] = [], found: string[] = []): string[] {
  if (found.length >= 25 || !node || typeof node !== 'object') return found;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '_errors') {
      if (path.length > 0) found.push(path.join('.'));
      continue;
    }
    collectFieldPaths(value, [...path, key], found);
  }
  return found;
}

/**
 * Classifies a registration failure.
 *
 * Deliberately narrow: the code, status, method, route and field paths are
 * structural. The bot token travels in an Authorization header that Discord's
 * error object does not carry, and the message is redacted before it is used,
 * so nothing sensitive can escape through here.
 */
export function describeRegistrationError(error: unknown): RegistrationFailure {
  if (error instanceof CommandSchemaError) {
    return {
      reason:
        'ReadySupport refused to send the commands: a required option was declared after an optional one, which Discord does not allow. This is a bug in the command definitions.',
      fields: error.problems.map((problem) => `${problem.command}.${problem.option}`),
    };
  }

  const rest = error as DiscordRestError;
  const code = typeof rest?.code === 'number' ? rest.code : undefined;
  const status = typeof rest?.status === 'number' ? rest.status : undefined;
  const fields = collectFieldPaths(rest?.rawError?.errors);

  // 50035 is "Invalid Form Body" — the schema was rejected.
  if (code === 50035 || status === 400) {
    return {
      reason: 'Discord rejected the command schema.',
      code,
      status,
      method: rest?.method,
      route: safeRoute(rest?.url),
      fields,
    };
  }

  if (status === 401 || code === 0) {
    return {
      reason: 'Discord rejected the bot credentials. Check DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID.',
      code,
      status,
    };
  }

  if (status === 403) {
    return {
      reason:
        'Discord refused the request. The bot may not be in that server, or may lack the applications.commands scope — reinstall it from the install link.',
      code,
      status,
    };
  }

  if (status === 404) {
    return {
      reason:
        'Discord could not find that application or server. Check DISCORD_CLIENT_ID and the guild id.',
      code,
      status,
    };
  }

  if (status === 429) {
    return { reason: 'Discord rate limited the registration. Try again shortly.', code, status };
  }

  return {
    reason: 'Discord did not accept the command registration.',
    code,
    status,
    method: rest?.method,
    route: safeRoute(rest?.url),
  };
}

/** Keeps the API path, drops query strings, and redacts anything token-shaped. */
function safeRoute(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return redactString(new URL(url).pathname).slice(0, 200);
  } catch {
    return redactString(String(url).split('?')[0]).slice(0, 200);
  }
}

if (require.main === module) {
  registerCommands(process.env.GUILD_ID)
    .then((count) => {
      logger.info({ count, guildId: process.env.GUILD_ID ?? 'global' }, 'Slash commands registered');
      process.exit(0);
    })
    .catch((error) => {
      const failure = describeRegistrationError(error);
      logger.error({ ...failure }, 'Failed to register slash commands');
      process.stderr.write(`${failure.reason}\n`);
      if (failure.fields?.length) {
        process.stderr.write(`Rejected fields: ${failure.fields.join(', ')}\n`);
      }
      process.exit(1);
    });
}
