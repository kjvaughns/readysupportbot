import { SupabaseClient } from '@supabase/supabase-js';
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
  Role,
} from '../types';
import { AppError } from '../security/errors';
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
 * Supabase-backed store. The backend uses the service role key, so every query
 * here is written to filter by organization explicitly — row level security is
 * the second line of defence, not the only one.
 */
export class SupabaseStore implements DataStore {
  readonly kind = 'supabase' as const;

  constructor(private readonly client: SupabaseClient) {}

  private fail(operation: string, error: { message: string; code?: string }): never {
    throw new AppError('database_error', `Database operation failed (${operation}).`, 500, {
      code: error.code,
    });
  }

  // -- Organizations --------------------------------------------------------

  async getOrganization(organizationId: string): Promise<Organization | null> {
    const { data, error } = await this.client
      .from('organizations')
      .select('id, name, owner_user_id')
      .eq('id', organizationId)
      .maybeSingle();
    if (error) this.fail('getOrganization', error);
    return data ? { id: data.id, name: data.name, ownerUserId: data.owner_user_id } : null;
  }

  async getOrganizationForGuild(guildId: string): Promise<Organization | null> {
    const installation = await this.getInstallationByGuild(guildId);
    if (!installation) return null;
    return this.getOrganization(installation.organizationId);
  }

