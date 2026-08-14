import { z } from 'zod';
import { hasControlChars } from '../util/text.js';

/**
 * The complete set of structured actions ReadySupport can perform.
 *
 * Free-form user text is never executed. Both slash commands and natural
 * language are converted into one of these before anything else happens, and
 * the browser layer only ever receives a value that parsed cleanly here.
 */
export const ACTION_TYPES = [
  'CREATE_ACCOUNT',
  'CLEAR_LICENSE',
  'RESET_PASSWORD',
  'DEACTIVATE_ACCOUNT',
  'CHECK_LICENSE_USAGE',
  'CHECK_AGENT_STATUS',
  'LIST_RECENT_ACTIONS',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
export const actionTypeSchema = z.enum(ACTION_TYPES);

/** Actions that change state in Readymode. These always need confirmation. */
export const MUTATING_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'CREATE_ACCOUNT',
  'CLEAR_LICENSE',
  'RESET_PASSWORD',
  'DEACTIVATE_ACCOUNT',
]);

/** Actions that only read. No confirmation step. */
export function isMutating(action: ActionType): boolean {
  return MUTATING_ACTIONS.has(action);
}

/** Actions that need a second, different OWNER/ADMIN to sign off. */
export const SECOND_APPROVER_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'DEACTIVATE_ACCOUNT',
]);

/** Actions that never touch a browser — answered straight from the audit log. */
export const LOCAL_ONLY_ACTIONS: ReadonlySet<ActionType> = new Set<ActionType>([
  'LIST_RECENT_ACTIONS',
]);

// ---------------------------------------------------------------------------
// Field primitives
// ---------------------------------------------------------------------------

const plainText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .refine((value) => !hasControlChars(value), `${label} contains invalid characters`);

const personName = (label: string) =>
  plainText(label, 60).refine(
    (value) => /^[\p{L}\p{M}'’\-. ]+$/u.test(value),
    `${label} may only contain letters, spaces, apostrophes, hyphens and periods`,
  );

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must be 254 characters or fewer')
  .email('That does not look like a valid email address');

const usernameField = z
  .string()
  .trim()
  .min(2, 'Username must be at least 2 characters')
  .max(64, 'Username must be 64 characters or fewer')
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'Username may only contain letters, numbers, periods, underscores and hyphens',
  );

/**
 * Readymode's own vocabulary for roles, license types, teams, campaigns and
 * queues is instance specific and is NOT hard-coded here — inventing an enum
 * would mean guessing at the product. These are shape-validated only; the
 * value is additionally checked against the options Readymode actually offers
 * before submission (see readymode/vocabulary.ts).
 */
const vocabularyValue = (label: string) => plainText(label, 80);

/**
 * How a target account is identified. At least one identifier is required, and
 * a bare first name is never enough — full name must carry two parts.
 */
export const accountRefSchema = z
  .object({
    readymodeUserId: plainText('Readymode user ID', 64).optional(),
    username: usernameField.optional(),
    email: emailField.optional(),
    fullName: plainText('Full name', 120)
      .refine(
        (value) => value.split(/\s+/).filter(Boolean).length >= 2,
        'Give both a first and last name — a first name alone is not specific enough to act on',
      )
      .optional(),
  })
  .refine(
    (value) =>
      Boolean(value.readymodeUserId ?? value.username ?? value.email ?? value.fullName),
    {
      message:
        'Identify the account by Readymode user ID, username, email, or full first and last name',
    },
  );

export type AccountRef = z.infer<typeof accountRefSchema>;

// ---------------------------------------------------------------------------
// Per-action payloads
// ---------------------------------------------------------------------------

export const createAccountSchema = z.object({
  action: z.literal('CREATE_ACCOUNT'),
  firstName: personName('First name'),
  lastName: personName('Last name'),
  email: emailField,
  username: usernameField,
  agentRole: vocabularyValue('Agent role'),
  licenseType: vocabularyValue('License type'),
  // Optional on the first pass. Readymode may require some of these; when it
  // does, the bot returns a Discord form asking for exactly what is missing.
  team: vocabularyValue('Team').optional(),
  campaign: vocabularyValue('Campaign').optional(),
  queue: vocabularyValue('Queue').optional(),
  active: z.boolean().optional().default(true),
  /**
   * Present only when an approved administrator supplied one explicitly.
   * Otherwise a secure password is generated at execution time and never
   * travels through the request payload or the audit log.
   */
  temporaryPassword: z.string().min(12).max(128).optional(),
});

