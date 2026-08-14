import { ValidationError } from '../security/errors';

/**
 * Canonical list of the fifty United States plus Washington, DC.
 *
 * Every state value that enters the system — from Discord, from the model, from
 * the frontend, or read back out of Readymode — is normalized to a postal
 * abbreviation through this table. Values that do not resolve to exactly one
 * entry are rejected rather than guessed.
 */
export const US_STATES: ReadonlyArray<{ abbr: string; name: string }> = [
  { abbr: 'AL', name: 'Alabama' },
  { abbr: 'AK', name: 'Alaska' },
  { abbr: 'AZ', name: 'Arizona' },
  { abbr: 'AR', name: 'Arkansas' },
  { abbr: 'CA', name: 'California' },
  { abbr: 'CO', name: 'Colorado' },
  { abbr: 'CT', name: 'Connecticut' },
  { abbr: 'DE', name: 'Delaware' },
  { abbr: 'DC', name: 'Washington, DC' },
  { abbr: 'FL', name: 'Florida' },
  { abbr: 'GA', name: 'Georgia' },
  { abbr: 'HI', name: 'Hawaii' },
  { abbr: 'ID', name: 'Idaho' },
  { abbr: 'IL', name: 'Illinois' },
  { abbr: 'IN', name: 'Indiana' },
  { abbr: 'IA', name: 'Iowa' },
  { abbr: 'KS', name: 'Kansas' },
  { abbr: 'KY', name: 'Kentucky' },
  { abbr: 'LA', name: 'Louisiana' },
  { abbr: 'ME', name: 'Maine' },
  { abbr: 'MD', name: 'Maryland' },
  { abbr: 'MA', name: 'Massachusetts' },
  { abbr: 'MI', name: 'Michigan' },
  { abbr: 'MN', name: 'Minnesota' },
  { abbr: 'MS', name: 'Mississippi' },
  { abbr: 'MO', name: 'Missouri' },
  { abbr: 'MT', name: 'Montana' },
  { abbr: 'NE', name: 'Nebraska' },
  { abbr: 'NV', name: 'Nevada' },
  { abbr: 'NH', name: 'New Hampshire' },
  { abbr: 'NJ', name: 'New Jersey' },
  { abbr: 'NM', name: 'New Mexico' },
  { abbr: 'NY', name: 'New York' },
  { abbr: 'NC', name: 'North Carolina' },
  { abbr: 'ND', name: 'North Dakota' },
  { abbr: 'OH', name: 'Ohio' },
  { abbr: 'OK', name: 'Oklahoma' },
  { abbr: 'OR', name: 'Oregon' },
  { abbr: 'PA', name: 'Pennsylvania' },
  { abbr: 'RI', name: 'Rhode Island' },
  { abbr: 'SC', name: 'South Carolina' },
  { abbr: 'SD', name: 'South Dakota' },
  { abbr: 'TN', name: 'Tennessee' },
  { abbr: 'TX', name: 'Texas' },
  { abbr: 'UT', name: 'Utah' },
  { abbr: 'VT', name: 'Vermont' },
  { abbr: 'VA', name: 'Virginia' },
  { abbr: 'WA', name: 'Washington' },
  { abbr: 'WV', name: 'West Virginia' },
  { abbr: 'WI', name: 'Wisconsin' },
  { abbr: 'WY', name: 'Wyoming' },
];

export const STATE_ABBREVIATIONS: readonly string[] = US_STATES.map((state) => state.abbr);

const BY_ABBR = new Map(US_STATES.map((state) => [state.abbr, state]));

/** Full names and accepted spellings, all lower case, mapped to abbreviations. */
const BY_NAME = new Map<string, string>();
for (const state of US_STATES) {
  BY_NAME.set(state.name.toLowerCase(), state.abbr);
}

/**
 * Additional accepted spellings. "Washington" alone is the state, never DC —
 * DC has to be named explicitly, so an ambiguous value is never guessed.
 */
const ALIASES: Record<string, string> = {
  'district of columbia': 'DC',
  'washington dc': 'DC',
  'washington d.c.': 'DC',
  'washington d c': 'DC',
  'd.c.': 'DC',
  'dc': 'DC',
  'washington state': 'WA',
  'wash': 'WA',
  'calif': 'CA',
  'cali': 'CA',
  'penn': 'PA',
  'pennsylvania.': 'PA',
  'mass': 'MA',
  'n carolina': 'NC',
  'n. carolina': 'NC',
  's carolina': 'SC',
  's. carolina': 'SC',
  'n dakota': 'ND',
  'n. dakota': 'ND',
  's dakota': 'SD',
  's. dakota': 'SD',
  'w virginia': 'WV',
  'w. virginia': 'WV',
  'new hamphire': 'NH',
  'tex': 'TX',
  'fla': 'FL',
};

