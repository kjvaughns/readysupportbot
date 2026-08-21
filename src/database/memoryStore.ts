import { randomUUID } from 'node:crypto';
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
} from '../types';
import { newReference } from '../security/ids';
import {
  CreateInterfaceProfileInput,
  CreateRequestInput,
  DataStore,
  InterfaceProfileRecord,
  InterfaceProfileWithSelectors,
  ListRequestsFilter,
  SelectorVersionRecord,
  StateConfigurationRecord,
  StoredCredentials,
} from './store';

/**
 * In-memory store. Used by the test suite and while the service runs in setup
 * mode without Supabase credentials, so the bot can be exercised end to end
 * before the database is connected. Nothing here survives a restart.
 */
export class MemoryStore implements DataStore {
  readonly kind = 'memory' as const;

  organizations = new Map<string, Organization>();
  members: OrganizationMember[] = [];
  installations: DiscordInstallation[] = [];
  channels: DiscordChannelConfig[] = [];
  roleMappings: DiscordRoleMapping[] = [];
  connections = new Map<string, ReadymodeConnection>();
  credentials = new Map<string, StoredCredentials>();
  linkedAgents: LinkedAgent[] = [];
  requests = new Map<string, AutomationRequest>();
  approvals: AutomationApproval[] = [];
  events: AutomationEvent[] = [];
  stateConfigurations: StateConfigurationRecord[] = [];
  defaultStates = new Map<string, string[]>();
  settings = new Map<string, unknown>();
  interfaceProfiles: InterfaceProfileRecord[] = [];
  selectorVersions: SelectorVersionRecord[] = [];
  interfaceEvidence = new Map<string, unknown>();

  private now(): string {
    return new Date().toISOString();
  }

  reset(): void {
    this.organizations.clear();
    this.members = [];
    this.installations = [];
    this.channels = [];
    this.roleMappings = [];
    this.connections.clear();
    this.credentials.clear();
    this.linkedAgents = [];
    this.requests.clear();
    this.approvals = [];
    this.events = [];
    this.stateConfigurations = [];
    this.defaultStates.clear();
    this.settings.clear();
    this.interfaceProfiles = [];
    this.selectorVersions = [];
    this.interfaceEvidence.clear();
  }

  async getOrganization(organizationId: string): Promise<Organization | null> {
    return this.organizations.get(organizationId) ?? null;
  }

  async getOrganizationForGuild(guildId: string): Promise<Organization | null> {
    const installation = this.installations.find((entry) => entry.guildId === guildId);
    if (!installation) return null;
    return this.organizations.get(installation.organizationId) ?? null;
  }

  async listOrganizationsForSupabaseUser(supabaseUserId: string): Promise<Organization[]> {
    const ids = new Set(
      this.members
        .filter((member) => member.supabaseUserId === supabaseUserId)
        .map((member) => member.organizationId),
    );
    return [...ids]
      .map((id) => this.organizations.get(id))
      .filter((org): org is Organization => Boolean(org));
  }

  async getMemberByDiscordUser(
    organizationId: string,
    discordUserId: string,
  ): Promise<OrganizationMember | null> {
    return (
      this.members.find(
        (member) =>
          member.organizationId === organizationId && member.discordUserId === discordUserId,
      ) ?? null
    );
  }

  async getMemberBySupabaseUser(
    organizationId: string,
    supabaseUserId: string,
  ): Promise<OrganizationMember | null> {
    return (
      this.members.find(
        (member) =>
          member.organizationId === organizationId && member.supabaseUserId === supabaseUserId,
      ) ?? null
    );
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    return this.members.filter((member) => member.organizationId === organizationId);
  }

  async upsertMember(
    member: Omit<OrganizationMember, 'id'> & { id?: string },
  ): Promise<OrganizationMember> {
    const existingIndex = this.members.findIndex(
      (entry) =>
        entry.id === member.id ||
        (entry.organizationId === member.organizationId &&
          ((member.discordUserId && entry.discordUserId === member.discordUserId) ||
            (member.supabaseUserId && entry.supabaseUserId === member.supabaseUserId))),
    );
    const record: OrganizationMember = { id: member.id ?? randomUUID(), ...member } as OrganizationMember;
    if (existingIndex >= 0) {
      record.id = this.members[existingIndex].id;
      this.members[existingIndex] = record;
    } else {
      this.members.push(record);
    }
    return record;
  }

