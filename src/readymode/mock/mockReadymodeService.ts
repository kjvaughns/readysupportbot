import { errorFor } from '../../domain/errors.js';
import { generateTemporaryPassword } from '../../util/password.js';
import { normalizeForComparison } from '../../util/text.js';
import { nowIso } from '../../util/time.js';
import { requireUniqueMatch } from '../matching.js';
import type {
  AuthStatus,
  CreatedAccount,
  LicenseUsage,
  PasswordResetResult,
  ReadymodeAccount,
  ReadymodeService,
  StateChange,
  WorkflowContext,
  WorkflowResult,
} from '../port.js';
import type {
  CheckAgentStatusAction,
  CheckLicenseUsageAction,
  ClearLicenseAction,
  CreateAccountAction,
  DeactivateAccountAction,
  ResetPasswordAction,
} from '../../domain/actions.js';

/**
 * An in-memory Readymode.
 *
 * This exists so the whole pipeline — permissions, approvals, the queue, the
 * audit trail, the Discord experience — can be exercised without a browser,
 * without credentials, and without touching a real agent account. It is
 * selected with READYMODE_DRIVER=mock and is the driver the automated tests
 * use.
 *
 * It deliberately models the awkward cases the live driver has to handle:
 * duplicate names, an agent on a call, an account that is already inactive.
 * It does not model Readymode's actual interface, and no selector, route or
 * success message here is a claim about the real product.
 */

const DEFAULT_ACCOUNTS: ReadymodeAccount[] = [
  {
    readymodeUserId: '1001',
    username: 'jbrown',
    email: 'john.brown@example.com',
    fullName: 'John Brown',
    agentRole: 'Agent',
    licenseType: 'Standard',
    team: 'Team A',
    campaign: 'Vantage',
    queue: 'Inbound',
    active: true,
    licenseInUse: true,
    loggedIn: true,
    onCall: false,
    statusText: 'Available',
  },
  {
    readymodeUserId: '1002',
    username: 'sgarcia',
    email: 'sarah.garcia@example.com',
    fullName: 'Sarah Garcia',
    agentRole: 'Agent',
    licenseType: 'Standard',
    team: 'Team A',
    campaign: 'Vantage',
    queue: 'Outbound',
    active: true,
    licenseInUse: true,
    loggedIn: true,
    onCall: true,
    statusText: 'On call',
  },
  {
    readymodeUserId: '1003',
    username: 'msmith',
    email: 'marcus.smith@example.com',
    fullName: 'Marcus Smith',
    agentRole: 'Agent',
    licenseType: 'Premium',
    team: 'Team B',
    campaign: 'Horizon',
    queue: 'Inbound',
    active: true,
    licenseInUse: false,
    loggedIn: false,
    onCall: false,
    statusText: 'Offline',
  },
  // Two people with the same name, so the ambiguity path is reachable without
  // any setup.
  {
    readymodeUserId: '1004',
    username: 'msmith2',
    email: 'marcus.smith2@example.com',
    fullName: 'Marcus Smith',
    agentRole: 'Supervisor',
    licenseType: 'Premium',
    team: 'Team C',
    campaign: 'Horizon',
    queue: 'Escalations',
    active: true,
    licenseInUse: true,
    loggedIn: true,
    onCall: false,
    statusText: 'Available',
  },
  {
    readymodeUserId: '1005',
    username: 'dlee',
    email: 'dana.lee@example.com',
    fullName: 'Dana Lee',
    agentRole: 'Agent',
    licenseType: 'Standard',
    team: 'Team B',
    campaign: 'Vantage',
    queue: 'Inbound',
    active: false,
    licenseInUse: false,
    loggedIn: false,
    onCall: false,
    statusText: 'Deactivated',
  },
];

export const MOCK_VOCABULARY = {
  roles: ['Agent', 'Supervisor', 'Manager'],
  licenseTypes: ['Standard', 'Premium'],
  teams: ['Team A', 'Team B', 'Team C'],
  campaigns: ['Vantage', 'Horizon'],
  queues: ['Inbound', 'Outbound', 'Escalations'],
};

export interface MockOptions {
  accounts?: ReadymodeAccount[];
  /** Start out signed out, to exercise the reconnect path. */
  authState?: AuthStatus['state'];
  /** Make every workflow throw, to exercise failure handling. */
  failWith?: Parameters<typeof errorFor>[0];
}