export const clearLicenseSchema = z.object({
  action: z.literal('CLEAR_LICENSE'),
  target: accountRefSchema,
  /** Set by an ADMIN acknowledging that the agent is mid-call. */
  overrideActiveCall: z.boolean().optional().default(false),
});

export const resetPasswordSchema = z.object({
  action: z.literal('RESET_PASSWORD'),
  target: accountRefSchema,
  temporaryPassword: z.string().min(12).max(128).optional(),
});

export const deactivateAccountSchema = z.object({
  action: z.literal('DEACTIVATE_ACCOUNT'),
  target: accountRefSchema,
  reason: plainText('Reason', 300).optional(),
});

export const checkLicenseUsageSchema = z.object({
  action: z.literal('CHECK_LICENSE_USAGE'),
  licenseType: vocabularyValue('License type').optional(),
});

export const checkAgentStatusSchema = z.object({
  action: z.literal('CHECK_AGENT_STATUS'),
  target: accountRefSchema,
});

export const listRecentActionsSchema = z.object({
  action: z.literal('LIST_RECENT_ACTIONS'),
  limit: z.coerce.number().int().min(1).max(25).optional().default(10),
  status: z.enum(['ALL', 'COMPLETED', 'FAILED']).optional().default('ALL'),
});

/** The one schema every request must satisfy before it can be queued. */
export const structuredActionSchema = z.discriminatedUnion('action', [
  createAccountSchema,
  clearLicenseSchema,
  resetPasswordSchema,
  deactivateAccountSchema,
  checkLicenseUsageSchema,
  checkAgentStatusSchema,
  listRecentActionsSchema,
]);

export type StructuredAction = z.infer<typeof structuredActionSchema>;
export type CreateAccountAction = z.infer<typeof createAccountSchema>;
export type ClearLicenseAction = z.infer<typeof clearLicenseSchema>;
export type ResetPasswordAction = z.infer<typeof resetPasswordSchema>;
export type DeactivateAccountAction = z.infer<typeof deactivateAccountSchema>;
export type CheckLicenseUsageAction = z.infer<typeof checkLicenseUsageSchema>;
export type CheckAgentStatusAction = z.infer<typeof checkAgentStatusSchema>;
export type ListRecentActionsAction = z.infer<typeof listRecentActionsSchema>;

/** Human wording used in embeds and error messages. */
export const ACTION_LABELS: Record<ActionType, string> = {
  CREATE_ACCOUNT: 'Create account',
  CLEAR_LICENSE: 'Clear license',
  RESET_PASSWORD: 'Reset password',
  DEACTIVATE_ACCOUNT: 'Deactivate account',
  CHECK_LICENSE_USAGE: 'Check license usage',
  CHECK_AGENT_STATUS: 'Check agent status',
  LIST_RECENT_ACTIONS: 'List recent actions',
};

/** A one-line description of the account an action targets, for embeds. */
export function describeTarget(action: StructuredAction): string {
  switch (action.action) {
    case 'CREATE_ACCOUNT':
      return `${action.firstName} ${action.lastName} (${action.username})`;
    case 'CLEAR_LICENSE':
    case 'RESET_PASSWORD':
    case 'DEACTIVATE_ACCOUNT':
    case 'CHECK_AGENT_STATUS':
      return describeAccountRef(action.target);
    case 'CHECK_LICENSE_USAGE':
      return action.licenseType ? `All ${action.licenseType} licenses` : 'All licenses';
    case 'LIST_RECENT_ACTIONS':
      return 'Audit history';
  }
}

export function describeAccountRef(ref: AccountRef): string {
  if (ref.readymodeUserId) return `Readymode ID ${ref.readymodeUserId}`;
  if (ref.username) return ref.username;
  if (ref.email) return ref.email;
  return ref.fullName ?? 'unknown account';
}
