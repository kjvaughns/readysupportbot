import OpenAI from 'openai';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  ACTION_TYPES,
  structuredActionSchema,
  type ActionType,
  type StructuredAction,
} from '../domain/actions.js';
import { allowedActions, type BotRole } from '../domain/roles.js';
import { errorFor } from '../domain/errors.js';
import { moduleLogger } from '../util/logger.js';
import { sanitizeRequestText } from './guards.js';
import { buildUserPrompt, INTERPRETATION_JSON_SCHEMA, SYSTEM_PROMPT } from './prompt.js';

/**
 * Natural language to structured action.
 *
 * The model classifies and extracts; it decides nothing. What comes back is
 * parsed against a strict schema, mapped into the same discriminated union a
 * slash command produces, and then travels the identical path: permission
 * check, confirmation, queue. There is no branch where model output reaches a
 * browser without a human having confirmed the exact values.
 */

const log = moduleLogger('nlp');

let client: OpenAI | undefined;

function openai(): OpenAI {
  client ??= new OpenAI({ apiKey: env().OPENAI_API_KEY });
  return client;
}

/** Test helper — inject a stub client. */
export function setOpenAiClient(replacement: OpenAI | undefined): void {
  client = replacement;
}

/** The shape the model is required to return, re-validated on arrival. */
const modelResponseSchema = z.object({
  outcome: z.enum(['action', 'need_more_info', 'unsupported']),
  action: z.enum(ACTION_TYPES).nullable(),
  fields: z.record(z.string().nullable()).default({}),
  missing: z.array(z.string()).default([]),
  question: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
});

export type Interpretation =
  | { kind: 'action'; action: StructuredAction }
  | {
      kind: 'need_more_info';
      action: ActionType;
      /** One specific question naming exactly what is missing. */
      question: string;
      missing: string[];
      /** What was understood so far, for pre-filling the form. */
      partial: Record<string, string>;
    }
  | { kind: 'unsupported'; message: string }
  | { kind: 'blocked'; message: string };

/** Drop nulls and empty strings so optional fields stay genuinely absent. */
function compact(fields: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.trim().length > 0) out[key] = value.trim();
  }
  return out;
}

/**
 * Build the action payload from extracted fields.
 *
 * Note what is not here: no defaulting, no deriving a username from a name, no
 * inferring a role. A field the requester did not state stays absent and the
 * schema decides whether that is fatal.
 */
function assemble(action: ActionType, fields: Record<string, string>): Record<string, unknown> {
  const target = {
    ...(fields['readymodeUserId'] ? { readymodeUserId: fields['readymodeUserId'] } : {}),
    ...(fields['username'] ? { username: fields['username'] } : {}),
    ...(fields['email'] ? { email: fields['email'] } : {}),
    ...(fields['fullName'] ? { fullName: fields['fullName'] } : {}),
  };

  switch (action) {
    case 'CREATE_ACCOUNT':
      return {
        action,
        ...(fields['firstName'] ? { firstName: fields['firstName'] } : {}),
        ...(fields['lastName'] ? { lastName: fields['lastName'] } : {}),
        ...(fields['email'] ? { email: fields['email'] } : {}),
        ...(fields['username'] ? { username: fields['username'] } : {}),
        ...(fields['agentRole'] ? { agentRole: fields['agentRole'] } : {}),
        ...(fields['licenseType'] ? { licenseType: fields['licenseType'] } : {}),
        ...(fields['team'] ? { team: fields['team'] } : {}),
        ...(fields['campaign'] ? { campaign: fields['campaign'] } : {}),
        ...(fields['queue'] ? { queue: fields['queue'] } : {}),
      };
    case 'CLEAR_LICENSE':
    case 'RESET_PASSWORD':
    case 'CHECK_AGENT_STATUS':
      return { action, target };
    case 'DEACTIVATE_ACCOUNT':
      return { action, target, ...(fields['reason'] ? { reason: fields['reason'] } : {}) };
    case 'CHECK_LICENSE_USAGE':
      return { action, ...(fields['licenseType'] ? { licenseType: fields['licenseType'] } : {}) };
    case 'LIST_RECENT_ACTIONS':
      return { action };
  }
}

