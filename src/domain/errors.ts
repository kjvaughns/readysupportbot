import { z } from 'zod';

/**
 * Error categories.
 *
 * Every failure is classified before it reaches Discord or the audit log. The
 * category drives three things: the sentence the requester sees, whether the
 * OWNER is alerted, and whether the job is ever safe to retry.
 */
export const ERROR_CATEGORIES = [
  /** Readymode is not signed in, or the session expired mid-job. */
  'AUTH_EXPIRED',
  /** Readymode presented a CAPTCHA, MFA prompt or other verification step. */
  'VERIFICATION_REQUIRED',
  /** A selector this workflow needs has not been discovered yet. */
  'SELECTOR_NOT_CONFIGURED',
  /** The page did not look like what the workflow expected. */
  'INTERFACE_CHANGED',
  /** Search returned nothing. */
  'NO_MATCH',
  /** Search returned more than one candidate. */
  'AMBIGUOUS_MATCH',
  /** The action ran but the follow-up read did not confirm the change. */
  'VERIFICATION_FAILED',
  /** A precondition failed, e.g. the email is already taken. */
  'PRECONDITION_FAILED',
  /** The requester may not do this. */
  'PERMISSION_DENIED',
  /** Too many requests from this user. */
  'RATE_LIMITED',
  /** Approval window elapsed. */
  'APPROVAL_EXPIRED',
  /** Input did not satisfy the action schema. */
  'VALIDATION_FAILED',
  /** The step exceeded its time budget. */
  'TIMEOUT',
  /** Browserbase, Supabase or OpenAI was unreachable. */
  'UPSTREAM_UNAVAILABLE',
  /** The action is switched off by configuration. */
  'ACTION_DISABLED',
  /** Anything not otherwise classified. */
  'UNKNOWN',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export const errorCategorySchema = z.enum(ERROR_CATEGORIES);

/**
 * Categories where the job may have partially changed Readymode. These are
 * never retried automatically — a human confirms the current state first.
 */
export const UNSAFE_TO_RETRY: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'VERIFICATION_FAILED',
  'TIMEOUT',
  'INTERFACE_CHANGED',
  'UNKNOWN',
]);

export function isSafeToRetry(category: ErrorCategory): boolean {
  return !UNSAFE_TO_RETRY.has(category);
}

/** Categories that wake the OWNER up. */
export const OWNER_ALERT_CATEGORIES: ReadonlySet<ErrorCategory> = new Set<ErrorCategory>([
  'AUTH_EXPIRED',
  'VERIFICATION_REQUIRED',
  'SELECTOR_NOT_CONFIGURED',
  'INTERFACE_CHANGED',
  'UPSTREAM_UNAVAILABLE',
]);

/**
 * A failure with a category, a sentence safe to show a requester, and optional
 * structured detail for the audit log.
 *
 * `userMessage` never contains stack traces, internal hostnames, selector
 * strings or credentials — those live in `details`, which is sanitized before
 * it is written and is never sent to Discord verbatim.
 */
export class ReadySupportError extends Error {
  readonly category: ErrorCategory;
  readonly userMessage: string;
  readonly details: Record<string, unknown>;

  constructor(
    category: ErrorCategory,
    userMessage: string,
    options: { cause?: unknown; details?: Record<string, unknown> } = {},
  ) {
    super(`${category}: ${userMessage}`);
    this.name = 'ReadySupportError';
    this.category = category;
    this.userMessage = userMessage;
    this.details = options.details ?? {};
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Default wording when a category surfaces without a tailored sentence. */
const DEFAULT_MESSAGES: Record<ErrorCategory, string> = {
  AUTH_EXPIRED:
    'ReadySupport has lost access to Readymode. No queued changes will run until an administrator reconnects the account.',
  VERIFICATION_REQUIRED:
    'Readymode asked for an extra verification step that I am not permitted to complete. An administrator needs to sign in manually.',
  SELECTOR_NOT_CONFIGURED:
    'This action is not ready yet: part of the Readymode interface it needs has not been mapped. An administrator has to run the discovery step first.',
  INTERFACE_CHANGED:
    'The Readymode page did not look the way I expected, so I stopped without changing anything.',
  NO_MATCH: 'I could not find an account matching that.',
  AMBIGUOUS_MATCH: 'More than one account matched, so I stopped rather than guess.',
  VERIFICATION_FAILED:
    'I could not confirm the change actually took effect, so I stopped. Please check Readymode before trying again.',
  PRECONDITION_FAILED: 'A check failed before I made any changes.',
  PERMISSION_DENIED: 'You do not have permission to do that.',
  RATE_LIMITED: 'That is a lot of requests in a short time. Please wait a moment and try again.',
  APPROVAL_EXPIRED: 'That confirmation expired. Please submit the request again.',
  VALIDATION_FAILED: 'Some of the details were missing or invalid.',
  TIMEOUT: 'Readymode took too long to respond, so I stopped.',
  UPSTREAM_UNAVAILABLE: 'A service ReadySupport depends on is unavailable right now.',
  ACTION_DISABLED: 'That action is currently switched off.',
  UNKNOWN: 'Something went wrong and I stopped without completing the request.',
};

export function defaultMessageFor(category: ErrorCategory): string {
  return DEFAULT_MESSAGES[category];
}

export function errorFor(
  category: ErrorCategory,
  options: { cause?: unknown; details?: Record<string, unknown>; message?: string } = {},
): ReadySupportError {
  return new ReadySupportError(category, options.message ?? DEFAULT_MESSAGES[category], {
    cause: options.cause,
    details: options.details,
  });
}

/**
 * Classify an arbitrary thrown value. Anything that is already a
 * ReadySupportError keeps its category; everything else is inspected for
 * well-known signals and otherwise becomes UNKNOWN.
 */
export function toReadySupportError(error: unknown): ReadySupportError {
  if (error instanceof ReadySupportError) return error;

  const message = error instanceof Error ? error.message : String(error);

  if (/timeout|timed out/i.test(message)) {
    return errorFor('TIMEOUT', { cause: error });
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed/i.test(message)) {
    return errorFor('UPSTREAM_UNAVAILABLE', { cause: error });
  }

  return errorFor('UNKNOWN', { cause: error });
}
