import { describe, expect, it } from 'vitest';
import { describeMatchFailure, matchAgent } from '../src/readymode/agents';
import { LinkedAgent, ReadymodeAgent } from '../src/types';

const agents: ReadymodeAgent[] = [
  {
    readymodeUserId: '101',
    username: 'mwebb',
    fullName: 'Marcus Webb',
    email: 'marcus.webb@example.com',
  },
  {
    readymodeUserId: '102',
    username: 'mwebb2',
    fullName: 'Marcus Webber',
    email: 'marcus.webber@example.com',
  },
  {
    readymodeUserId: '103',
    username: 'schen',
    fullName: 'Sarah Chen',
    email: 'sarah.chen@example.com',
  },
  {
    readymodeUserId: '104',
    username: 'schen2',
    fullName: 'Sarah Chen',
    email: 'sarah.chen2@example.com',
  },
];

const linkedAgents: LinkedAgent[] = [
  {
    id: 'l1',
    organizationId: 'org',
    discordUserId: '900',
    readymodeUserId: '101',
    username: 'mwebb',
    fullName: 'Marcus Webb',
    email: 'marcus.webb@example.com',
  },
  {
    id: 'l2',
    organizationId: 'org',
    discordUserId: '901',
    readymodeUserId: '103',
    username: 'schen',
    fullName: 'Sarah Chen',
    email: null,
  },
  {
    id: 'l3',
    organizationId: 'org',
    discordUserId: '901',
    readymodeUserId: '104',
    username: 'schen2',
    fullName: 'Sarah Chen',
    email: null,
  },
];

const context = { agents, linkedAgents, requesterDiscordUserId: '900' };

describe('agent matching', () => {
  it('matches on Readymode user id', () => {
    const match = matchAgent({ kind: 'readymode_user_id', readymodeUserId: '103' }, context);
    expect(match.status).toBe('unique');
    if (match.status === 'unique') {
      expect(match.agent.username).toBe('schen');
      expect(match.strategy).toBe('readymode_user_id');
    }
  });

  it('matches on an exact username', () => {
    const match = matchAgent({ kind: 'username', username: 'MWEBB' }, context);
    expect(match.status).toBe('unique');
    if (match.status === 'unique') expect(match.agent.readymodeUserId).toBe('101');
  });

  it('does not match a username by prefix', () => {
    expect(matchAgent({ kind: 'username', username: 'mwe' }, context).status).toBe('not_found');
  });

  it('matches on an exact email address', () => {
    const match = matchAgent({ kind: 'email', email: 'Sarah.Chen@example.com' }, context);
    expect(match.status).toBe('unique');
    if (match.status === 'unique') expect(match.agent.readymodeUserId).toBe('103');
  });

  it('never acts on a first name alone', () => {
    const match = matchAgent({ kind: 'name', name: 'Marcus' }, context);
    expect(match.status).toBe('needs_full_name');
    expect(describeMatchFailure(match)).toMatch(/only part of a name/i);
  });

  it('matches a unique exact full name', () => {
    const match = matchAgent({ kind: 'name', name: 'marcus webb' }, context);
    expect(match.status).toBe('unique');
    if (match.status === 'unique') expect(match.agent.readymodeUserId).toBe('101');
  });

  it('stops when a full name matches more than one account', () => {
    const match = matchAgent({ kind: 'name', name: 'Sarah Chen' }, context);
    expect(match.status).toBe('ambiguous');
    if (match.status === 'ambiguous') expect(match.candidates).toHaveLength(2);
    expect(describeMatchFailure(match)).toMatch(/More than one/i);
  });

  it('resolves "me" through the linked Discord account', () => {
    const match = matchAgent({ kind: 'self' }, context);
    expect(match.status).toBe('unique');
    if (match.status === 'unique') {
      expect(match.agent.username).toBe('mwebb');
      expect(match.strategy).toBe('linked_discord_user');
    }
  });

  it('refuses to assume identity when the Discord user is not linked', () => {
    const match = matchAgent({ kind: 'self' }, { ...context, requesterDiscordUserId: '999' });
    expect(match.status).toBe('not_linked');
    expect(describeMatchFailure(match)).toMatch(/not linked to exactly one/i);
  });

  it('refuses to assume identity when the Discord user has several accounts', () => {
    const match = matchAgent({ kind: 'self' }, { ...context, requesterDiscordUserId: '901' });
    expect(match.status).toBe('ambiguous');
  });

  it('resolves another Discord user through their link', () => {
    const match = matchAgent({ kind: 'discord_user', discordUserId: '900' }, context);
    expect(match.status).toBe('unique');
  });

  it('reports not found when nothing matches', () => {
    const match = matchAgent({ kind: 'name', name: 'Nobody Here' }, context);
    expect(match.status).toBe('not_found');
  });
});