  async listOrganizationsForSupabaseUser(supabaseUserId: string): Promise<Organization[]> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('organizations(id, name, owner_user_id)')
      .eq('supabase_user_id', supabaseUserId);
    if (error) this.fail('listOrganizationsForSupabaseUser', error);
    return (data ?? [])
      .map((row: any) => row.organizations)
      .filter(Boolean)
      .map((org: any) => ({ id: org.id, name: org.name, ownerUserId: org.owner_user_id }));
  }

  private toMember(row: any): OrganizationMember {
    return {
      id: row.id,
      organizationId: row.organization_id,
      role: row.role as Role,
      discordUserId: row.discord_user_id,
      supabaseUserId: row.supabase_user_id,
      displayName: row.display_name,
    };
  }

  async getMemberByDiscordUser(
    organizationId: string,
    discordUserId: string,
  ): Promise<OrganizationMember | null> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('discord_user_id', discordUserId)
      .maybeSingle();
    if (error) this.fail('getMemberByDiscordUser', error);
    return data ? this.toMember(data) : null;
  }

  async getMemberBySupabaseUser(
    organizationId: string,
    supabaseUserId: string,
  ): Promise<OrganizationMember | null> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('supabase_user_id', supabaseUserId)
      .maybeSingle();
    if (error) this.fail('getMemberBySupabaseUser', error);
    return data ? this.toMember(data) : null;
  }

  async listMembers(organizationId: string): Promise<OrganizationMember[]> {
    const { data, error } = await this.client
      .from('organization_members')
      .select('*')
      .eq('organization_id', organizationId);
    if (error) this.fail('listMembers', error);
    return (data ?? []).map((row) => this.toMember(row));
  }

  async upsertMember(
    member: Omit<OrganizationMember, 'id'> & { id?: string },
  ): Promise<OrganizationMember> {
    const payload = {
      ...(member.id ? { id: member.id } : {}),
      organization_id: member.organizationId,
      role: member.role,
      discord_user_id: member.discordUserId ?? null,
      supabase_user_id: member.supabaseUserId ?? null,
      display_name: member.displayName ?? null,
    };
    const { data, error } = await this.client
      .from('organization_members')
      .upsert(payload, { onConflict: member.discordUserId ? 'organization_id,discord_user_id' : 'organization_id,supabase_user_id' })
      .select()
      .single();
    if (error) this.fail('upsertMember', error);
    return this.toMember(data);
  }

  // -- Discord --------------------------------------------------------------

  private toInstallation(row: any): DiscordInstallation {
    return {
      id: row.id,
      organizationId: row.organization_id,
      guildId: row.guild_id,
      installed: row.installed,
      notificationChannelId: row.notification_channel_id,
      requireMention: row.require_mention,
    };
  }

  async getInstallation(organizationId: string): Promise<DiscordInstallation | null> {
    const { data, error } = await this.client
      .from('discord_installations')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) this.fail('getInstallation', error);
    return data ? this.toInstallation(data) : null;
  }

  async getInstallationByGuild(guildId: string): Promise<DiscordInstallation | null> {
    const { data, error } = await this.client
      .from('discord_installations')
      .select('*')
      .eq('guild_id', guildId)
      .maybeSingle();
    if (error) this.fail('getInstallationByGuild', error);
    return data ? this.toInstallation(data) : null;
  }

  async upsertInstallation(
    installation: Omit<DiscordInstallation, 'id'> & { id?: string },
  ): Promise<DiscordInstallation> {
    const { data, error } = await this.client
      .from('discord_installations')
      .upsert(
        {
          ...(installation.id ? { id: installation.id } : {}),
          organization_id: installation.organizationId,
          guild_id: installation.guildId,
          installed: installation.installed,
          notification_channel_id: installation.notificationChannelId ?? null,
          require_mention: installation.requireMention,
        },
        { onConflict: 'guild_id' },
      )
      .select()
      .single();
    if (error) this.fail('upsertInstallation', error);
    return this.toInstallation(data);
  }

  async listChannels(organizationId: string): Promise<DiscordChannelConfig[]> {
    const { data, error } = await this.client
      .from('discord_channels')
      .select('*')
      .eq('organization_id', organizationId);
    if (error) this.fail('listChannels', error);
    return (data ?? []).map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      autoSupport: row.auto_support,
      approved: row.approved,
    }));
  }

  async upsertChannel(
    channel: Omit<DiscordChannelConfig, 'id'> & { id?: string },
  ): Promise<DiscordChannelConfig> {
    const { data, error } = await this.client
      .from('discord_channels')
      .upsert(
        {
          ...(channel.id ? { id: channel.id } : {}),
          organization_id: channel.organizationId,
          guild_id: channel.guildId,
          channel_id: channel.channelId,
          auto_support: channel.autoSupport,
          approved: channel.approved,
        },
        { onConflict: 'organization_id,channel_id' },
      )
      .select()
      .single();
    if (error) this.fail('upsertChannel', error);
    return {
      id: data.id,
      organizationId: data.organization_id,
      guildId: data.guild_id,
      channelId: data.channel_id,
      autoSupport: data.auto_support,
      approved: data.approved,
    };
  }

  async removeChannel(organizationId: string, channelId: string): Promise<void> {
    const { error } = await this.client
      .from('discord_channels')
      .delete()
      .eq('organization_id', organizationId)
      .eq('channel_id', channelId);
    if (error) this.fail('removeChannel', error);
  }

  async listRoleMappings(organizationId: string): Promise<DiscordRoleMapping[]> {
    const { data, error } = await this.client
      .from('discord_role_mappings')
      .select('*')
      .eq('organization_id', organizationId);
    if (error) this.fail('listRoleMappings', error);
    return (data ?? []).map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      guildId: row.guild_id,
      discordRoleId: row.discord_role_id,
      role: row.role as Role,
    }));
  }

  async upsertRoleMapping(
    mapping: Omit<DiscordRoleMapping, 'id'> & { id?: string },
  ): Promise<DiscordRoleMapping> {
    const { data, error } = await this.client
      .from('discord_role_mappings')
      .upsert(
        {
          ...(mapping.id ? { id: mapping.id } : {}),
          organization_id: mapping.organizationId,
          guild_id: mapping.guildId,
          discord_role_id: mapping.discordRoleId,
          role: mapping.role,
        },
        { onConflict: 'organization_id,discord_role_id' },
      )
      .select()
      .single();
    if (error) this.fail('upsertRoleMapping', error);
    return {
      id: data.id,
      organizationId: data.organization_id,
      guildId: data.guild_id,
      discordRoleId: data.discord_role_id,
      role: data.role as Role,
    };
  }

  // -- Readymode connection -------------------------------------------------

  private toConnection(row: any): ReadymodeConnection {
    return {
      id: row.id,
      organizationId: row.organization_id,
      loginUrl: row.login_url,
      username: row.username,
      status: row.status,
      lastVerifiedAt: row.last_verified_at,
      lastError: row.last_error,
    };
  }

  async getConnection(organizationId: string): Promise<ReadymodeConnection | null> {
    const { data, error } = await this.client
      .from('readymode_connections')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) this.fail('getConnection', error);
    return data ? this.toConnection(data) : null;
  }

  async upsertConnection(
    connection: Omit<ReadymodeConnection, 'id'> & { id?: string },
  ): Promise<ReadymodeConnection> {
    const { data, error } = await this.client
      .from('readymode_connections')
      .upsert(
        {
          ...(connection.id ? { id: connection.id } : {}),
          organization_id: connection.organizationId,
          login_url: connection.loginUrl,
          username: connection.username,
          status: connection.status,
          last_verified_at: connection.lastVerifiedAt ?? null,
          last_error: connection.lastError ?? null,
        },
        { onConflict: 'organization_id' },
      )
      .select()
      .single();
    if (error) this.fail('upsertConnection', error);
    return this.toConnection(data);
  }

  async deleteConnection(organizationId: string): Promise<void> {
    const { error } = await this.client
      .from('readymode_connections')
      .delete()
      .eq('organization_id', organizationId);
    if (error) this.fail('deleteConnection', error);
  }

  async getCredentials(organizationId: string): Promise<StoredCredentials | null> {
    const { data, error } = await this.client
      .from('encrypted_credentials')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('kind', 'readymode_admin')
      .maybeSingle();
    if (error) this.fail('getCredentials', error);
    if (!data) return null;
    return {
      organizationId: data.organization_id,
      encryptedPassword: data.encrypted_password,
      username: data.username,
      loginUrl: data.login_url,
      updatedAt: data.updated_at,
      updatedBy: data.updated_by,
    };
  }

  async upsertCredentials(credentials: StoredCredentials): Promise<void> {
    const { error } = await this.client.from('encrypted_credentials').upsert(
      {
        organization_id: credentials.organizationId,
        kind: 'readymode_admin',
        username: credentials.username,
        login_url: credentials.loginUrl,
        encrypted_password: credentials.encryptedPassword,
        updated_at: credentials.updatedAt,
        updated_by: credentials.updatedBy ?? null,
      },
      { onConflict: 'organization_id,kind' },
    );
    if (error) this.fail('upsertCredentials', error);
  }

  async deleteCredentials(organizationId: string): Promise<void> {
    const { error } = await this.client
      .from('encrypted_credentials')
      .delete()
      .eq('organization_id', organizationId)
      .eq('kind', 'readymode_admin');
    if (error) this.fail('deleteCredentials', error);
  }

  // -- Linked agents --------------------------------------------------------

  async listLinkedAgentsForDiscordUser(
    organizationId: string,
    discordUserId: string,
  ): Promise<LinkedAgent[]> {
    const { data, error } = await this.client
      .from('linked_agents')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('discord_user_id', discordUserId);
    if (error) this.fail('listLinkedAgentsForDiscordUser', error);
    return (data ?? []).map((row: any) => ({
      id: row.id,
      organizationId: row.organization_id,
      discordUserId: row.discord_user_id,
      readymodeUserId: row.readymode_user_id,
      username: row.username,
      fullName: row.full_name,
      email: row.email,
    }));
  }

  async upsertLinkedAgent(agent: Omit<LinkedAgent, 'id'> & { id?: string }): Promise<LinkedAgent> {
    const { data, error } = await this.client
      .from('linked_agents')
      .upsert(
        {
          ...(agent.id ? { id: agent.id } : {}),
          organization_id: agent.organizationId,
          discord_user_id: agent.discordUserId,
          readymode_user_id: agent.readymodeUserId,
          username: agent.username,
          full_name: agent.fullName ?? null,
          email: agent.email ?? null,
        },
        { onConflict: 'organization_id,readymode_user_id' },
      )
      .select()
      .single();
    if (error) this.fail('upsertLinkedAgent', error);
    return {
      id: data.id,
      organizationId: data.organization_id,
      discordUserId: data.discord_user_id,
      readymodeUserId: data.readymode_user_id,
      username: data.username,
      fullName: data.full_name,
      email: data.email,
    };
  }

  // -- Requests -------------------------------------------------------------

  private toRequest(row: any): AutomationRequest {
    return {
      id: row.id,
      reference: row.reference,
      organizationId: row.organization_id,
      status: row.status,
      actionType: row.action_type,
      payload: row.payload ?? {},
      requestedByDiscordUserId: row.requested_by_discord_user_id,
      requestedBySupabaseUserId: row.requested_by_supabase_user_id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      messageId: row.message_id,
      result: row.result,
      error: row.error,
      dedupeKey: row.dedupe_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async createRequest(input: CreateRequestInput): Promise<AutomationRequest> {
    const { data, error } = await this.client
      .from('automation_requests')
      .insert({
        organization_id: input.organizationId,
        status: input.status,
        action_type: input.actionType,
        payload: input.payload,
        requested_by_discord_user_id: input.requestedByDiscordUserId ?? null,
        requested_by_supabase_user_id: input.requestedBySupabaseUserId ?? null,
        guild_id: input.guildId ?? null,
        channel_id: input.channelId ?? null,
        message_id: input.messageId ?? null,
        dedupe_key: input.dedupeKey ?? null,
      })
      .select()
      .single();
    if (error) this.fail('createRequest', error);
    return this.toRequest(data);
  }

  async getRequest(requestId: string): Promise<AutomationRequest | null> {
    const { data, error } = await this.client
      .from('automation_requests')
      .select('*')
      .eq('id', requestId)
      .maybeSingle();
    if (error) this.fail('getRequest', error);
    return data ? this.toRequest(data) : null;
  }

  async getRequestByReference(
    organizationId: string,
    reference: string,
  ): Promise<AutomationRequest | null> {
    const { data, error } = await this.client
      .from('automation_requests')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('reference', reference)
      .maybeSingle();
    if (error) this.fail('getRequestByReference', error);
    return data ? this.toRequest(data) : null;
  }

  async findRecentByDedupeKey(
    organizationId: string,
    dedupeKey: string,
    withinMs: number,
  ): Promise<AutomationRequest | null> {
    const cutoff = new Date(Date.now() - withinMs).toISOString();
    const { data, error } = await this.client
      .from('automation_requests')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('dedupe_key', dedupeKey)
      .gte('created_at', cutoff)
      .not('status', 'in', '("CANCELLED","FAILED")')
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) this.fail('findRecentByDedupeKey', error);
    return data && data.length > 0 ? this.toRequest(data[0]) : null;
  }

  async updateRequest(
    requestId: string,
    patch: Partial<Pick<AutomationRequest, 'status' | 'payload' | 'result' | 'error' | 'messageId'>>,
  ): Promise<AutomationRequest> {
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.payload !== undefined) update.payload = patch.payload;
    if (patch.result !== undefined) update.result = patch.result;
    if (patch.error !== undefined) update.error = patch.error;
    if (patch.messageId !== undefined) update.message_id = patch.messageId;

    const { data, error } = await this.client
      .from('automation_requests')
      .update(update)
      .eq('id', requestId)
      .select()
      .single();
    if (error) this.fail('updateRequest', error);
    return this.toRequest(data);
  }

  async listRequests(filter: ListRequestsFilter): Promise<AutomationRequest[]> {
    let query = this.client
      .from('automation_requests')
      .select('*')
      .eq('organization_id', filter.organizationId)
      .order('created_at', { ascending: false })
      .limit(filter.limit ?? 20);
    if (filter.statuses && filter.statuses.length > 0) query = query.in('status', filter.statuses);

    const { data, error } = await query;
    if (error) this.fail('listRequests', error);
    return (data ?? []).map((row) => this.toRequest(row));
  }

  // -- Approvals ------------------------------------------------------------

  async addApproval(
    approval: Omit<AutomationApproval, 'id' | 'createdAt'>,
  ): Promise<AutomationApproval> {
    const { data, error } = await this.client
      .from('automation_approvals')
      .insert({
        request_id: approval.requestId,
        organization_id: approval.organizationId,
        approver_discord_user_id: approval.approverDiscordUserId ?? null,
        approver_supabase_user_id: approval.approverSupabaseUserId ?? null,
        approver_role: approval.approverRole,
        sequence: approval.sequence,
      })
      .select()
      .single();
    if (error) this.fail('addApproval', error);
    return {
      id: data.id,
      requestId: data.request_id,
      organizationId: data.organization_id,
      approverDiscordUserId: data.approver_discord_user_id,
      approverSupabaseUserId: data.approver_supabase_user_id,
      approverRole: data.approver_role as Role,
      sequence: data.sequence,
      createdAt: data.created_at,
    };
  }

  async listApprovals(requestId: string): Promise<AutomationApproval[]> {
    const { data, error } = await this.client
      .from('automation_approvals')
      .select('*')
      .eq('request_id', requestId)
      .order('sequence', { ascending: true });
    if (error) this.fail('listApprovals', error);
    return (data ?? []).map((row: any) => ({
      id: row.id,
      requestId: row.request_id,
      organizationId: row.organization_id,
      approverDiscordUserId: row.approver_discord_user_id,
      approverSupabaseUserId: row.approver_supabase_user_id,
      approverRole: row.approver_role as Role,
      sequence: row.sequence,
      createdAt: row.created_at,
    }));
  }

  // -- Events ---------------------------------------------------------------

  private toEvent(row: any): AutomationEvent {
    return {
      id: row.id,
      requestId: row.request_id,
      organizationId: row.organization_id,
      type: row.type,
      message: row.message,
      data: row.data,
      createdAt: row.created_at,
    };
  }

  async addEvent(event: Omit<AutomationEvent, 'id' | 'createdAt'>): Promise<AutomationEvent> {
    const { data, error } = await this.client
      .from('automation_events')
      .insert({
        request_id: event.requestId ?? null,
        organization_id: event.organizationId,
        type: event.type,
        message: event.message,
        data: event.data ?? null,
      })
      .select()
      .single();
    if (error) this.fail('addEvent', error);
    return this.toEvent(data);
  }

  async listEvents(organizationId: string, limit: number): Promise<AutomationEvent[]> {
    const { data, error } = await this.client
      .from('automation_events')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) this.fail('listEvents', error);
    return (data ?? []).map((row) => this.toEvent(row));
  }

  async listEventsForRequest(requestId: string): Promise<AutomationEvent[]> {
    const { data, error } = await this.client
      .from('automation_events')
      .select('*')
      .eq('request_id', requestId)
      .order('created_at', { ascending: true });
    if (error) this.fail('listEventsForRequest', error);
    return (data ?? []).map((row) => this.toEvent(row));
  }

  // -- State configuration --------------------------------------------------

  private toStateConfiguration(row: any): StateConfigurationRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      readymodeUserId: row.readymode_user_id,
      username: row.username,
      states: row.states ?? [],
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
    };
  }

  async getStateConfiguration(
    organizationId: string,
    readymodeUserId: string,
  ): Promise<StateConfigurationRecord | null> {
    const { data, error } = await this.client
      .from('state_configurations')
      .select('*')
      .eq('organization_id', organizationId)
      .eq('readymode_user_id', readymodeUserId)
      .maybeSingle();
    if (error) this.fail('getStateConfiguration', error);
    return data ? this.toStateConfiguration(data) : null;
  }

  async listStateConfigurations(organizationId: string): Promise<StateConfigurationRecord[]> {
    const { data, error } = await this.client
      .from('state_configurations')
      .select('*')
      .eq('organization_id', organizationId)
      .order('updated_at', { ascending: false });
    if (error) this.fail('listStateConfigurations', error);
    return (data ?? []).map((row) => this.toStateConfiguration(row));
  }

  async upsertStateConfiguration(
    record: Omit<StateConfigurationRecord, 'id' | 'updatedAt'> & { id?: string },
  ): Promise<StateConfigurationRecord> {
    const { data, error } = await this.client
      .from('state_configurations')
      .upsert(
        {
          ...(record.id ? { id: record.id } : {}),
          organization_id: record.organizationId,
          readymode_user_id: record.readymodeUserId,
          username: record.username ?? null,
          states: record.states,
          updated_at: new Date().toISOString(),
          updated_by: record.updatedBy ?? null,
        },
        { onConflict: 'organization_id,readymode_user_id' },
      )
      .select()
      .single();
    if (error) this.fail('upsertStateConfiguration', error);
    return this.toStateConfiguration(data);
  }

  async getDefaultStates(organizationId: string): Promise<string[]> {
    const { data, error } = await this.client
      .from('default_state_configurations')
      .select('states')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) this.fail('getDefaultStates', error);
    return data?.states ?? [];
  }

  async setDefaultStates(
    organizationId: string,
    states: string[],
    updatedBy?: string | null,
  ): Promise<void> {
    const { error } = await this.client.from('default_state_configurations').upsert(
      {
        organization_id: organizationId,
        states,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy ?? null,
      },
      { onConflict: 'organization_id' },
    );
    if (error) this.fail('setDefaultStates', error);
  }

  // -- Readymode interface profiles ------------------------------------------

  private toProfile(row: any): InterfaceProfileRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      status: row.status,
      schemaVersion: row.schema_version,
      baseUrl: row.base_url,
      interfaceVersion: row.interface_version,
      pagesCaptured: row.pages_captured,
      controlsTotal: row.controls_total,
      controlsProposed: row.controls_proposed,
      capabilities: row.capabilities ?? [],
      unproposed: row.unproposed ?? [],
      screenshotPaths: row.screenshot_paths ?? [],
      discoveredBy: row.discovered_by,
      discoveredAt: row.discovered_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      supersededBy: row.superseded_by,
      notes: row.notes,
    };
  }

  private toSelector(row: any): SelectorVersionRecord {
    return {
      id: row.id,
      profileId: row.profile_id,
      organizationId: row.organization_id,
      controlName: row.control_name,
      strategy: row.strategy ?? {},
      tier: row.tier,
      confidence: row.confidence,
      rootName: row.root_name,
      rootUrl: row.root_url,
      evidenceRef: row.evidence_ref ?? {},
      verified: row.verified,
      verifiedMatches: row.verified_matches,
    };
  }

  /** Columns read for profile queries. Never `*`, so evidence cannot leak in. */
  private static readonly PROFILE_COLUMNS =
    'id, organization_id, status, schema_version, base_url, interface_version, pages_captured, ' +
    'controls_total, controls_proposed, capabilities, unproposed, screenshot_paths, ' +
    'discovered_by, discovered_at, approved_by, approved_at, superseded_by, notes';

  private async selectorsFor(profileId: string): Promise<SelectorVersionRecord[]> {
    const { data, error } = await this.client
      .from('readymode_selector_versions')
      .select('*')
      .eq('profile_id', profileId);
    if (error) this.fail('selectorsFor', error);
    return (data ?? []).map((row) => this.toSelector(row));
  }

  async createInterfaceProfile(
    input: CreateInterfaceProfileInput,
  ): Promise<InterfaceProfileWithSelectors> {
    const { data, error } = await this.client
      .from('readymode_interface_profiles')
      .insert({
        organization_id: input.profile.organizationId,
        status: 'proposed',
        schema_version: input.profile.schemaVersion,
        base_url: input.profile.baseUrl,
        interface_version: input.profile.interfaceVersion,
        pages_captured: input.profile.pagesCaptured,
        controls_total: input.profile.controlsTotal,
        controls_proposed: input.profile.controlsProposed,
        capabilities: input.profile.capabilities,
        unproposed: input.profile.unproposed,
        screenshot_paths: input.profile.screenshotPaths,
        discovered_by: input.profile.discoveredBy,
        discovered_at: input.profile.discoveredAt,
        notes: input.profile.notes,
      })
      .select(SupabaseStore.PROFILE_COLUMNS)
      .single();
    if (error) this.fail('createInterfaceProfile', error);

    const profile = this.toProfile(data);

    try {
      if (input.selectors.length > 0) {
        const { error: selectorError } = await this.client.from('readymode_selector_versions').insert(
          input.selectors.map((selector) => ({
            profile_id: profile.id,
            organization_id: selector.organizationId,
            control_name: selector.controlName,
            strategy: selector.strategy,
            tier: selector.tier,
            confidence: selector.confidence,
            root_name: selector.rootName,
            root_url: selector.rootUrl,
            evidence_ref: selector.evidenceRef,
            verified: selector.verified,
            verified_matches: selector.verifiedMatches,
          })),
        );
        if (selectorError) this.fail('createInterfaceProfile.selectors', selectorError);
      }

      const evidenceJson = JSON.stringify(input.evidence ?? {});
      const { error: evidenceError } = await this.client.from('readymode_interface_evidence').insert({
        profile_id: profile.id,
        organization_id: profile.organizationId,
        evidence: input.evidence ?? {},
        byte_size: evidenceJson.length,
      });
      if (evidenceError) this.fail('createInterfaceProfile.evidence', evidenceError);
    } catch (failure) {
      // A profile with no selectors would read as "nothing was found", which is
      // a different and misleading claim. Remove it rather than leave it.
      await this.client.from('readymode_interface_profiles').delete().eq('id', profile.id);
      throw failure;
    }

    return { ...profile, selectors: await this.selectorsFor(profile.id) };
  }

  async getInterfaceProfile(profileId: string): Promise<InterfaceProfileWithSelectors | null> {
    const { data, error } = await this.client
      .from('readymode_interface_profiles')
      .select(SupabaseStore.PROFILE_COLUMNS)
      .eq('id', profileId)
      .maybeSingle();
    if (error) this.fail('getInterfaceProfile', error);
    if (!data) return null;

    const profile = this.toProfile(data);
    return { ...profile, selectors: await this.selectorsFor(profile.id) };
  }

  async getActiveInterfaceProfile(
    organizationId: string,
  ): Promise<InterfaceProfileWithSelectors | null> {
    const { data, error } = await this.client
      .from('readymode_interface_profiles')
      .select(SupabaseStore.PROFILE_COLUMNS)
      .eq('organization_id', organizationId)
      .eq('status', 'active')
      .maybeSingle();
    if (error) this.fail('getActiveInterfaceProfile', error);
    if (!data) return null;

    const profile = this.toProfile(data);
    return { ...profile, selectors: await this.selectorsFor(profile.id) };
  }

  async listInterfaceProfiles(
    organizationId: string,
    limit: number,
  ): Promise<InterfaceProfileRecord[]> {
    const { data, error } = await this.client
      .from('readymode_interface_profiles')
      .select(SupabaseStore.PROFILE_COLUMNS)
      .eq('organization_id', organizationId)
      .order('discovered_at', { ascending: false })
      .limit(limit);
    if (error) this.fail('listInterfaceProfiles', error);
    return (data ?? []).map((row) => this.toProfile(row));
  }

  async approveInterfaceProfile(input: {
    organizationId: string;
    profileId: string;
    approvedBy: string;
  }): Promise<InterfaceProfileWithSelectors> {
    // Demote first. The partial unique index makes a concurrent double approval
    // fail loudly instead of quietly leaving two active profiles.
    const { error: demoteError } = await this.client
      .from('readymode_interface_profiles')
      .update({ status: 'superseded', superseded_by: input.profileId })
      .eq('organization_id', input.organizationId)
      .eq('status', 'active')
      .neq('id', input.profileId);
    if (demoteError) this.fail('approveInterfaceProfile.demote', demoteError);

    const { data, error } = await this.client
      .from('readymode_interface_profiles')
      .update({
        status: 'active',
        approved_by: input.approvedBy,
        approved_at: new Date().toISOString(),
      })
      .eq('id', input.profileId)
      .eq('organization_id', input.organizationId)
      .select(SupabaseStore.PROFILE_COLUMNS)
      .single();
    if (error) this.fail('approveInterfaceProfile', error);

    const profile = this.toProfile(data);
    return { ...profile, selectors: await this.selectorsFor(profile.id) };
  }

  async rejectInterfaceProfile(input: {
    organizationId: string;
    profileId: string;
    notes?: string;
  }): Promise<InterfaceProfileRecord> {
    const { data, error } = await this.client
      .from('readymode_interface_profiles')
      .update({ status: 'rejected', notes: input.notes ?? null })
      .eq('id', input.profileId)
      .eq('organization_id', input.organizationId)
      .select(SupabaseStore.PROFILE_COLUMNS)
      .single();
    if (error) this.fail('rejectInterfaceProfile', error);
    return this.toProfile(data);
  }

  async getInterfaceEvidence(profileId: string): Promise<unknown | null> {
    const { data, error } = await this.client
      .from('readymode_interface_evidence')
      .select('evidence')
      .eq('profile_id', profileId)
      .maybeSingle();
    if (error) this.fail('getInterfaceEvidence', error);
    return data?.evidence ?? null;
  }

  // -- Settings -------------------------------------------------------------

  async getSetting<T = unknown>(organizationId: string, key: string): Promise<T | null> {
    const { data, error } = await this.client
      .from('system_settings')
      .select('value')
      .eq('organization_id', organizationId)
      .eq('key', key)
      .maybeSingle();
    if (error) this.fail('getSetting', error);
    return (data?.value as T) ?? null;
  }

  async setSetting(organizationId: string, key: string, value: unknown): Promise<void> {
    const { error } = await this.client.from('system_settings').upsert(
      {
        organization_id: organizationId,
        key,
        value,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'organization_id,key' },
    );
    if (error) this.fail('setSetting', error);
  }
}