export class MockReadymodeService implements ReadymodeService {
  readonly name = 'mock' as const;

  private accounts: ReadymodeAccount[];
  private authState: AuthStatus['state'];
  private readonly failWith: MockOptions['failWith'];

  constructor(options: MockOptions = {}) {
    this.accounts = (options.accounts ?? DEFAULT_ACCOUNTS).map((account) => ({ ...account }));
    this.authState = options.authState ?? 'AUTHENTICATED';
    this.failWith = options.failWith;
  }

  /** Test helper: replace the directory. */
  setAccounts(accounts: ReadymodeAccount[]): void {
    this.accounts = accounts.map((account) => ({ ...account }));
  }

  /** Test helper: read the directory without going through a workflow. */
  listAccounts(): ReadymodeAccount[] {
    return this.accounts.map((account) => ({ ...account }));
  }

  setAuthState(state: AuthStatus['state']): void {
    this.authState = state;
  }

  private guard(): void {
    if (this.failWith) throw errorFor(this.failWith);
    if (this.authState !== 'AUTHENTICATED') {
      throw errorFor(this.authState === 'VERIFICATION_REQUIRED' ? 'VERIFICATION_REQUIRED' : 'AUTH_EXPIRED');
    }
  }

  private find(index: number): ReadymodeAccount {
    const account = this.accounts[index];
    if (!account) throw new Error('mock account index out of range');
    return account;
  }

  private indexOfMatch(ref: Parameters<typeof requireUniqueMatch>[0], describe: string): number {
    const { account } = requireUniqueMatch(ref, this.accounts, describe);
    const index = this.accounts.findIndex((candidate) => candidate === account);
    if (index < 0) throw new Error('matched account is not in the directory');
    return index;
  }

  private result<T>(data: T, context: WorkflowContext, extra: Partial<WorkflowResult<T>> = {}): WorkflowResult<T> {
    return {
      data,
      verified: !context.dryRun,
      dryRun: context.dryRun,
      evidence: { finalUrl: 'mock://readymode/agents' },
      ...extra,
    };
  }

  async checkAuthentication(): Promise<AuthStatus> {
    return { state: this.authState, checkedAt: nowIso(), reusedSession: true };
  }

  async reconnect(): Promise<AuthStatus> {
    if (this.authState === 'VERIFICATION_REQUIRED') {
      return {
        state: 'VERIFICATION_REQUIRED',
        detail: 'The mock Readymode is configured to require manual verification.',
        checkedAt: nowIso(),
      };
    }
    this.authState = 'AUTHENTICATED';
    return { state: 'AUTHENTICATED', checkedAt: nowIso(), reusedSession: false };
  }

