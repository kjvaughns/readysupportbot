import OpenAI from 'openai';
import { env } from '../config';
import { logger } from '../security/logger';
import { sanitizeUntrustedText, wrapUntrusted } from '../security/sanitize';
import { buildUserPrompt, SYSTEM_PROMPT } from './prompt';
import { fallbackParse } from './fallback';
import {
  buildAction,
  modelOutputSchema,
  OPENAI_JSON_SCHEMA,
  ParsedIntent,
} from './schema';

export * from './schema';

let client: OpenAI | null = null;

export function isOpenAiConfigured(): boolean {
  return Boolean(env.OPENAI_API_KEY);
}

function openAiClient(): OpenAI | null {
  if (!env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: env.OPENAI_API_KEY, maxRetries: 2, timeout: 20_000 });
  return client;
}

export interface InterpretInput {
  message: string;
  requesterDiscordUserId?: string | null;
  hasLinkedAccount?: boolean;
}

export interface InterpretResult extends ParsedIntent {
  /** Which parser produced the action. */
  source: 'openai' | 'rules';
  /** Injection patterns neutralized in the incoming message. */
  flags: string[];
}

/**
 * Converts one natural-language message into one validated action.
 *
 * The message is sanitized first, sent to the model wrapped in an explicit
 * untrusted boundary, and the model's answer is validated against the closed
 * action schema. The model never sees credentials and never controls a browser.
 */
export async function interpret(input: InterpretInput): Promise<InterpretResult> {
  const sanitized = sanitizeUntrustedText(input.message);

  if (!sanitized.text) {
    return {
      status: 'needs_information',
      message: 'Tell me what you would like ReadySupport to do.',
      source: 'rules',
      flags: sanitized.flags,
    };
  }

  const api = openAiClient();
  if (!api) {
    const parsed = buildAction(fallbackParse(sanitized.text));
    return { ...parsed, source: 'rules', flags: sanitized.flags };
  }

  try {
    const response = await api.chat.completions.create({
      model: env.OPENAI_MODEL,
      temperature: 0,
      max_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildUserPrompt({
            message: wrapUntrusted('discord_message', sanitized.text),
            requesterDiscordUserId: input.requesterDiscordUserId ?? null,
            hasLinkedAccount: Boolean(input.hasLinkedAccount),
          }),
        },
      ],
      response_format: { type: 'json_schema', json_schema: OPENAI_JSON_SCHEMA as never },
    });

    const content = response.choices[0]?.message?.content;
    if (!content) throw new Error('Empty completion.');

    const json = JSON.parse(content);
    const parsedOutput = modelOutputSchema.safeParse(normalizeRawTargets(json));
    if (!parsedOutput.success) {
      logger.warn(
        { issues: parsedOutput.error.issues.map((issue) => issue.message) },
        'Model output failed schema validation',
      );
      return {
        status: 'needs_information',
        message: 'I could not turn that into a supported action. Try rephrasing, or use a slash command.',
        source: 'openai',
        flags: sanitized.flags,
      };
    }

    return { ...buildAction(parsedOutput.data), source: 'openai', flags: sanitized.flags };
  } catch (error) {
    logger.warn({ err: error }, 'OpenAI interpretation failed; using rule-based parser');
    const parsed = buildAction(fallbackParse(sanitized.text));
    return { ...parsed, source: 'rules', flags: sanitized.flags };
  }
}

/**
 * The model emits targets as {kind, value}; the internal schema uses a
 * discriminated union. This widens the former into the latter.
 */
function normalizeRawTargets(json: any): unknown {
  const widen = (raw: any) => {
    if (!raw || typeof raw !== 'object') return null;
    const { kind, value } = raw;
    switch (kind) {
      case 'self':
        return { kind: 'self' };
      case 'discord_user':
        return value ? { kind: 'discord_user', discordUserId: String(value) } : null;
      case 'readymode_user_id':
        return value ? { kind: 'readymode_user_id', readymodeUserId: String(value) } : null;
      case 'username':
        return value ? { kind: 'username', username: String(value) } : null;
      case 'email':
        return value ? { kind: 'email', email: String(value) } : null;
      case 'name':
        return value ? { kind: 'name', name: String(value) } : null;
      default:
        return null;
    }
  };

  return {
    ...json,
    target: widen(json?.target),
    source: widen(json?.source),
  };
}

/** Live check used by /ready. */
export async function checkOpenAi(): Promise<{ ok: boolean; detail?: string }> {
  const api = openAiClient();
  if (!api) return { ok: false, detail: 'OPENAI_API_KEY is not configured.' };
  try {
    await api.models.retrieve(env.OPENAI_MODEL);
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : 'Unavailable.' };
  }
}
