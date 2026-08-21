import { z } from 'zod';
import { ACTION_TYPES } from '../types';
import { normalizeStateList } from '../readymode/states';

/**
 * The closed contract between natural language and the automation layer.
 *
 * The model is only ever allowed to fill in this structure. It never selects a
 * page, a selector, or a browser step; the action it produces is matched to a
 * predefined Playwright workflow by name.
 */

/** How a request identifies the Readymode account it is about. */
export const agentTargetSchema = z.discriminatedUnion('kind', [
  // "me", "my", "I" — resolved from the linked Discord user, never guessed.
  z.object({ kind: z.literal('self') }),
  z.object({ kind: z.literal('discord_user'), discordUserId: z.string().min(1).max(32) }),
  z.object({ kind: z.literal('readymode_user_id'), readymodeUserId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('username'), username: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('email'), email: z.string().email().max(254) }),
  // A free-form name. Resolution requires exactly one exact full-name match.
  z.object({ kind: z.literal('name'), name: z.string().min(1).max(128) }),
]);

export type AgentTarget = z.infer<typeof agentTargetSchema>;

const stateArraySchema = z
  .array(z.string().min(1).max(64))
  .min(1)
  .max(51)
  .transform((values, ctx) => {
    const { states, invalid } = normalizeStateList(values);
    if (invalid.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unrecognized states: ${invalid.join(', ')}`,
      });
      return z.NEVER;
    }
    return states;
  });

const newAccountSchema = z.object({
  fullName: z.string().min(1).max(128),
  username: z.string().min(1).max(64).optional(),
  email: z.string().email().max(254).optional(),
  campaigns: z.array(z.string().min(1).max(128)).max(50).optional(),
  queues: z.array(z.string().min(1).max(128)).max(50).optional(),
  states: stateArraySchema.optional(),
});

export type NewAccount = z.infer<typeof newAccountSchema>;

/** Readymode playlist membership levels. */
export const PLAYLIST_LEVELS = ['primary', 'backup', 'tertiary'] as const;
export const playlistLevelSchema = z.enum(PLAYLIST_LEVELS);

/** Areas the troubleshooting guidance covers. */
export const TROUBLESHOOT_TOPICS = [
  'audio',
  'login',
  'dialer',
  'leads',
  'license',
  'recording',
  'other',
] as const;
export const troubleshootTopicSchema = z.enum(TROUBLESHOOT_TOPICS);

/** The canonical, validated action the rest of the backend consumes. */
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('CREATE_ACCOUNT'), account: newAccountSchema }),
  z.object({
    action: z.literal('CREATE_ACCOUNTS'),
    accounts: z.array(newAccountSchema).min(1).max(200),
  }),
  z.object({ action: z.literal('CLEAR_LICENSE'), target: agentTargetSchema }),
  // Readymode's own "log out inactive users" control. It takes no target: the
  // application decides which sessions are idle.
  z.object({ action: z.literal('CLEAR_ALL_LICENSES') }),
  z.object({
    action: z.literal('FORCE_LOGOUT'),
    target: agentTargetSchema,
    /** Also reset the password, so the seat cannot be immediately retaken. */
    resetPassword: z.boolean().default(false),
  }),
  z.object({ action: z.literal('RESET_PASSWORD'), target: agentTargetSchema }),
  z.object({ action: z.literal('DEACTIVATE_ACCOUNT'), target: agentTargetSchema }),
  z.object({ action: z.literal('AGENT_STATUS'), target: agentTargetSchema }),
  z.object({ action: z.literal('LICENSE_USAGE') }),
  z.object({
    action: z.literal('ASSIGN_CAMPAIGNS'),
    target: agentTargetSchema,
    campaigns: z.array(z.string().min(1).max(128)).min(1).max(50),
  }),
  z.object({
    action: z.literal('ASSIGN_QUEUES'),
    target: agentTargetSchema,
    queues: z.array(z.string().min(1).max(128)).min(1).max(50),
  }),
  z.object({ action: z.literal('VIEW_PLAYLISTS'), target: agentTargetSchema.optional() }),
  z.object({
    action: z.literal('ASSIGN_PLAYLIST'),
    target: agentTargetSchema,
    playlists: z.array(z.string().min(1).max(128)).min(1).max(50),
    level: playlistLevelSchema.default('primary'),
  }),
  z.object({
    action: z.literal('REMOVE_PLAYLIST'),
    target: agentTargetSchema,
    playlists: z.array(z.string().min(1).max(128)).min(1).max(50),
  }),
  z.object({
    action: z.literal('TROUBLESHOOT'),
    topic: troubleshootTopicSchema,
    question: z.string().min(1).max(500),
  }),
  z.object({ action: z.literal('VIEW_STATES'), target: agentTargetSchema }),
  z.object({ action: z.literal('SET_STATES'), target: agentTargetSchema, states: stateArraySchema }),
  z.object({ action: z.literal('ADD_STATES'), target: agentTargetSchema, states: stateArraySchema }),
  z.object({
    action: z.literal('REMOVE_STATES'),
    target: agentTargetSchema,
    states: stateArraySchema,
  }),
  z.object({
    action: z.literal('COPY_STATE_CONFIGURATION'),
    source: agentTargetSchema,
    target: agentTargetSchema,
  }),
  z.object({ action: z.literal('SET_DEFAULT_STATES'), states: stateArraySchema }),
  z.object({ action: z.literal('RECENT_ACTIONS'), limit: z.number().int().min(1).max(50).default(10) }),
  z.object({ action: z.literal('CONNECTION_STATUS') }),
  z.object({ action: z.literal('HELP') }),
  z.object({ action: z.literal('UNSUPPORTED'), reason: z.string().max(300) }),
]);

export type Action = z.infer<typeof actionSchema>;

/**
 * Flat shape the model returns. A flat object with an action enum keeps strict
 * JSON schema output reliable; the union above is applied afterwards so an
 * invalid combination is rejected rather than partially executed.
 */
export const modelOutputSchema = z.object({
  action: z.enum(ACTION_TYPES),
  target: agentTargetSchema.nullable().optional(),
  source: agentTargetSchema.nullable().optional(),
  states: z.array(z.string()).nullable().optional(),
  campaigns: z.array(z.string()).nullable().optional(),
  queues: z.array(z.string()).nullable().optional(),
  accounts: z
    .array(
      z.object({
        fullName: z.string(),
        username: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  playlists: z.array(z.string()).nullable().optional(),
  level: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  question: z.string().nullable().optional(),
  resetPassword: z.boolean().nullable().optional(),
  limit: z.number().nullable().optional(),
  /** Set when the request cannot be mapped without more information. */
  clarification: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
});

export type ModelOutput = z.infer<typeof modelOutputSchema>;

/** JSON schema handed to the model. Kept in step with modelOutputSchema. */
export const OPENAI_JSON_SCHEMA = {
  name: 'readysupport_action',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'action',
      'target',
      'source',
      'states',
      'campaigns',
      'queues',
      'playlists',
      'level',
      'topic',
      'question',
      'resetPassword',
      'accounts',
      'limit',
      'clarification',
      'reason',
    ],
    properties: {
      action: { type: 'string', enum: [...ACTION_TYPES] },
      target: { $ref: '#/$defs/target' },
      source: { $ref: '#/$defs/target' },
      states: { type: ['array', 'null'], items: { type: 'string' } },
      campaigns: { type: ['array', 'null'], items: { type: 'string' } },
      queues: { type: ['array', 'null'], items: { type: 'string' } },
      playlists: { type: ['array', 'null'], items: { type: 'string' } },
      level: { type: ['string', 'null'], enum: ['primary', 'backup', 'tertiary', null] },
      topic: {
        type: ['string', 'null'],
        enum: ['audio', 'login', 'dialer', 'leads', 'license', 'recording', 'other', null],
      },
      question: { type: ['string', 'null'] },
      resetPassword: { type: ['boolean', 'null'] },
      accounts: {
        type: ['array', 'null'],
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['fullName', 'username', 'email'],
          properties: {
            fullName: { type: 'string' },
            username: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
          },
        },
      },
      limit: { type: ['number', 'null'] },
      clarification: { type: ['string', 'null'] },
      reason: { type: ['string', 'null'] },
    },
    $defs: {
      target: {
        type: ['object', 'null'],
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: {
            type: 'string',
            enum: ['self', 'discord_user', 'readymode_user_id', 'username', 'email', 'name'],
          },
          value: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** Shape the model actually emits for a target, before it is widened. */
export const rawTargetSchema = z.object({
  kind: z.enum(['self', 'discord_user', 'readymode_user_id', 'username', 'email', 'name']),
  value: z.string().nullable().optional(),
});

export function toAgentTarget(raw: unknown): AgentTarget | null {
  const parsed = rawTargetSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { kind, value } = parsed.data;

  if (kind === 'self') return { kind: 'self' };
  if (!value || !value.trim()) return null;

  const trimmed = value.trim();
  switch (kind) {
    case 'discord_user':
      return { kind: 'discord_user', discordUserId: trimmed.replace(/[^0-9]/g, '') };
    case 'readymode_user_id':
      return { kind: 'readymode_user_id', readymodeUserId: trimmed };
    case 'username':
      return { kind: 'username', username: trimmed };
    case 'email':
      return trimmed.includes('@') ? { kind: 'email', email: trimmed } : null;
    case 'name':
      return { kind: 'name', name: trimmed };
    default:
      return null;
  }
}

/**
 * Targets reach this point in one of two shapes: the model's flat
 * `{kind, value}` form, or the internal union produced by the rule-based
 * parser. Both are accepted; anything else resolves to null.
 */
export function coerceTarget(raw: unknown): AgentTarget | null {
  if (!raw) return null;
  const direct = agentTargetSchema.safeParse(raw);
  if (direct.success) return direct.data;
  return toAgentTarget(raw);
}

export interface ParsedIntent {
  status: 'ok' | 'needs_information' | 'unsupported';
  action?: Action;
  message?: string;
}

/**
 * Converts the model's flat output into a validated action. Anything that does
 * not satisfy the union becomes a request for more information — the workflow
 * layer is never handed a partially specified action.
 */
export function buildAction(raw: ModelOutput): ParsedIntent {
  if (raw.clarification && raw.clarification.trim()) {
    return { status: 'needs_information', message: raw.clarification.trim() };
  }

  const target = coerceTarget(raw.target);
  const source = coerceTarget(raw.source);

  const candidate: Record<string, unknown> = { action: raw.action };

  switch (raw.action) {
    case 'CREATE_ACCOUNT': {
      const first = raw.accounts?.[0];
      if (!first) return needsInfo('Which account should be created? Include the full name.');
      candidate.account = compactAccount(first);
      break;
    }
    case 'CREATE_ACCOUNTS': {
      if (!raw.accounts || raw.accounts.length === 0) {
        return needsInfo('List the accounts to create, including a full name for each.');
      }
      candidate.accounts = raw.accounts.map(compactAccount);
      break;
    }
    case 'FORCE_LOGOUT': {
      if (!target) return needsInfo('Which user should be signed out of Readymode?');
      candidate.target = target;
      candidate.resetPassword = raw.resetPassword ?? false;
      break;
    }
    case 'CLEAR_LICENSE':
    case 'RESET_PASSWORD':
    case 'DEACTIVATE_ACCOUNT':
    case 'AGENT_STATUS':
    case 'VIEW_STATES': {
      if (!target) return needsInfo('Which agent is this request for?');
      candidate.target = target;
      break;
    }
    case 'ASSIGN_CAMPAIGNS': {
      if (!target) return needsInfo('Which agent should be assigned to campaigns?');
      if (!raw.campaigns || raw.campaigns.length === 0) {
        return needsInfo('Which campaigns should be assigned?');
      }
      candidate.target = target;
      candidate.campaigns = raw.campaigns;
      break;
    }
    case 'VIEW_PLAYLISTS': {
      if (target) candidate.target = target;
      break;
    }
    case 'ASSIGN_PLAYLIST': {
      if (!target) return needsInfo('Which agent should be assigned to the playlist?');
      if (!raw.playlists || raw.playlists.length === 0) {
        return needsInfo('Which playlist should they be assigned to?');
      }
      candidate.target = target;
      candidate.playlists = raw.playlists;
      candidate.level = raw.level ?? 'primary';
      break;
    }
    case 'REMOVE_PLAYLIST': {
      if (!target) return needsInfo('Which agent should be removed from the playlist?');
      if (!raw.playlists || raw.playlists.length === 0) {
        return needsInfo('Which playlist should they be removed from?');
      }
      candidate.target = target;
      candidate.playlists = raw.playlists;
      break;
    }
    case 'TROUBLESHOOT': {
      candidate.topic = raw.topic ?? 'other';
      candidate.question = raw.question ?? 'Something is not working.';
      break;
    }
    case 'ASSIGN_QUEUES': {
      if (!target) return needsInfo('Which agent should be assigned to queues?');
      if (!raw.queues || raw.queues.length === 0) return needsInfo('Which queues should be assigned?');
      candidate.target = target;
      candidate.queues = raw.queues;
      break;
    }
    case 'SET_STATES':
    case 'ADD_STATES':
    case 'REMOVE_STATES': {
      if (!target) return needsInfo('Which agent should the state change apply to?');
      if (!raw.states || raw.states.length === 0) return needsInfo('Which states should be used?');
      candidate.target = target;
      candidate.states = raw.states;
      break;
    }
    case 'COPY_STATE_CONFIGURATION': {
      if (!source || !target) {
        return needsInfo('Name both the agent to copy from and the agent to copy to.');
      }
      candidate.source = source;
      candidate.target = target;
      break;
    }
    case 'SET_DEFAULT_STATES': {
      if (!raw.states || raw.states.length === 0) {
        return needsInfo('Which states should new agents receive by default?');
      }
      candidate.states = raw.states;
      break;
    }
    case 'RECENT_ACTIONS': {
      candidate.limit = raw.limit && raw.limit > 0 ? Math.min(50, Math.floor(raw.limit)) : 10;
      break;
    }
    case 'UNSUPPORTED': {
      candidate.reason = raw.reason ?? 'That request is not one of the supported actions.';
      break;
    }
    default:
      break;
  }

  const parsed = actionSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      status: 'needs_information',
      message: issue ? `That request could not be validated: ${issue.message}` : 'That request could not be validated.',
    };
  }

  if (parsed.data.action === 'UNSUPPORTED') {
    return { status: 'unsupported', action: parsed.data, message: parsed.data.reason };
  }

  return { status: 'ok', action: parsed.data };
}

function compactAccount(input: {
  fullName: string;
  username?: string | null;
  email?: string | null;
}): NewAccount {
  const account: NewAccount = { fullName: input.fullName.trim() };
  if (input.username && input.username.trim()) account.username = input.username.trim();
  if (input.email && input.email.trim()) account.email = input.email.trim();
  return account;
}

function needsInfo(message: string): ParsedIntent {
  return { status: 'needs_information', message };
}
