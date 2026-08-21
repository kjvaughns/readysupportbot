import {
  AutomationApproval,
  AutomationEvent,
  AutomationRequest,
  DiscordChannelConfig,
  DiscordInstallation,
  DiscordRoleMapping,
  LinkedAgent,
  Organization,
  OrganizationMember,
  ReadymodeConnection,
  RequestStatus,
  Role,
} from '../types';

export interface StoredCredentials {
  organizationId: string;
  /** Encrypted envelope. The plaintext never leaves the credential module. */
  encryptedPassword: string;
  username: string;
  loginUrl: string;
  updatedAt: string;
  updatedBy?: string | null;
}

export interface StateConfigurationRecord {
  id: string;
  organizationId: string;
  readymodeUserId: string;
  username?: string | null;
  states: string[];
  updatedAt: string;
  updatedBy?: string | null;
}

export interface CreateRequestInput {
  organizationId: string;
  actionType: AutomationRequest['actionType'];
  payload: Record<string, unknown>;
  status: RequestStatus;
  requestedByDiscordUserId?: string | null;
  requestedBySupabaseUserId?: string | null;
  guildId?: string | null;
  channelId?: string | null;
  messageId?: string | null;
  dedupeKey?: string | null;
}

export interface ListRequestsFilter {
  organizationId: string;
  limit?: number;
  statuses?: RequestStatus[];
}


export type InterfaceProfileStatus = 'proposed' | 'active' | 'superseded' | 'rejected';

export interface SelectorVersionRecord {
  id: string;
  profileId: string;
  organizationId: string;
  controlName: string;
  /** Serialized SelectorStrategy. Rehydrated and validated on read. */
  strategy: Record<string, unknown>;
  tier: string;
  confidence: number;
  rootName: string;
  rootUrl: string;
  evidenceRef: Record<string, unknown>;
  verified: boolean;
  verifiedMatches: number;
}

export interface InterfaceProfileRecord {
  id: string;
  organizationId: string;
  status: InterfaceProfileStatus;
  schemaVersion: number;
  baseUrl: string;
  interfaceVersion: 'starter' | 'iq' | 'unknown';
  pagesCaptured: number;
  controlsTotal: number;
  controlsProposed: number;
  capabilities: unknown[];
  unproposed: unknown[];
  screenshotPaths: string[];
  discoveredBy: string | null;
  discoveredAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  supersededBy: string | null;
  notes: string | null;
}

export interface InterfaceProfileWithSelectors extends InterfaceProfileRecord {
  selectors: SelectorVersionRecord[];
}

export interface CreateInterfaceProfileInput {
  profile: Omit<
    InterfaceProfileRecord,
    'id' | 'status' | 'approvedBy' | 'approvedAt' | 'supersededBy'
  >;
  selectors: Array<Omit<SelectorVersionRecord, 'id' | 'profileId'>>;
  /** Raw evidence. Stored apart so it is never readable from the frontend. */
  evidence: unknown;
}

/**
 * Everything the backend persists. Two implementations exist: Supabase for
 * real deployments, and an in-memory store used in tests and while the service
 * is running in setup mode without Supabase credentials.
 */
export interface DataStore {
  readonly kind: 'supabase' | 'memory';

  // Organizations and membership -------------------------------------------
  getOrganization(organizationId: string): Promise<Organization | null>;
  getOrganizationForGuild(guildId: string): Promise<Organization | null>;
  listOrganizationsForSupabaseUser(supabaseUserId: string): Promise<Organization[]>;
  getMemberByDiscordUser(
    organizationId: string,
    discordUserId: string,
  ): Promise<OrganizationMember | null>;
  getMemberBySupabaseUser(
    organizationId: string,
    supabaseUserId: string,
  ): Promise<OrganizationMember | null>;
  listMembers(organizationId: string): Promise<OrganizationMember[]>;
  upsertMember(member: Omit<OrganizationMember, 'id'> & { id?: string }): Promise<OrganizationMember>;

