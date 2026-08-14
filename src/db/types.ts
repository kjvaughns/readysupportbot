import type { ActionType } from '../domain/actions.js';
import type { ErrorCategory } from '../domain/errors.js';
import type { BotRole } from '../domain/roles.js';
import type { RequestStatus } from '../domain/status.js';

/**
 * Row shapes for the tables in supabase/migrations.
 *
 * Hand-written rather than generated so the repository layer compiles without
 * a live database. Regenerate-and-compare instructions are in
 * supabase/README.md; the enums here are the same unions the domain uses, so a
 * schema change that drops a value fails typecheck.
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };
export type JsonObject = Record<string, unknown>;

export type RequestSource = 'SLASH_COMMAND' | 'NATURAL_LANGUAGE' | 'SYSTEM';
export type ApprovalDecision = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED';
export type ChannelPurpose = 'COMMANDS' | 'NATURAL_LANGUAGE' | 'ALERTS';
export type BrowserSessionStatus = 'ACTIVE' | 'CLOSED' | 'FAILED';
export type ReadymodeAuthState = 'AUTHENTICATED' | 'EXPIRED' | 'VERIFICATION_REQUIRED' | 'UNKNOWN';

export type AuditEventType =
  | 'REQUEST_CREATED'
  | 'INFORMATION_REQUESTED'
  | 'INFORMATION_PROVIDED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_DENIED'
  | 'APPROVAL_EXPIRED'
  | 'QUEUED'
  | 'EXECUTION_STARTED'
  | 'EXECUTION_VERIFIED'
  | 'EXECUTION_COMPLETED'
  | 'EXECUTION_FAILED'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_RESTORED'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'CANCELLED'
  | 'CREDENTIALS_DELIVERED'
  | 'SYSTEM_ALERT';

export interface BotUserRow {
  id: string;
  discord_user_id: string;
  discord_username: string | null;
  role: BotRole;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ApprovedGuildRow {
  guild_id: string;
  name: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ApprovedChannelRow {
  id: string;
  guild_id: string;
  channel_id: string;
  purpose: ChannelPurpose;
  active: boolean;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface ReadymodeAccountRow {
  id: string;
  readymode_user_id: string | null;
  username: string | null;
  email: string | null;
  full_name: string | null;
  agent_role: string | null;
  license_type: string | null;
  team: string | null;
  campaign: string | null;
  queue: string | null;
  active: boolean | null;
  license_in_use: boolean | null;
  snapshot: JsonObject;
  first_seen_at: string;
  last_seen_at: string;
  updated_at: string;
}

export interface AutomationRequestRow {
  id: string;
  reference: number;
  status: RequestStatus;
  action: ActionType;
  source: RequestSource;
  guild_id: string;
  channel_id: string;
  interaction_message_id: string | null;
  requester_discord_id: string;
  requester_bot_user_id: string | null;
  requester_role: BotRole;
  approver_discord_id: string | null;
  approver_bot_user_id: string | null;
  approver_role: BotRole | null;
  target_summary: string | null;
  target_ref: JsonObject;
  target_account_id: string | null;
  input: JsonObject;
  missing_fields: string[];
  request_text: string | null;
  result: JsonObject | null;
  error_category: ErrorCategory | null;
  error_message: string | null;
  screenshot_path: string | null;
  retry_count: number;
  dry_run: boolean;
  requested_at: string;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  approval_expires_at: string | null;
  updated_at: string;
}

export interface AutomationApprovalRow {
  id: string;
  request_id: string;
  nonce: string;
  required_role: BotRole;
  requires_independent: boolean;
  decision: ApprovalDecision;
  decided_by_discord_id: string | null;
  decided_by_role: BotRole | null;
  decided_at: string | null;
  decision_note: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface AutomationEventRow {
  id: string;
  request_id: string | null;
  reference: number | null;
  event_type: AuditEventType;
  discord_user_id: string | null;
  user_role: BotRole | null;
  action: ActionType | null;
  target: string | null;
  requested_at: string | null;
  approved_at: string | null;
  executed_at: string | null;
  status: RequestStatus | null;
  previous_state: JsonObject | null;
  new_state: JsonObject | null;
  error_category: ErrorCategory | null;
  error_message: string | null;
  screenshot_path: string | null;
  metadata: JsonObject;
  occurred_at: string;
}

export interface BrowserSessionRow {
  id: string;
  browserbase_session_id: string | null;
  context_id: string;
  status: BrowserSessionStatus;
  auth_state: ReadymodeAuthState;
  request_id: string | null;
  performed_login: boolean;
  verification_detected: boolean;
  started_at: string;
  last_checked_at: string | null;
  ended_at: string | null;
  error_category: ErrorCategory | null;
  error_message: string | null;
  metadata: JsonObject;
}

export interface SystemSettingRow {
  key: string;
  value: JsonObject;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

/** Well-known system_settings keys and the shape each one holds. */
export interface SystemSettings {
  readymode_auth_state: { state: ReadymodeAuthState; checkedAt: string | null; detail: string | null };
  queue_paused: {
    paused: boolean;
    reason: string | null;
    pausedBy: string | null;
    pausedAt: string | null;
  };
  consecutive_failures: { count: number; lastCategory: ErrorCategory | null; lastAt: string | null };
  last_successful_automation: { at: string | null; action: ActionType | null; reference: number | null };
  alert_dedupe: Record<string, string>;
  readymode_vocabulary: {
    roles: string[];
    licenseTypes: string[];
    teams: string[];
    campaigns: string[];
    queues: string[];
    capturedAt: string | null;
  };
}

export type SystemSettingKey = keyof SystemSettings;
