import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setStore } from '../src/database';
import { resolveDiscordContext, resolveRole } from '../src/discord/context';

/**
 * Server, channel and role restrictions, plus organization isolation.
 */

let store: MemoryStore;

const ORG_A = 'org-a';
const ORG_B = 'org-b';
const GUILD_A = '1000';
const GUILD_B = '2000';
const CHANNEL_APPROVED = '10';
const CHANNEL_UNAPPROVED = '11';

beforeEach(async () => {
  store = new MemoryStore();
  setStore(store);

  store.organizations.set(ORG_A, { id: ORG_A, name: 'Organization A' });
  store.organizations.set(ORG_B, { id: ORG_B, name: 'Organization B' });

  await store.upsertInstallation({
    organizationId: ORG_A,
    guildId: GUILD_A,
    installed: true,
    requireMention: true,
    notificationChannelId: CHANNEL_APPROVED,
  });
  await store.upsertInstallation({
    organizationId: ORG_B,
    guildId: GUILD_B,
    installed: true,
    requireMention: false,
  });

  await store.upsertChannel({
    organizationId: ORG_A,
    guildId: GUILD_A,
    channelId: CHANNEL_APPROVED,
    approved: true,
    autoSupport: true,
  });
  await store.upsertChannel({
    organizationId: ORG_B,
    guildId: GUILD_B,
    channelId: '20',
    approved: true,
    autoSupport: false,
  });

  await store.upsertRoleMapping({
    organizationId: ORG_A,
    guildId: GUILD_A,
    discordRoleId: 'role-support',
    role: 'support',
  });
  await store.upsertRoleMapping({
    organizationId: ORG_A,
    guildId: GUILD_A,
    discordRoleId: 'role-admin',
    role: 'administrator',
  });
});

describe('Discord server and channel restrictions', () => {
  it('accepts a request from an approved server, channel and role', async () => {
    const resolution = await resolveDiscordContext({
      guildId: GUILD_A,
      channelId: CHANNEL_APPROVED,
      userId: '900',
      memberRoleIds: ['role-support'],
    });

    expect(resolution.status).toBe('ok');
    if (resolution.status === 'ok') {
      expect(resolution.context.organizationId).toBe(ORG_A);
      expect(resolution.context.role).toBe('support');
      expect(resolution.context.requireMention).toBe(true);
      expect(resolution.context.autoSupportChannel).toBe(true);
    }
  });

  it('rejects an unknown server quietly', async () => {
    const resolution = await resolveDiscordContext({
      guildId: '9999',
      channelId: CHANNEL_APPROVED,
      userId: '900',
      memberRoleIds: ['role-support'],
    });

    expect(resolution.status).toBe('rejected');
    if (resolution.status === 'rejected') expect(resolution.quiet).toBe(true);
  });

  it('rejects a channel that has not been approved', async () => {
    const resolution = await resolveDiscordContext({
      guildId: GUILD_A,
      channelId: CHANNEL_UNAPPROVED,
      userId: '900',
      memberRoleIds: ['role-support'],
    });

    expect(resolution.status).toBe('rejected');
    if (resolution.status === 'rejected') expect(resolution.reason).toMatch(/not approved/i);
  });

  it('rejects a direct message', async () => {
    const resolution = await resolveDiscordContext({
      guildId: null,
      channelId: '50',
      userId: '900',
      memberRoleIds: [],
    });
    expect(resolution.status).toBe('rejected');
  });

  it('rejects a user whose roles are not mapped', async () => {
    const resolution = await resolveDiscordContext({
      guildId: GUILD_A,
      channelId: CHANNEL_APPROVED,
      userId: '901',
      memberRoleIds: ['role-random'],
    });

    expect(resolution.status).toBe('rejected');
    if (resolution.status === 'rejected') expect(resolution.reason).toMatch(/not mapped/i);
  });

  it('records an audit event when a channel is refused', async () => {
    await resolveDiscordContext({
      guildId: GUILD_A,
      channelId: CHANNEL_UNAPPROVED,
      userId: '900',
      memberRoleIds: ['role-support'],
    });

    const events = await store.listEvents(ORG_A, 10);
    expect(events.some((event) => event.type === 'channel.rejected')).toBe(true);
  });
});

describe('role resolution', () => {
  it('takes the most capable mapped role', async () => {
    expect(await resolveRole(ORG_A, '900', ['role-support', 'role-admin'])).toBe('administrator');
  });

  it('prefers an explicit membership record over role mappings', async () => {
    await store.upsertMember({
      organizationId: ORG_A,
      role: 'viewer',
      discordUserId: '900',
      supabaseUserId: null,
      displayName: null,
    });
    expect(await resolveRole(ORG_A, '900', ['role-admin'])).toBe('viewer');
  });

  it('does not leak a role mapping across organizations', async () => {
    expect(await resolveRole(ORG_B, '900', ['role-admin'])).toBeNull();
  });
});

describe('organization isolation', () => {
  it('keeps requests and events scoped to their organization', async () => {
    const requestA = await store.createRequest({
      organizationId: ORG_A,
      actionType: 'SET_STATES',
      payload: {},
      status: 'PENDING',
    });
    await store.createRequest({
      organizationId: ORG_B,
      actionType: 'SET_STATES',
      payload: {},
      status: 'PENDING',
    });

    await store.addEvent({
      organizationId: ORG_A,
      requestId: requestA.id,
      type: 'request.created',
      message: 'A request was created.',
      data: null,
    });

    const requestsA = await store.listRequests({ organizationId: ORG_A });
    expect(requestsA).toHaveLength(1);
    expect(requestsA[0].organizationId).toBe(ORG_A);

    const eventsB = await store.listEvents(ORG_B, 10);
    expect(eventsB).toHaveLength(0);

    // A reference from one organization does not resolve inside another.
    expect(await store.getRequestByReference(ORG_B, requestA.reference)).toBeNull();
    expect(await store.getRequestByReference(ORG_A, requestA.reference)).not.toBeNull();
  });

  it('keeps state configurations and defaults scoped', async () => {
    await store.upsertStateConfiguration({
      organizationId: ORG_A,
      readymodeUserId: '101',
      username: 'mwebb',
      states: ['TX'],
      updatedBy: null,
    });
    await store.setDefaultStates(ORG_A, ['TX', 'VA']);

    expect(await store.listStateConfigurations(ORG_B)).toHaveLength(0);
    expect(await store.getStateConfiguration(ORG_B, '101')).toBeNull();
    expect(await store.getDefaultStates(ORG_B)).toEqual([]);
    expect(await store.getDefaultStates(ORG_A)).toEqual(['TX', 'VA']);
  });

  it('keeps stored credentials scoped', async () => {
    await store.upsertCredentials({
      organizationId: ORG_A,
      encryptedPassword: 'v1:a:b:c',
      username: 'admin',
      loginUrl: 'https://example.readymode.com',
      updatedAt: new Date().toISOString(),
    });

    expect(await store.getCredentials(ORG_B)).toBeNull();
    expect(await store.getCredentials(ORG_A)).not.toBeNull();
  });
});