  // Discord configuration ---------------------------------------------------
  getInstallation(organizationId: string): Promise<DiscordInstallation | null>;
  getInstallationByGuild(guildId: string): Promise<DiscordInstallation | null>;
  upsertInstallation(
    installation: Omit<DiscordInstallation, 'id'> & { id?: string },
  ): Promise<DiscordInstallation>;
  listChannels(organizationId: string): Promise<DiscordChannelConfig[]>;
  upsertChannel(
    channel: Omit<DiscordChannelConfig, 'id'> & { id?: string },
  ): Promise<DiscordChannelConfig>;
  removeChannel(organizationId: string, channelId: string): Promise<void>;
  listRoleMappings(organizationId: string): Promise<DiscordRoleMapping[]>;
  upsertRoleMapping(
    mapping: Omit<DiscordRoleMapping, 'id'> & { id?: string },
  ): Promise<DiscordRoleMapping>;

  // Readymode connection ----------------------------------------------------
  getConnection(organizationId: string): Promise<ReadymodeConnection | null>;
  upsertConnection(
    connection: Omit<ReadymodeConnection, 'id'> & { id?: string },
  ): Promise<ReadymodeConnection>;
  deleteConnection(organizationId: string): Promise<void>;
  getCredentials(organizationId: string): Promise<StoredCredentials | null>;
  upsertCredentials(credentials: StoredCredentials): Promise<void>;
  deleteCredentials(organizationId: string): Promise<void>;

  // Linked agents -----------------------------------------------------------
  listLinkedAgentsForDiscordUser(
    organizationId: string,
    discordUserId: string,
  ): Promise<LinkedAgent[]>;
  upsertLinkedAgent(agent: Omit<LinkedAgent, 'id'> & { id?: string }): Promise<LinkedAgent>;

  // Automation requests -----------------------------------------------------
  createRequest(input: CreateRequestInput): Promise<AutomationRequest>;
  getRequest(requestId: string): Promise<AutomationRequest | null>;
  getRequestByReference(organizationId: string, reference: string): Promise<AutomationRequest | null>;
  findRecentByDedupeKey(
    organizationId: string,
    dedupeKey: string,
    withinMs: number,
  ): Promise<AutomationRequest | null>;
  updateRequest(
    requestId: string,
    patch: Partial<
      Pick<AutomationRequest, 'status' | 'payload' | 'result' | 'error' | 'messageId'>
    >,
  ): Promise<AutomationRequest>;
  listRequests(filter: ListRequestsFilter): Promise<AutomationRequest[]>;

  // Approvals ---------------------------------------------------------------
  addApproval(approval: Omit<AutomationApproval, 'id' | 'createdAt'>): Promise<AutomationApproval>;
  listApprovals(requestId: string): Promise<AutomationApproval[]>;

  // Audit -------------------------------------------------------------------
  addEvent(event: Omit<AutomationEvent, 'id' | 'createdAt'>): Promise<AutomationEvent>;
  listEvents(organizationId: string, limit: number): Promise<AutomationEvent[]>;
  listEventsForRequest(requestId: string): Promise<AutomationEvent[]>;

  // State configuration -----------------------------------------------------
  getStateConfiguration(
    organizationId: string,
    readymodeUserId: string,
  ): Promise<StateConfigurationRecord | null>;
  listStateConfigurations(organizationId: string): Promise<StateConfigurationRecord[]>;
  upsertStateConfiguration(
    record: Omit<StateConfigurationRecord, 'id' | 'updatedAt'> & { id?: string },
  ): Promise<StateConfigurationRecord>;
  getDefaultStates(organizationId: string): Promise<string[]>;
  setDefaultStates(organizationId: string, states: string[], updatedBy?: string | null): Promise<void>;

  // Readymode interface profiles ---------------------------------------------
  createInterfaceProfile(input: CreateInterfaceProfileInput): Promise<InterfaceProfileWithSelectors>;
  getInterfaceProfile(profileId: string): Promise<InterfaceProfileWithSelectors | null>;
  getActiveInterfaceProfile(organizationId: string): Promise<InterfaceProfileWithSelectors | null>;
  listInterfaceProfiles(organizationId: string, limit: number): Promise<InterfaceProfileRecord[]>;
  approveInterfaceProfile(input: {
    organizationId: string;
    profileId: string;
    approvedBy: string;
  }): Promise<InterfaceProfileWithSelectors>;
  rejectInterfaceProfile(input: {
    organizationId: string;
    profileId: string;
    notes?: string;
  }): Promise<InterfaceProfileRecord>;
  getInterfaceEvidence(profileId: string): Promise<unknown | null>;

  // Settings ----------------------------------------------------------------
  getSetting<T = unknown>(organizationId: string, key: string): Promise<T | null>;
  setSetting(organizationId: string, key: string, value: unknown): Promise<void>;
}

export type { Role };
