import { z } from 'zod';

/** Roles an organization member can hold, ordered from most to least capable. */
export const ROLES = ['owner', 'administrator', 'support', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export const roleSchema = z.enum(ROLES);

/** Every capability the backend gates on. */
export const PERMISSIONS = [
  'create_accounts',
  'clear_licenses',
  'reset_passwords',
  'deactivate_accounts',
  'configure_states',
  'configure_campaigns',
  'configure_queues',
  'check_agent_status',
  'check_license_usage',
  'view_activity',
  'manage_connections',
  'manage_members',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Actions the natural-language layer is allowed to produce. */
export const ACTION_TYPES = [
  'CREATE_ACCOUNT',
  'CREATE_ACCOUNTS',
  'CLEAR_LICENSE',
  'RESET_PASSWORD',
  'DEACTIVATE_ACCOUNT',
  'AGENT_STATUS',
  'LICENSE_USAGE',
  'ASSIGN_CAMPAIGNS',
  'ASSIGN_QUEUES',
  'VIEW_STATES',
  'SET_STATES',
  'ADD_STATES',
  'REMOVE_STATES',
  'COPY_STATE_CONFIGURATION',
  'SET_DEFAULT_STATES',
  'RECENT_ACTIONS',
  'CONNECTION_STATUS',
  'HELP',
  'UNSUPPORTED',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Job lifecycle. */
export const REQUEST_STATUSES = [
  'PENDING',
  'NEEDS_INFORMATION',
  'AWAITING_APPROVAL',
  'APPROVED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'AUTHENTICATION_REQUIRED',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export interface OrganizationMember {
  id: string;
  organizationId: string;
  role: Role;
  discordUserId?: string | null;
  supabaseUserId?: string | null;
  displayName?: string | null;
}

export interface Organization {
  id: string;
  name: string;
  ownerUserId?: string | null;
}

export interface DiscordInstallation {
  id: string;
  organizationId: string;
  guildId: string;
  installed: boolean;
  notificationChannelId?: string | null;
  requireMention: boolean;
}

export interface DiscordChannelConfig {
  id: string;
  organizationId: string;
  guildId: string;
  channelId: string;
  autoSupport: boolean;
  approved: boolean;
}

export interface DiscordRoleMapping {
  id: string;
  organizationId: string;
  guildId: string;
  discordRoleId: string;
  role: Role;
}

export interface ReadymodeConnection {
  id: string;
  organizationId: string;
  loginUrl: string;
  username: string;
  status: 'connected' | 'disconnected' | 'authentication_required' | 'unverified';
  lastVerifiedAt?: string | null;
  lastError?: string | null;
}

export interface LinkedAgent {
  id: string;
  organizationId: string;
  discordUserId: string;
  readymodeUserId: string;
  username: string;
  fullName?: string | null;
  email?: string | null;
}

/** A Readymode agent as read back from the application. */
export interface ReadymodeAgent {
  readymodeUserId: string;
  username: string;
  fullName?: string | null;
  email?: string | null;
  active?: boolean;
  loggedIn?: boolean;
  licenseInUse?: boolean;
  states?: string[];
}

export interface AutomationRequest {
  id: string;
  reference: string;
  organizationId: string;
  status: RequestStatus;
  actionType: ActionType;
  payload: Record<string, unknown>;
  requestedByDiscordUserId?: string | null;
  requestedBySupabaseUserId?: string | null;
  channelId?: string | null;
  guildId?: string | null;
  messageId?: string | null;
  result?: Record<string, unknown> | null;
  error?: string | null;
  dedupeKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationApproval {
  id: string;
  requestId: string;
  organizationId: string;
  approverDiscordUserId?: string | null;
  approverSupabaseUserId?: string | null;
  approverRole: Role;
  sequence: number;
  createdAt: string;
}

export interface AutomationEvent {
  id: string;
  requestId?: string | null;
  organizationId: string;
  type: string;
  message: string;
  data?: Record<string, unknown> | null;
  createdAt: string;
}

/** Result contract shared by every Playwright workflow. */
export interface WorkflowResult {
  ok: boolean;
  verified: boolean;
  summary: string;
  details?: Record<string, unknown>;
  screenshotPath?: string | null;
  dryRun: boolean;
}

export interface RequestContext {
  organizationId: string;
  actorDiscordUserId?: string | null;
  actorSupabaseUserId?: string | null;
  role: Role;
  guildId?: string | null;
  channelId?: string | null;
}