  async createAccount(
    action: CreateAccountAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<CreatedAccount>> {
    this.guard();

    const emailTaken = this.accounts.some(
      (account) => account.email && normalizeForComparison(account.email) === normalizeForComparison(action.email),
    );
    if (emailTaken) {
      throw errorFor('PRECONDITION_FAILED', {
        message: `An account already uses the email ${action.email}, so I did not create a second one.`,
      });
    }

    const usernameTaken = this.accounts.some(
      (account) =>
        account.username && normalizeForComparison(account.username) === normalizeForComparison(action.username),
    );
    if (usernameTaken) {
      throw errorFor('PRECONDITION_FAILED', {
        message: `The username ${action.username} is already taken, so I did not create the account.`,
      });
    }

    const temporaryPassword = action.temporaryPassword ?? generateTemporaryPassword();
    const passwordSource: CreatedAccount['passwordSource'] = action.temporaryPassword
      ? 'provided'
      : 'generated';

    const account: ReadymodeAccount = {
      readymodeUserId: String(2000 + this.accounts.length),
      username: action.username,
      email: action.email,
      fullName: `${action.firstName} ${action.lastName}`,
      agentRole: action.agentRole,
      licenseType: action.licenseType,
      ...(action.team ? { team: action.team } : {}),
      ...(action.campaign ? { campaign: action.campaign } : {}),
      ...(action.queue ? { queue: action.queue } : {}),
      active: action.active ?? true,
      licenseInUse: false,
      loggedIn: false,
      onCall: false,
      statusText: 'Offline',
    };

    if (context.dryRun) {
      return this.result({ account, temporaryPassword, passwordSource }, context, {
        notes: ['Dry run: everything validated, but no account was created.'],
      });
    }

    this.accounts.push(account);
    return this.result({ account, temporaryPassword, passwordSource }, context);
  }

  async clearLicense(
    action: ClearLicenseAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<StateChange>> {
    this.guard();

    const index = this.indexOfMatch(action.target, describeRef(action.target));
    const before = { ...this.find(index) };

    if (!before.licenseInUse) {
      throw errorFor('PRECONDITION_FAILED', {
        message: `${before.fullName ?? before.username ?? 'That agent'} is not holding a license right now, so there was nothing to clear.`,
      });
    }

    if (before.onCall && !action.overrideActiveCall) {
      throw errorFor('PRECONDITION_FAILED', {
        message: `${before.fullName ?? before.username ?? 'That agent'} is on a call right now. Clearing the license will drop it. An admin has to confirm before I continue.`,
        details: { requiresAdminOverride: true, onCall: true },
      });
    }

    if (context.dryRun) {
      return this.result({ before, after: before }, context, {
        notes: ['Dry run: the license was not cleared.'],
      });
    }

    const after: ReadymodeAccount = { ...before, licenseInUse: false, loggedIn: false, onCall: false, statusText: 'Offline' };
    this.accounts[index] = after;
    return this.result({ before, after }, context);
  }

  async resetPassword(
    action: ResetPasswordAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<PasswordResetResult>> {
    this.guard();

    const index = this.indexOfMatch(action.target, describeRef(action.target));
    const account = { ...this.find(index) };

    const temporaryPassword = action.temporaryPassword ?? generateTemporaryPassword();
    const passwordSource: PasswordResetResult['passwordSource'] = action.temporaryPassword
      ? 'provided'
      : 'generated';

    if (context.dryRun) {
      return this.result({ account, temporaryPassword, passwordSource }, context, {
        notes: ['Dry run: the password was not changed.'],
      });
    }

    // The mock holds no password state — nothing here stores one, by design.
    return this.result({ account, temporaryPassword, passwordSource }, context);
  }

  async deactivateAccount(
    action: DeactivateAccountAction,
    context: WorkflowContext,
  ): Promise<WorkflowResult<StateChange>> {
    this.guard();

    const index = this.indexOfMatch(action.target, describeRef(action.target));
    const before = { ...this.find(index) };

    if (before.active === false) {
      throw errorFor('PRECONDITION_FAILED', {
        message: `${before.fullName ?? before.username ?? 'That account'} is already deactivated.`,
      });
    }

    if (context.dryRun) {
      return this.result({ before, after: before }, context, {
        notes: ['Dry run: the account was not deactivated.'],
      });
    }

    const after: ReadymodeAccount = {
      ...before,
      active: false,
      licenseInUse: false,
      loggedIn: false,
      onCall: false,
      statusText: 'Deactivated',
    };
    this.accounts[index] = after;
    return this.result({ before, after }, context);
  }

  async checkLicenseUsage(
    action: CheckLicenseUsageAction,
    _context: WorkflowContext,
  ): Promise<WorkflowResult<LicenseUsage>> {
    this.guard();

    const holders = this.accounts.filter(
      (account) =>
        account.licenseInUse &&
        (!action.licenseType ||
          normalizeForComparison(account.licenseType ?? '') === normalizeForComparison(action.licenseType)),
    );

    return {
      data: {
        holders: holders.map((account) => ({ ...account })),
        totalInUse: holders.length,
        totalAvailable: this.accounts.length,
      },
      verified: true,
      dryRun: false,
      evidence: { finalUrl: 'mock://readymode/licenses' },
    };
  }

  async checkAgentStatus(
    action: CheckAgentStatusAction,
    _context: WorkflowContext,
  ): Promise<WorkflowResult<ReadymodeAccount>> {
    this.guard();

    const index = this.indexOfMatch(action.target, describeRef(action.target));
    return {
      data: { ...this.find(index) },
      verified: true,
      dryRun: false,
      evidence: { finalUrl: 'mock://readymode/agents' },
    };
  }

  async shutdown(): Promise<void> {
    // Nothing to release.
  }
}

function describeRef(ref: { readymodeUserId?: string; username?: string; email?: string; fullName?: string }): string {
  return ref.readymodeUserId ?? ref.username ?? ref.email ?? ref.fullName ?? 'that account';
}