/** Values that resolve to more than one state and must be rejected. */
const AMBIGUOUS = new Set(['virginia or west virginia', 'carolina', 'dakota', 'north', 'south']);

export interface StateNormalizationResult {
  states: string[];
  invalid: string[];
}

function cleanToken(raw: string): string {
  return String(raw ?? '')
    .replace(/[^\p{L}\p{N}.,'\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalizes a single value. Returns null when it does not resolve. */
export function normalizeState(value: string): string | null {
  const cleaned = cleanToken(value);
  if (!cleaned) return null;

  const lower = cleaned.toLowerCase().replace(/\.$/, '');
  if (AMBIGUOUS.has(lower)) return null;

  const upper = cleaned.toUpperCase().replace(/[^A-Z]/g, '');
  if (upper.length === 2 && BY_ABBR.has(upper)) return upper;

  const byName = BY_NAME.get(lower);
  if (byName) return byName;

  const alias = ALIASES[lower];
  if (alias) return alias;

  // "Texas state", "state of Texas".
  const stripped = lower
    .replace(/^state of\s+/, '')
    .replace(/\s+state$/, '')
    .trim();
  if (stripped !== lower) {
    const retry = BY_NAME.get(stripped) ?? ALIASES[stripped];
    if (retry) return retry;
  }

  return null;
}

/**
 * Splits and normalizes a free-form list such as "TX, VA and Ohio".
 * Duplicates collapse; order follows the canonical list so audit records and
 * Discord replies are stable.
 */
export function normalizeStateList(input: string | string[]): StateNormalizationResult {
  const raw = Array.isArray(input) ? input : splitStateList(input);
  const states = new Set<string>();
  const invalid: string[] = [];

  for (const token of raw) {
    const trimmed = cleanToken(token);
    if (!trimmed) continue;
    const normalized = normalizeState(trimmed);
    if (normalized) states.add(normalized);
    else invalid.push(trimmed);
  }

  return { states: sortStates([...states]), invalid };
}

function splitStateList(input: string): string[] {
  return String(input ?? '')
    .replace(/\band\b/gi, ',')
    .replace(/[/|;]/g, ',')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Throws a validation error listing every value that could not be resolved. */
export function requireStates(input: string | string[]): string[] {
  const { states, invalid } = normalizeStateList(input);
  if (invalid.length > 0) {
    throw new ValidationError(
      `These values are not recognized United States states: ${invalid.join(', ')}.`,
      { invalid },
    );
  }
  if (states.length === 0) {
    throw new ValidationError('No states were provided.');
  }
  return states;
}

/** Canonical ordering, matching the order of US_STATES. */
export function sortStates(states: string[]): string[] {
  const index = new Map(STATE_ABBREVIATIONS.map((abbr, position) => [abbr, position]));
  return [...new Set(states)].sort(
    (a, b) => (index.get(a) ?? 999) - (index.get(b) ?? 999),
  );
}

export function stateName(abbr: string): string {
  return BY_ABBR.get(abbr)?.name ?? abbr;
}

export interface StateDiff {
  previous: string[];
  next: string[];
  added: string[];
  removed: string[];
  unchanged: string[];
  changed: boolean;
}

/** The difference stored in the audit record for every state change. */
export function diffStates(previous: string[], next: string[]): StateDiff {
  const before = sortStates(previous ?? []);
  const after = sortStates(next ?? []);
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  const added = after.filter((state) => !beforeSet.has(state));
  const removed = before.filter((state) => !afterSet.has(state));
  const unchanged = after.filter((state) => beforeSet.has(state));

  return {
    previous: before,
    next: after,
    added,
    removed,
    unchanged,
    changed: added.length > 0 || removed.length > 0,
  };
}

/** Applies an operation to the current assignment and returns the target set. */
export function applyStateOperation(
  operation: 'SET_STATES' | 'ADD_STATES' | 'REMOVE_STATES',
  current: string[],
  requested: string[],
): string[] {
  const currentStates = sortStates(current ?? []);
  const requestedStates = sortStates(requested ?? []);

  switch (operation) {
    case 'SET_STATES':
      return requestedStates;
    case 'ADD_STATES':
      return sortStates([...currentStates, ...requestedStates]);
    case 'REMOVE_STATES': {
      const remove = new Set(requestedStates);
      return currentStates.filter((state) => !remove.has(state));
    }
    default:
      throw new ValidationError('Unsupported state operation.');
  }
}

/** Formats a list for Discord, for example "TX, VA, OH" or "none". */
export function formatStates(states: string[]): string {
  const sorted = sortStates(states ?? []);
  return sorted.length > 0 ? sorted.join(', ') : 'none';
}
