import type {
  CheckAgentStatusAction,
  CheckLicenseUsageAction,
  ClearLicenseAction,
  CreateAccountAction,
  DeactivateAccountAction,
  ResetPasswordAction,
} from '../domain/actions.js';

/**
 * The boundary between "what ReadySupport wants done" and "how it is done in
 * Readymode".
 *
 * Two implementations satisfy this interface: the live Playwright driver and
 * an in-memory mock used for local development and tests. Everything above
 * this line — Discord, approvals, the queue, the audit trail — is written
 * against the interface, so the mock is a development convenience rather than
 * a stand-in that later has to be torn out.
 */

/** A Readymode account as this system understands it. */
export interface ReadymodeAccount {
  readymodeUserId?: string;
  username?: string;
  email?: string;
  fullName?: string;
  agentRole?: string;
  licenseType?: string;
  team?: string;
  campaign?: string;
  queue?: string;
  active?: boolean;
  licenseInUse?: boolean;
  /** Whether the agent is logged in right now, when the interface shows it. */
  loggedIn?: boolean;
  /** Whether the agent is on a call right now, when the interface shows it. */
  onCall?: boolean;
  /** Free-form status text as displayed, already sanitized. */
  statusText?: string;
}

/** Evidence captured during a workflow. */
export interface Evidence {
  /** Path inside the Supabase evidence bucket. Absent in mock and dry runs. */
  screenshotPath?: string;
  /** The page the workflow finished on, for the audit record. */
  finalUrl?: string;
}

export interface WorkflowContext {
  requestId: string;
  reference: number;
  /** True when the workflow must stop before submitting anything. */
  dryRun: boolean;
  /** Aborts the workflow when the job exceeds its time budget. */
  signal?: AbortSignal;
}

/** Shared shape of every workflow result. */
export interface WorkflowResult<T> {
  /** What the caller asked about, or what now exists. */
  data: T;
  /**
   * True when the workflow independently re-read Readymode and confirmed the
   * change. False for dry runs and read-only actions.
   */
  verified: boolean;
  /** True when the workflow stopped before submitting. */
  dryRun: boolean;
  evidence: Evidence;
  /** Anything worth showing the requester that is not part of `data`. */
  notes?: string[];
}

export interface CreatedAccount {
  account: ReadymodeAccount;
  /**
   * The temporary password, in memory only. It is delivered through an
   * ephemeral Discord reply and then dropped; it is never persisted, logged or
   * put in the audit trail.
   */
  temporaryPassword: string;
  /** Whether the password was generated or supplied by an administrator. */
  passwordSource: 'generated' | 'provided';
}

export interface LicenseUsage {
  /** Accounts currently holding a license. */
  holders: ReadymodeAccount[];
  /** Total in use, when Readymode reports a figure of its own. */
  totalInUse?: number;
  /** Total available, when the interface shows it. */
  totalAvailable?: number;
}

export interface PasswordResetResult {
  account: ReadymodeAccount;
  temporaryPassword: string;
  passwordSource: 'generated' | 'provided';
}

/** State before and after, so the audit trail records the actual change. */
export interface StateChange {
  before: ReadymodeAccount;
  after: ReadymodeAccount;
}

export interface AuthStatus {
  state: 'AUTHENTICATED' | 'EXPIRED' | 'VERIFICATION_REQUIRED' | 'UNKNOWN';
  /** Plain-language explanation, safe to show in Discord. */
  detail?: string;
  checkedAt: string;
  /** True when the stored browser context was reused rather than logging in. */
  reusedSession?: boolean;
}

/**
 * Every method may throw a ReadySupportError with a category. Nothing here
 * returns a partial success: if a workflow cannot verify what it did, it
 * throws rather than reporting a result it is not sure about.
 */
export interface ReadymodeService {
  /** Which driver this is, for the health view and the audit metadata. */
  readonly name: 'live' | 'mock';

  /** Probe the admin dashboard without performing an action. */
  checkAuthentication(): Promise<AuthStatus>;

  /**
   * Attempt to restore access using stored credentials. Stops and reports
   * VERIFICATION_REQUIRED if Readymode presents a CAPTCHA or MFA prompt —
   * those are never worked around.
   */
  reconnect(): Promise<AuthStatus>;

  createAccount(
    action: CreateAccountAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<CreatedAccount>>;

  clearLicense(
    action: ClearLicenseAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<StateChange>>;

  resetPassword(
    action: ResetPasswordAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<PasswordResetResult>>;

  deactivateAccount(
    action: DeactivateAccountAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<StateChange>>;

  checkLicenseUsage(
    action: CheckLicenseUsageAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<LicenseUsage>>;

  checkAgentStatus(
    action: CheckAgentStatusAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<ReadymodeAccount>>;

  /** Release browser resources. Safe to call more than once. */
  shutdown(): Promise<void>;
}