/** Turn Zod issues into one plain-language question. */
function questionFrom(issues: z.ZodIssue[], action: ActionType): { question: string; missing: string[] } {
  const missing = [...new Set(issues.map((issue) => issue.path.join('.') || 'details'))];

  // A schema message written for a person beats a generated list of paths.
  const spoken = issues[0]?.message;
  if (spoken && issues.length === 1) {
    return { question: spoken, missing };
  }

  const readable = missing.map(humanFieldName).join(', ');
  return {
    question: `Before I can ${describeAction(action)} I need: ${readable}. Could you give me those?`,
    missing,
  };
}

function humanFieldName(path: string): string {
  const leaf = path.split('.').pop() ?? path;
  return leaf
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (character) => character.toUpperCase())
    .trim()
    .toLowerCase();
}

function describeAction(action: ActionType): string {
  switch (action) {
    case 'CREATE_ACCOUNT':
      return 'create the account';
    case 'CLEAR_LICENSE':
      return 'clear the license';
    case 'RESET_PASSWORD':
      return 'reset the password';
    case 'DEACTIVATE_ACCOUNT':
      return 'deactivate the account';
    case 'CHECK_AGENT_STATUS':
      return 'check that agent';
    case 'CHECK_LICENSE_USAGE':
      return 'check license usage';
    case 'LIST_RECENT_ACTIONS':
      return 'list recent actions';
  }
}

export interface InterpretOptions {
  text: string;
  /** Used to tell the requester which actions are open to them. */
  role: BotRole;
  /** Overrides the configured model; used by tests. */
  model?: string;
}

export async function interpret(options: InterpretOptions): Promise<Interpretation> {
  const sanitized = sanitizeRequestText(options.text);

  if (sanitized.blocked) {
    return { kind: 'blocked', message: sanitized.blockReason ?? 'I could not process that message.' };
  }

  if (sanitized.credentialsRemoved) {
    return {
      kind: 'blocked',
      message:
        'That message looked like it contained a password or a key, so I did not process it. ' +
        'Never post credentials in a channel — I generate temporary passwords myself and send them privately.',
    };
  }

  let raw: string;
  try {
    const completion = await openai().chat.completions.create({
      model: options.model ?? env().OPENAI_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(sanitized.text) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'readysupport_interpretation',
          strict: true,
          schema: INTERPRETATION_JSON_SCHEMA as unknown as Record<string, unknown>,
        },
      },
    });

    raw = completion.choices[0]?.message?.content ?? '';
  } catch (cause) {
    log.error({ err: cause }, 'Could not reach the interpretation service');
    throw errorFor('UPSTREAM_UNAVAILABLE', {
      message:
        'I could not read that request just now. Try again in a moment, or use the matching slash command.',
      cause,
    });
  }

  let parsed: z.infer<typeof modelResponseSchema>;
  try {
    parsed = modelResponseSchema.parse(JSON.parse(raw));
  } catch (cause) {
    log.warn({ err: cause }, 'Interpretation did not match the expected schema');
    return {
      kind: 'unsupported',
      message:
        'I could not turn that into something I know how to do. ' +
        `I can: ${allowedActions(options.role).map(describeAction).join(', ')}.`,
    };
  }

  if (parsed.outcome === 'unsupported' || !parsed.action) {
    return {
      kind: 'unsupported',
      message:
        `${parsed.reason ?? 'That is not something I know how to do.'} ` +
        `I can: ${allowedActions(options.role).map(describeAction).join(', ')}.`,
    };
  }

  const action = parsed.action;
  const fields = compact(parsed.fields);
  const candidate = assemble(action, fields);

  // The schema is the authority, not the model's own opinion of whether it has
  // everything. A model claiming outcome "action" while omitting a required
  // field still lands in need_more_info.
  const validated = structuredActionSchema.safeParse(candidate);

  if (validated.success) {
    return { kind: 'action', action: validated.data };
  }

  const { question, missing } = questionFrom(validated.error.issues, action);
  return {
    kind: 'need_more_info',
    action,
    question: parsed.question && parsed.missing.length > 0 ? parsed.question : question,
    missing,
    partial: fields,
  };
}
