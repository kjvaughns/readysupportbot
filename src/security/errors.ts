import { redactString } from './redaction';

/**
 * Errors carry a safe, user-facing message plus optional internal detail. Only
 * the safe message is ever returned to Discord or the frontend.
 */
export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly safeMessage: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: string,
    safeMessage: string,
    statusCode = 400,
    details?: Record<string, unknown>,
  ) {
    super(safeMessage);
    this.name = 'AppError';
    this.code = code;
    this.safeMessage = safeMessage;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation_error', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends AppError {
  constructor(message = 'Authentication is required.') {
    super('unauthenticated', message, 401);
    this.name = 'AuthenticationError';
  }
}

export class PermissionError extends AppError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('forbidden', message, 403, undefined);
    this.name = 'PermissionError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'The requested resource was not found.') {
    super('not_found', message, 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('conflict', message, 409, details);
    this.name = 'ConflictError';
  }
}

export class DependencyNotConfiguredError extends AppError {
  constructor(dependency: string) {
    super(
      'dependency_not_configured',
      `${dependency} is not configured yet. Finish setup in the ReadySupport dashboard.`,
      503,
      { dependency },
    );
    this.name = 'DependencyNotConfiguredError';
  }
}

export class AuthenticationRequiredError extends AppError {
  constructor(message = 'Readymode requires human verification before this can continue.') {
    super('readymode_authentication_required', message, 409);
    this.name = 'AuthenticationRequiredError';
  }
}

export class WorkflowNeedsConfigurationError extends AppError {
  constructor(what: string) {
    super(
      'workflow_needs_configuration',
      `ReadySupport could not identify the ${what} control in Readymode. This workflow needs configuration before it can run.`,
      503,
      { control: what },
    );
    this.name = 'WorkflowNeedsConfigurationError';
  }
}

/**
 * Raised before any browser work when the controls a change needs have not been
 * observed in the real Readymode interface. ReadySupport refuses and explains
 * rather than driving a page it has only guessed at.
 */
export class ControlsUnverifiedError extends AppError {
  constructor(capability: string, missing: string[]) {
    super(
      'readymode_controls_unverified',
      `ReadySupport has not verified the Readymode controls needed to ${capability}, so nothing was changed. ` +
        `Not yet verified: ${missing.join(', ')}. An Owner can run interface discovery ` +
        `(POST /api/readymode/discover) and approve the resulting profile.`,
      503,
      { capability, missing },
    );
    this.name = 'ControlsUnverifiedError';
  }
}

export class AmbiguousAgentError extends AppError {
  constructor(
    readonly candidates: Array<{ readymodeUserId: string; username: string; fullName?: string | null }>,
  ) {
    super(
      'ambiguous_agent',
      'More than one Readymode account matches that description. Select the correct account.',
      409,
      { candidates },
    );
    this.name = 'AmbiguousAgentError';
  }
}

/** Converts any thrown value into a message that is safe to show a user. */
export function toSafeMessage(error: unknown): string {
  if (error instanceof AppError) return redactString(error.safeMessage);
  if (error instanceof Error) {
    // Internal error text can contain URLs, tokens or stack fragments.
    return 'Something went wrong while handling that request. The details were recorded in the activity log.';
  }
  return 'Something went wrong while handling that request.';
}

export function statusCodeFor(error: unknown): number {
  return error instanceof AppError ? error.statusCode : 500;
}