  async getInstallation(organizationId: string): Promise<DiscordInstallation | null> {
    return this.installations.find((entry) => entry.organizationId === organizationId) ?? null;
  }

  async getInstallationByGuild(guildId: string): Promise<DiscordInstallation | null> {
    return this.installations.find((entry) => entry.guildId === guildId) ?? null;
  }

  async upsertInstallation(
    installation: Omit<DiscordInstallation, 'id'> & { id?: string },
  ): Promise<DiscordInstallation> {
    const index = this.installations.findIndex((entry) => entry.guildId === installation.guildId);
    const record: DiscordInstallation = {
      id: installation.id ?? randomUUID(),
      ...installation,
    } as DiscordInstallation;
    if (index >= 0) {
      record.id = this.installations[index].id;
      this.installations[index] = record;
    } else {
      this.installations.push(record);
    }
    return record;
  }

  async listChannels(organizationId: string): Promise<DiscordChannelConfig[]> {
    return this.channels.filter((entry) => entry.organizationId === organizationId);
  }

  async upsertChannel(
    channel: Omit<DiscordChannelConfig, 'id'> & { id?: string },
  ): Promise<DiscordChannelConfig> {
    const index = this.channels.findIndex(
      (entry) =>
        entry.organizationId === channel.organizationId && entry.channelId === channel.channelId,
    );
    const record: DiscordChannelConfig = {
      id: channel.id ?? randomUUID(),
      ...channel,
    } as DiscordChannelConfig;
    if (index >= 0) {
      record.id = this.channels[index].id;
      this.channels[index] = record;
    } else {
      this.channels.push(record);
    }
    return record;
  }

  async removeChannel(organizationId: string, channelId: string): Promise<void> {
    this.channels = this.channels.filter(
      (entry) => !(entry.organizationId === organizationId && entry.channelId === channelId),
    );
  }

  async listRoleMappings(organizationId: string): Promise<DiscordRoleMapping[]> {
    return this.roleMappings.filter((entry) => entry.organizationId === organizationId);
  }

  async upsertRoleMapping(
    mapping: Omit<DiscordRoleMapping, 'id'> & { id?: string },
  ): Promise<DiscordRoleMapping> {
    const index = this.roleMappings.findIndex(
      (entry) =>
        entry.organizationId === mapping.organizationId &&
        entry.discordRoleId === mapping.discordRoleId,
    );
    const record: DiscordRoleMapping = {
      id: mapping.id ?? randomUUID(),
      ...mapping,
    } as DiscordRoleMapping;
    if (index >= 0) {
      record.id = this.roleMappings[index].id;
      this.roleMappings[index] = record;
    } else {
      this.roleMappings.push(record);
    }
    return record;
  }

  async getConnection(organizationId: string): Promise<ReadymodeConnection | null> {
    return this.connections.get(organizationId) ?? null;
  }

  async upsertConnection(
    connection: Omit<ReadymodeConnection, 'id'> & { id?: string },
  ): Promise<ReadymodeConnection> {
    const existing = this.connections.get(connection.organizationId);
    const record: ReadymodeConnection = {
      id: existing?.id ?? connection.id ?? randomUUID(),
      ...connection,
    } as ReadymodeConnection;
    this.connections.set(connection.organizationId, record);
    return record;
  }

  async deleteConnection(organizationId: string): Promise<void> {
    this.connections.delete(organizationId);
  }

  async getCredentials(organizationId: string): Promise<StoredCredentials | null> {
    return this.credentials.get(organizationId) ?? null;
  }

  async upsertCredentials(credentials: StoredCredentials): Promise<void> {
    this.credentials.set(credentials.organizationId, credentials);
  }

  async deleteCredentials(organizationId: string): Promise<void> {
    this.credentials.delete(organizationId);
  }

  async listLinkedAgentsForDiscordUser(
    organizationId: string,
    discordUserId: string,
  ): Promise<LinkedAgent[]> {
    return this.linkedAgents.filter(
      (entry) => entry.organizationId === organizationId && entry.discordUserId === discordUserId,
    );
  }

  async upsertLinkedAgent(agent: Omit<LinkedAgent, 'id'> & { id?: string }): Promise<LinkedAgent> {
    const index = this.linkedAgents.findIndex(
      (entry) =>
        entry.organizationId === agent.organizationId &&
        entry.readymodeUserId === agent.readymodeUserId,
    );
    const record: LinkedAgent = { id: agent.id ?? randomUUID(), ...agent } as LinkedAgent;
    if (index >= 0) {
      record.id = this.linkedAgents[index].id;
      this.linkedAgents[index] = record;
    } else {
      this.linkedAgents.push(record);
    }
    return record;
  }

