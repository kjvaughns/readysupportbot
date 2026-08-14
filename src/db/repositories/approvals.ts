import { db, unwrap, unwrapMaybe } from '../client.js';
import type { BotRole } from '../../domain/roles.js';
import type { ApprovalDecision, AutomationApprovalRow } from '../types.js';

const TABLE = 'automation_approvals';

export interface CreateApprovalInput {
  requestId: string;
  nonce: string;
  requiredRole: BotRole;
  requiresIndependent: boolean;
  expiresAt: string;
}

export async function create(input: CreateApprovalInput): Promise<AutomationApprovalRow> {
  const rows = unwrap<AutomationApprovalRow[]>(
    await db()
      .from(TABLE)
      .insert({
        request_id: input.requestId,
        nonce: input.nonce,
        required_role: input.requiredRole,
        requires_independent: input.requiresIndependent,
        expires_at: input.expiresAt,
      })
      .select('*'),
    'approvals.create',
  );

  const row = rows[0];
  if (!row) throw new Error('automation_approvals insert returned no row');
  return row;
}

export async function findPendingForRequest(requestId: string): Promise<AutomationApprovalRow | null> {
  return unwrapMaybe<AutomationApprovalRow>(
    await db().from(TABLE).select('*').eq('request_id', requestId).eq('decision', 'PENDING').maybeSingle(),
    'approvals.findPendingForRequest',
  );
}

export async function listForRequest(requestId: string): Promise<AutomationApprovalRow[]> {
  return unwrap<AutomationApprovalRow[]>(
    await db().from(TABLE).select('*').eq('request_id', requestId).order('created_at'),
    'approvals.listForRequest',
  );
}

export interface DecideInput {
  approvalId: string;
  decision: Exclude<ApprovalDecision, 'PENDING'>;
  decidedByDiscordId: string;
  decidedByRole: BotRole;
  note?: string | null;
}

/**
 * Record a decision.
 *
 * The update is conditional on the row still being PENDING, so a double-click
 * or a replayed interaction resolves exactly once. A null return means someone
 * or something already decided it.
 */
export async function decide(input: DecideInput): Promise<AutomationApprovalRow | null> {
  const rows = unwrap<AutomationApprovalRow[]>(
    await db()
      .from(TABLE)
      .update({
        decision: input.decision,
        decided_by_discord_id: input.decidedByDiscordId,
        decided_by_role: input.decidedByRole,
        decided_at: new Date().toISOString(),
        decision_note: input.note ?? null,
      })
      .eq('id', input.approvalId)
      .eq('decision', 'PENDING')
      .select('*'),
    'approvals.decide',
  );

  return rows[0] ?? null;
}
