import { describe, expect, it } from 'vitest';
import {
  accountRefSchema,
  createAccountSchema,
  describeTarget,
  isMutating,
  listRecentActionsSchema,
  structuredActionSchema,
} from '../../src/domain/actions.js';

describe('account references', () => {
  it('needs at least one identifier', () => {
    const result = accountRefSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('refuses a first name on its own', () => {
    const result = accountRefSchema.safeParse({ fullName: 'Sarah' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/first and last name/i);
    }
  });

  it('accepts a full first and last name', () => {
    const result = accountRefSchema.safeParse({ fullName: 'Sarah Garcia' });
    expect(result.success).toBe(true);
  });

  it('lowercases emails so matching is case-insensitive', () => {
    const result = accountRefSchema.parse({ email: '  John.Brown@Example.COM ' });
    expect(result.email).toBe('john.brown@example.com');
  });

  it('rejects a malformed email', () => {
    expect(accountRefSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });

  it('rejects a username with spaces or symbols', () => {
    expect(accountRefSchema.safeParse({ username: 'john brown' }).success).toBe(false);
    expect(accountRefSchema.safeParse({ username: 'john;drop' }).success).toBe(false);
    expect(accountRefSchema.safeParse({ username: 'john.brown-1_x' }).success).toBe(true);
  });
});

describe('create account', () => {
  const valid = {
    action: 'CREATE_ACCOUNT' as const,
    firstName: 'Marcus',
    lastName: 'Smith',
    email: 'marcus@example.com',
    username: 'msmith',
    agentRole: 'Agent',
    licenseType: 'Standard',
  };

  it('accepts the six required fields', () => {
    const result = createAccountSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.active).toBe(true);
  });

  it.each(['firstName', 'lastName', 'email', 'username', 'agentRole', 'licenseType'] as const)(
    'refuses when %s is missing',
    (field) => {
      const incomplete: Record<string, unknown> = { ...valid };
      delete incomplete[field];
      expect(createAccountSchema.safeParse(incomplete).success).toBe(false);
    },
  );

  it('treats team, campaign and queue as optional', () => {
    const result = createAccountSchema.safeParse({ ...valid, team: 'Team A', campaign: 'Vantage' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.campaign).toBe('Vantage');
      expect(result.data.queue).toBeUndefined();
    }
  });

  it('rejects a name carrying a newline', () => {
    const result = createAccountSchema.safeParse({ ...valid, firstName: 'Marcus\nAdmin' });
    expect(result.success).toBe(false);
  });

  it('rejects a name carrying a control character', () => {
    const result = createAccountSchema.safeParse({
      ...valid,
      lastName: `Smith${String.fromCharCode(7)}`,
    });
    expect(result.success).toBe(false);
  });

  it('accepts names with apostrophes, hyphens and accents', () => {
    const result = createAccountSchema.safeParse({
      ...valid,
      firstName: "Renée",
      lastName: "O'Brien-García",
    });
    expect(result.success).toBe(true);
  });

  it('refuses a short administrator-supplied password', () => {
    expect(createAccountSchema.safeParse({ ...valid, temporaryPassword: 'short' }).success).toBe(false);
  });
});

describe('the structured action union', () => {
  it('rejects an action name that is not supported', () => {
    expect(structuredActionSchema.safeParse({ action: 'DELETE_EVERYTHING' }).success).toBe(false);
  });

  it('knows which actions change something', () => {
    expect(isMutating('CREATE_ACCOUNT')).toBe(true);
    expect(isMutating('DEACTIVATE_ACCOUNT')).toBe(true);
    expect(isMutating('CHECK_AGENT_STATUS')).toBe(false);
    expect(isMutating('LIST_RECENT_ACTIONS')).toBe(false);
  });

  it('caps how many recent actions can be asked for', () => {
    expect(listRecentActionsSchema.safeParse({ action: 'LIST_RECENT_ACTIONS', limit: 500 }).success).toBe(false);
    expect(listRecentActionsSchema.parse({ action: 'LIST_RECENT_ACTIONS' }).limit).toBe(10);
  });

  it('describes the target for the confirmation embed', () => {
    expect(
      describeTarget({
        action: 'CREATE_ACCOUNT',
        firstName: 'Marcus',
        lastName: 'Smith',
        email: 'm@example.com',
        username: 'msmith',
        agentRole: 'Agent',
        licenseType: 'Standard',
        active: true,
      }),
    ).toBe('Marcus Smith (msmith)');

    expect(
      describeTarget({
        action: 'CLEAR_LICENSE',
        target: { username: 'jbrown' },
        overrideActiveCall: false,
      }),
    ).toBe('jbrown');
  });
});