  async createRequest(input: CreateRequestInput): Promise<AutomationRequest> {
    const timestamp = this.now();
    const record: AutomationRequest = {
      id: randomUUID(),
      reference: newReference(),
      organizationId: input.organizationId,
      status: input.status,
      actionType: input.actionType,
      payload: input.payload,
      requestedByDiscordUserId: input.requestedByDiscordUserId ?? null,
      requestedBySupabaseUserId: input.requestedBySupabaseUserId ?? null,
      guildId: input.guildId ?? null,
      channelId: input.channelId ?? null,
      messageId: input.messageId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      result: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.requests.set(record.id, record);
    return record;
  }

  async getRequest(requestId: string): Promise<AutomationRequest | null> {
    return this.requests.get(requestId) ?? null;
  }

  async getRequestByReference(
    organizationId: string,
    reference: string,
  ): Promise<AutomationRequest | null> {
    return (
      [...this.requests.values()].find(
        (entry) => entry.organizationId === organizationId && entry.reference === reference,
      ) ?? null
    );
  }

  async findRecentByDedupeKey(
    organizationId: string,
    dedupeKey: string,
    withinMs: number,
  ): Promise<AutomationRequest | null> {
    const cutoff = Date.now() - withinMs;
    return (
      [...this.requests.values()]
        .filter(
          (entry) =>
            entry.organizationId === organizationId &&
            entry.dedupeKey === dedupeKey &&
            new Date(entry.createdAt).getTime() >= cutoff &&
            !['CANCELLED', 'FAILED'].includes(entry.status),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
    );
  }

  async updateRequest(
    requestId: string,
    patch: Partial<Pick<AutomationRequest, 'status' | 'payload' | 'result' | 'error' | 'messageId'>>,
  ): Promise<AutomationRequest> {
    const existing = this.requests.get(requestId);
    if (!existing) throw new Error(`Unknown request ${requestId}`);
    const updated: AutomationRequest = { ...existing, ...patch, updatedAt: this.now() };
    this.requests.set(requestId, updated);
    return updated;
  }

  async listRequests(filter: ListRequestsFilter): Promise<AutomationRequest[]> {
    return [...this.requests.values()]
      .filter((entry) => entry.organizationId === filter.organizationId)
      .filter((entry) => !filter.statuses || filter.statuses.includes(entry.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 20);
  }

  async addApproval(
    approval: Omit<AutomationApproval, 'id' | 'createdAt'>,
  ): Promise<AutomationApproval> {
    const record: AutomationApproval = {
      id: randomUUID(),
      createdAt: this.now(),
      ...approval,
    };
    this.approvals.push(record);
    return record;
  }

  async listApprovals(requestId: string): Promise<AutomationApproval[]> {
    return this.approvals
      .filter((entry) => entry.requestId === requestId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async addEvent(event: Omit<AutomationEvent, 'id' | 'createdAt'>): Promise<AutomationEvent> {
    const record: AutomationEvent = { id: randomUUID(), createdAt: this.now(), ...event };
    this.events.push(record);
    return record;
  }

  async listEvents(organizationId: string, limit: number): Promise<AutomationEvent[]> {
    return this.events
      .filter((entry) => entry.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async listEventsForRequest(requestId: string): Promise<AutomationEvent[]> {
    return this.events
      .filter((entry) => entry.requestId === requestId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getStateConfiguration(
    organizationId: string,
    readymodeUserId: string,
  ): Promise<StateConfigurationRecord | null> {
    return (
      this.stateConfigurations.find(
        (entry) =>
          entry.organizationId === organizationId && entry.readymodeUserId === readymodeUserId,
      ) ?? null
    );
  }

  async listStateConfigurations(organizationId: string): Promise<StateConfigurationRecord[]> {
    return this.stateConfigurations.filter((entry) => entry.organizationId === organizationId);
  }

  async upsertStateConfiguration(
    record: Omit<StateConfigurationRecord, 'id' | 'updatedAt'> & { id?: string },
  ): Promise<StateConfigurationRecord> {
    const index = this.stateConfigurations.findIndex(
      (entry) =>
        entry.organizationId === record.organizationId &&
        entry.readymodeUserId === record.readymodeUserId,
    );
    const stored: StateConfigurationRecord = {
      id: record.id ?? randomUUID(),
      updatedAt: this.now(),
      ...record,
    } as StateConfigurationRecord;
    if (index >= 0) {
      stored.id = this.stateConfigurations[index].id;
      this.stateConfigurations[index] = stored;
    } else {
      this.stateConfigurations.push(stored);
    }
    return stored;
  }

  async getDefaultStates(organizationId: string): Promise<string[]> {
    return this.defaultStates.get(organizationId) ?? [];
  }

  async setDefaultStates(organizationId: string, states: string[]): Promise<void> {
    this.defaultStates.set(organizationId, states);
  }

  // -- Readymode interface profiles ------------------------------------------

  private withSelectors(profile: InterfaceProfileRecord): InterfaceProfileWithSelectors {
    return {
      ...profile,
      selectors: this.selectorVersions.filter((entry) => entry.profileId === profile.id),
    };
  }

  async createInterfaceProfile(
    input: CreateInterfaceProfileInput,
  ): Promise<InterfaceProfileWithSelectors> {
    const profile: InterfaceProfileRecord = {
      id: randomUUID(),
      status: 'proposed',
      approvedBy: null,
      approvedAt: null,
      supersededBy: null,
      ...input.profile,
    };
    this.interfaceProfiles.push(profile);

    for (const selector of input.selectors) {
      this.selectorVersions.push({ id: randomUUID(), profileId: profile.id, ...selector });
    }
    this.interfaceEvidence.set(profile.id, input.evidence);

    return this.withSelectors(profile);
  }

  async getInterfaceProfile(profileId: string): Promise<InterfaceProfileWithSelectors | null> {
    const profile = this.interfaceProfiles.find((entry) => entry.id === profileId);
    return profile ? this.withSelectors(profile) : null;
  }

  async getActiveInterfaceProfile(
    organizationId: string,
  ): Promise<InterfaceProfileWithSelectors | null> {
    const profile = this.interfaceProfiles.find(
      (entry) => entry.organizationId === organizationId && entry.status === 'active',
    );
    return profile ? this.withSelectors(profile) : null;
  }

  async listInterfaceProfiles(
    organizationId: string,
    limit: number,
  ): Promise<InterfaceProfileRecord[]> {
    return this.interfaceProfiles
      .filter((entry) => entry.organizationId === organizationId)
      .sort((a, b) => b.discoveredAt.localeCompare(a.discoveredAt))
      .slice(0, limit);
  }

  async approveInterfaceProfile(input: {
    organizationId: string;
    profileId: string;
    approvedBy: string;
  }): Promise<InterfaceProfileWithSelectors> {
    const profile = this.interfaceProfiles.find(
      (entry) => entry.id === input.profileId && entry.organizationId === input.organizationId,
    );
    if (!profile) throw new Error(`Unknown interface profile ${input.profileId}`);

    // Exactly one active profile per organization, matching the partial unique
    // index the migration declares.
    for (const other of this.interfaceProfiles) {
      if (
        other.organizationId === input.organizationId &&
        other.status === 'active' &&
        other.id !== profile.id
      ) {
        other.status = 'superseded';
        other.supersededBy = profile.id;
      }
    }

    profile.status = 'active';
    profile.approvedBy = input.approvedBy;
    profile.approvedAt = this.now();
    return this.withSelectors(profile);
  }

  async rejectInterfaceProfile(input: {
    organizationId: string;
    profileId: string;
    notes?: string;
  }): Promise<InterfaceProfileRecord> {
    const profile = this.interfaceProfiles.find(
      (entry) => entry.id === input.profileId && entry.organizationId === input.organizationId,
    );
    if (!profile) throw new Error(`Unknown interface profile ${input.profileId}`);
    profile.status = 'rejected';
    profile.notes = input.notes ?? profile.notes;
    return profile;
  }

  async getInterfaceEvidence(profileId: string): Promise<unknown | null> {
    return this.interfaceEvidence.get(profileId) ?? null;
  }

  async getSetting<T = unknown>(organizationId: string, key: string): Promise<T | null> {
    return (this.settings.get(`${organizationId}:${key}`) as T) ?? null;
  }

  async setSetting(organizationId: string, key: string, value: unknown): Promise<void> {
    this.settings.set(`${organizationId}:${key}`, value);
  }
}
