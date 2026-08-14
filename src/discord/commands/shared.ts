import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { z } from 'zod';
import { accountRefSchema, type AccountRef, type ActionType } from '../../domain/actions.js';
import type { Principal } from '../../auth/authorize.js';
import type { BudgetKind } from '../../security/ratelimit.js';

/**
 * Shared pieces of the slash command surface.
 */

export interface CommandHandlerInput {
  interaction: ChatInputCommandInteraction;
  principal: Principal;
}

export interface CommandDefinition {
  name: string;
  /** The action this command requests, for the permission check. */
  action?: ActionType;
  /** Which rate-limit budget it draws from. */
  budget: BudgetKind;
  /** True when the reply must only be visible to the person who ran it. */
  ephemeral: boolean;
  build(): SlashCommandBuilder | Omit<SlashCommandBuilder, 'addSubcommand' | 'addSubcommandGroup'>;
  handle(input: CommandHandlerInput): Promise<void>;
}

/**
 * The four ways to name an account, offered on every command that targets one.
 *
 * All four are optional individually and at least one is required — the schema
 * enforces that, with a message explaining why a first name on its own will not
 * do.
 */
export function addTargetOptions(builder: SlashCommandBuilder): SlashCommandBuilder {
  // The builder mutates in place; the return values are the same instance.
  builder.addStringOption((option) =>
    option
      .setName('username')
      .setDescription('Their Readymode username — the most reliable way to identify someone')
      .setMaxLength(64),
  );
  builder.addStringOption((option) =>
    option.setName('email').setDescription('Their email address').setMaxLength(254),
  );
  builder.addStringOption((option) =>
    option
      .setName('full_name')
      .setDescription('Their full first and last name (a first name alone is not enough)')
      .setMaxLength(120),
  );
  builder.addStringOption((option) =>
    option.setName('user_id').setDescription('Their Readymode user ID, if you know it').setMaxLength(64),
  );

  return builder;
}

/** Read the four target options into an AccountRef, or explain what is wrong. */
export function readTarget(
  interaction: ChatInputCommandInteraction,
): { ok: true; target: AccountRef } | { ok: false; message: string } {
  const candidate = {
    ...optional(interaction, 'user_id', 'readymodeUserId'),
    ...optional(interaction, 'username', 'username'),
    ...optional(interaction, 'email', 'email'),
    ...optional(interaction, 'full_name', 'fullName'),
  };

  const parsed = accountRefSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, target: parsed.data };

  return { ok: false, message: firstIssueMessage(parsed.error) };
}

function optional(
  interaction: ChatInputCommandInteraction,
  optionName: string,
  fieldName: string,
): Record<string, string> {
  const value = interaction.options.getString(optionName);
  return value && value.trim().length > 0 ? { [fieldName]: value.trim() } : {};
}

/** The first problem, phrased for a person rather than a validator. */
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Some of those details were not valid.';

  const path = issue.path.join('.');
  return path ? `${humanise(path)}: ${issue.message}` : issue.message;
}

function humanise(path: string): string {
  const leaf = path.split('.').pop() ?? path;
  return leaf
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase())
    .trim();
}

/** Collect every problem, for a form that can show them all at once. */
export function allIssueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${humanise(path)}: ${issue.message}` : issue.message;
  });
}
