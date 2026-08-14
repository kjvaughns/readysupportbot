import { describe, expect, it } from 'vitest';
import { candidateKey, matchAccount, refFromAccount, requireUniqueMatch, summarize } from '../../src/readymode/matching.js';
import { ReadySupportError } from '../../src/domain/errors.js';
import type { ReadymodeAccount } from '../../src/readymode/port.js';

const directory: ReadymodeAccount[] = [
  { readymodeUserId: '1001', username: 'jbrown', email: 'john.brown@example.com', fullName: 'John Brown' },
  { readymodeUserId: '1003', username: 'msmith', email: 'marcus.smith@example.com', fullName: 'Marcus Smith' },
  { readymodeUserId: '1004', username: 'msmith2', email: 'marcus2@example.com', fullName: 'Marcus Smith' },
];

describe('match priority', () => {
  it('prefers the Readymode user id', () => {
    const outcome = matchAccount({ readymodeUserId: '1004', username: 'jbrown' }, directory);
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') {
      expect(outcome.matchedBy).toBe('readymodeUserId');
      expect(outcome.account.username).toBe('msmith2');
    }
  });

  it('falls back to username when there is no id', () => {
    const outcome = matchAccount({ username: 'jbrown', email: 'someone.else@example.com' }, directory);
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') expect(outcome.matchedBy).toBe('username');
  });

  it('falls back to email when there is no id or username', () => {
    const outcome = matchAccount({ email: 'marcus.smith@example.com' }, directory);
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') expect(outcome.account.username).toBe('msmith');
  });

  it('uses a full name only when it is unique', () => {
    const unique = matchAccount({ fullName: 'John Brown' }, directory);
    expect(unique.kind).toBe('unique');

    const ambiguous = matchAccount({ fullName: 'Marcus Smith' }, directory);
    expect(ambiguous.kind).toBe('ambiguous');
    if (ambiguous.kind === 'ambiguous') expect(ambiguous.candidates).toHaveLength(2);
  });

  it('ignores case and extra whitespace', () => {
    const outcome = matchAccount({ fullName: '  john   BROWN ' }, directory);
    expect(outcome.kind).toBe('unique');
  });

  it('never matches on a first name alone', () => {
    const outcome = matchAccount({ fullName: 'Marcus' }, directory);
    expect(outcome.kind).toBe('none');
  });

  it('does not fall through to a weaker identifier when a stronger one is ambiguous', () => {
    // Two accounts share the username, and the email would identify one of
    // them. Falling through would silently pick that one — which is exactly
    // the guess the matcher exists to prevent.
    const shared: ReadymodeAccount[] = [
      { username: 'shared', email: 'a@example.com', fullName: 'Person A' },
      { username: 'shared', email: 'b@example.com', fullName: 'Person B' },
    ];

    const outcome = matchAccount({ username: 'shared', email: 'b@example.com' }, shared);
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind === 'ambiguous') expect(outcome.matchedBy).toBe('username');
  });

  it('reports nothing found when the directory is empty', () => {
    const outcome = matchAccount({ username: 'nobody' }, []);
    expect(outcome.kind).toBe('none');
    if (outcome.kind === 'none') expect(outcome.tried).toEqual(['username']);
  });

  it('does not match on a substring', () => {
    expect(matchAccount({ username: 'brown' }, directory).kind).toBe('none');
    expect(matchAccount({ email: 'example.com' }, directory).kind).toBe('none');
  });
});

describe('requireUniqueMatch', () => {
  it('returns the account when exactly one matches', () => {
    const { account, matchedBy } = requireUniqueMatch({ username: 'jbrown' }, directory, 'jbrown');
    expect(account.readymodeUserId).toBe('1001');
    expect(matchedBy).toBe('username');
  });

  it('throws AMBIGUOUS_MATCH with the candidates attached', () => {
    try {
      requireUniqueMatch({ fullName: 'Marcus Smith' }, directory, 'Marcus Smith');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ReadySupportError);
      const readySupportError = error as ReadySupportError;
      expect(readySupportError.category).toBe('AMBIGUOUS_MATCH');
      expect(readySupportError.userMessage).toMatch(/2 accounts matching Marcus Smith/);

      const candidates = readySupportError.details['candidates'] as Array<{ key: string; label: string }>;
      expect(candidates).toHaveLength(2);
      expect(candidates[0]?.key).toBe('id:1003');
      expect(candidates[0]?.label).toContain('Marcus Smith');
    }
  });

  it('throws NO_MATCH when nothing matches', () => {
    try {
      requireUniqueMatch({ username: 'nobody' }, directory, 'nobody');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ReadySupportError).category).toBe('NO_MATCH');
    }
  });
});

describe('candidate keys', () => {
  it('uses the strongest identifier available', () => {
    expect(candidateKey({ readymodeUserId: '7', username: 'u', email: 'e@x.com' })).toBe('id:7');
    expect(candidateKey({ username: 'u', email: 'e@x.com' })).toBe('user:u');
    expect(candidateKey({ email: 'e@x.com' })).toBe('mail:e@x.com');
    expect(candidateKey({ fullName: 'Jane Doe' })).toBe('name:jane doe');
  });

  it('round-trips into a reference that will match uniquely', () => {
    const chosen = directory[2] as ReadymodeAccount;
    const ref = refFromAccount(chosen);

    const outcome = matchAccount(ref, directory);
    expect(outcome.kind).toBe('unique');
    if (outcome.kind === 'unique') expect(outcome.account.username).toBe('msmith2');
  });

  it('summarises an account for a choice menu', () => {
    expect(summarize(directory[0] as ReadymodeAccount)).toBe(
      'John Brown • @jbrown • john.brown@example.com • id 1001',
    );
  });
});
