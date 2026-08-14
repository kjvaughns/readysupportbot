import { describe, expect, it } from 'vitest';
import { actionSchema, buildAction, toAgentTarget } from '../src/openai/schema';
import { fallbackParse } from '../src/openai/fallback';

/**
 * The model's output is never trusted. These cover the boundary: a well-formed
 * answer becomes an action, anything incomplete becomes a question, and
 * anything outside the closed set is refused.
 */

function output(overrides: Record<string, unknown> = {}) {
  return {
    action: 'SET_STATES',
    target: { kind: 'self', value: null },
    source: null,
    states: ['TX', 'VA', 'OH'],
    campaigns: null,
    queues: null,
    accounts: null,
    limit: null,
    clarification: null,
    reason: null,
    ...overrides,
  } as any;
}

describe('action schema validation', () => {
  it('accepts a complete state change and normalizes the states', () => {
    const parsed = buildAction(output({ states: ['texas', 'VA', 'ohio'] }));
    expect(parsed.status).toBe('ok');
    if (parsed.action?.action === 'SET_STATES') {
      expect(parsed.action.states).toEqual(['OH', 'TX', 'VA']);
      expect(parsed.action.target).toEqual({ kind: 'self' });
    }
  });

  it('rejects a state value that is not a United States state', () => {
    const parsed = buildAction(output({ states: ['TX', 'Ontario'] }));
    expect(parsed.status).toBe('needs_information');
    expect(parsed.message).toMatch(/Ontario/);
  });

  it('asks which agent when no target was given', () => {
    const parsed = buildAction(output({ target: null }));
    expect(parsed.status).toBe('needs_information');
    expect(parsed.message).toMatch(/which agent/i);
  });

  it('asks which states when none were given', () => {
    const parsed = buildAction(output({ states: null }));
    expect(parsed.status).toBe('needs_information');
  });

  it('passes a clarification straight through', () => {
    const parsed = buildAction(output({ clarification: 'Which agent did you mean?' }));
    expect(parsed.status).toBe('needs_information');
    expect(parsed.message).toBe('Which agent did you mean?');
  });

  it('reports an unsupported request rather than improvising', () => {
    const parsed = buildAction(
      output({ action: 'UNSUPPORTED', reason: 'That is not a supported action.', states: null, target: null }),
    );
    expect(parsed.status).toBe('unsupported');
  });

  it('requires both ends of a copy', () => {
    const parsed = buildAction(
      output({ action: 'COPY_STATE_CONFIGURATION', states: null, source: null }),
    );
    expect(parsed.status).toBe('needs_information');

    const complete = buildAction(
      output({
        action: 'COPY_STATE_CONFIGURATION',
        states: null,
        source: { kind: 'name', value: 'Marcus Webb' },
        target: { kind: 'name', value: 'Michael Ross' },
      }),
    );
    expect(complete.status).toBe('ok');
  });

  it('refuses an action outside the supported set', () => {
    expect(actionSchema.safeParse({ action: 'DELETE_EVERYTHING' }).success).toBe(false);
    expect(actionSchema.safeParse({ action: 'SET_STATES', target: { kind: 'self' } }).success).toBe(
      false,
    );
  });

  it('widens the model target shape only for known kinds', () => {
    expect(toAgentTarget({ kind: 'self', value: null })).toEqual({ kind: 'self' });
    expect(toAgentTarget({ kind: 'email', value: 'a@b.com' })).toEqual({
      kind: 'email',
      email: 'a@b.com',
    });
    expect(toAgentTarget({ kind: 'email', value: 'not-an-email' })).toBeNull();
    expect(toAgentTarget({ kind: 'browser', value: 'do something' })).toBeNull();
    expect(toAgentTarget({ kind: 'username', value: '   ' })).toBeNull();
  });
});

describe('rule-based parser used when OpenAI is unavailable', () => {
  it('reads a self-directed state change', () => {
    const parsed = buildAction(
      fallbackParse('can you set it up where I am only receiving TX, VA, and OH states?'),
    );
    expect(parsed.status).toBe('ok');
    if (parsed.action?.action === 'SET_STATES') {
      expect(parsed.action.states).toEqual(['OH', 'TX', 'VA']);
      expect(parsed.action.target).toEqual({ kind: 'self' });
    }
  });

  it('reads an add', () => {
    const parsed = buildAction(fallbackParse('add Florida to my states'));
    expect(parsed.action?.action).toBe('ADD_STATES');
    if (parsed.action?.action === 'ADD_STATES') expect(parsed.action.states).toEqual(['FL']);
  });

  it('reads a remove for a mentioned Discord user', () => {
    const parsed = buildAction(fallbackParse('remove California from <@123456789012345678> states'));
    expect(parsed.action?.action).toBe('REMOVE_STATES');
    if (parsed.action?.action === 'REMOVE_STATES') {
      expect(parsed.action.states).toEqual(['CA']);
      expect(parsed.action.target).toEqual({
        kind: 'discord_user',
        discordUserId: '123456789012345678',
      });
    }
  });

  it('asks who a request is for rather than guessing', () => {
    const parsed = buildAction(fallbackParse('set states to TX and VA'));
    expect(parsed.status).toBe('needs_information');
  });

  it('recognizes the read-only requests', () => {
    expect(buildAction(fallbackParse('help')).action?.action).toBe('HELP');
    expect(buildAction(fallbackParse('what is the connection status?')).action?.action).toBe(
      'CONNECTION_STATUS',
    );
    expect(buildAction(fallbackParse('show recent actions')).action?.action).toBe('RECENT_ACTIONS');
    expect(buildAction(fallbackParse('who is using a license right now')).action?.action).toBe(
      'LICENSE_USAGE',
    );
  });

  it('refuses anything outside the supported set', () => {
    const parsed = buildAction(fallbackParse('please transfer money to my account'));
    expect(parsed.status).toBe('unsupported');
  });
});
