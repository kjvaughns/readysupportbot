import type { AccountRef } from '../domain/actions.js';
import { errorFor } from '../domain/errors.js';
import { normalizeForComparison } from '../util/text.js';
import type { ReadymodeAccount } from './port.js';

/**
 * Account matching.
 *
 * The rule that matters: never act on an account picked by a loose match. A
 * request naming "John" must not resolve to whichever John happens to sort
 * first. Identifiers are tried strongest first, and the moment one of them
 * produces exactly one account, that is the answer. If a tier produces more
 * than one, matching stops and the requester is asked to choose — it does not
 * fall through to a weaker tier and it does not guess.
 */

export type MatchKey = 'readymodeUserId' | 'username' | 'email' | 'fullName';

/** In priority order. A stronger key is never overridden by a weaker one. */
export const MATCH_PRIORITY: readonly MatchKey[] = [
  'readymodeUserId',
  'username',
  'email',
  'fullName',
];

export type MatchOutcome =
  | { kind: 'unique'; account: ReadymodeAccount; matchedBy: MatchKey }
  | { kind: 'none'; tried: MatchKey[] }
  | { kind: 'ambiguous'; matchedBy: MatchKey; candidates: ReadymodeAccount[] };

function valueFor(account: ReadymodeAccount, key: MatchKey): string | undefined {
  switch (key) {
    case 'readymodeUserId':
      return account.readymodeUserId;
    case 'username':
      return account.username;
    case 'email':
      return account.email;
    case 'fullName':
      return account.fullName;
  }
}

function refValueFor(ref: AccountRef, key: MatchKey): string | undefined {
  switch (key) {
    case 'readymodeUserId':
      return ref.readymodeUserId;
    case 'username':
      return ref.username;
    case 'email':
      return ref.email;
    case 'fullName':
      return ref.fullName;
  }
}

/**
 * A full name must carry at least two parts. The schema enforces this on the
 * way in; it is checked again here because matching is also called with names
 * read out of Readymode itself.
 */
function isUsableFullName(value: string): boolean {
  return value.trim().split(/\s+/).filter(Boolean).length >= 2;
}

/**
 * Resolve a reference against a candidate list.
 *
 * `candidates` is whatever the search returned — from the live interface, or
 * from the cached directory. Comparison is case- and whitespace-insensitive
 * but otherwise exact: no prefix matching, no fuzzy distance, no "closest".
 */
export function matchAccount(ref: AccountRef, candidates: ReadymodeAccount[]): MatchOutcome {
  const tried: MatchKey[] = [];

  for (const key of MATCH_PRIORITY) {
    const wanted = refValueFor(ref, key);
    if (!wanted) continue;
    if (key === 'fullName' && !isUsableFullName(wanted)) continue;

    tried.push(key);
    const target = normalizeForComparison(wanted);

    const hits = candidates.filter((candidate) => {
      const value = valueFor(candidate, key);
      return value !== undefined && normalizeForComparison(value) === target;
    });

    if (hits.length === 1) {
      return { kind: 'unique', account: hits[0] as ReadymodeAccount, matchedBy: key };
    }

    // More than one account answers to the strongest identifier the requester
    // gave. Falling back to a weaker one here would be exactly the guess this
    // function exists to prevent.
    if (hits.length > 1) {
      return { kind: 'ambiguous', matchedBy: key, candidates: hits };
    }
  }

  return { kind: 'none', tried };
}

/**
 * Resolve, or throw the right categorised error. Workflows call this so that
 * "found nobody" and "found several" always produce the same handling and the
 * same wording.
 */
export function requireUniqueMatch(
  ref: AccountRef,
  candidates: ReadymodeAccount[],
  describe: string,
): { account: ReadymodeAccount; matchedBy: MatchKey } {
  const outcome = matchAccount(ref, candidates);

  if (outcome.kind === 'unique') {
    return { account: outcome.account, matchedBy: outcome.matchedBy };
  }

  if (outcome.kind === 'ambiguous') {
    throw errorFor('AMBIGUOUS_MATCH', {
      message: `I could not complete this request because Readymode returned ${outcome.candidates.length} accounts matching ${describe}. Select the correct account below.`,
      details: {
        matchedBy: outcome.matchedBy,
        candidateCount: outcome.candidates.length,
        // Both halves are needed downstream: the label for the person
        // choosing, the key for rebuilding the request against one account.
        candidates: outcome.candidates.map((candidate) => ({
          key: candidateKey(candidate),
          label: summarize(candidate),
        })),
      },
    });
  }

  throw errorFor('NO_MATCH', {
    message: `I could not find an account matching ${describe}.`,
    details: { tried: outcome.tried },
  });
}

/** A short one-line description used in choice menus and audit details. */
export function summarize(account: ReadymodeAccount): string {
  const parts: string[] = [];
  if (account.fullName) parts.push(account.fullName);
  if (account.username) parts.push(`@${account.username}`);
  if (account.email) parts.push(account.email);
  if (account.readymodeUserId) parts.push(`id ${account.readymodeUserId}`);
  return parts.join(' • ') || 'unidentified account';
}

/**
 * A stable key for an account, used to reference a specific candidate when the
 * requester picks one from a menu. Prefers the strongest identifier available.
 */
export function candidateKey(account: ReadymodeAccount): string {
  if (account.readymodeUserId) return `id:${account.readymodeUserId}`;
  if (account.username) return `user:${account.username}`;
  if (account.email) return `mail:${account.email}`;
  return `name:${normalizeForComparison(account.fullName ?? '')}`;
}

/** Turn a chosen candidate back into the strongest possible reference. */
export function refFromAccount(account: ReadymodeAccount): AccountRef {
  if (account.readymodeUserId) return { readymodeUserId: account.readymodeUserId };
  if (account.username) return { username: account.username };
  if (account.email) return { email: account.email };
  return { fullName: account.fullName ?? '' };
}
