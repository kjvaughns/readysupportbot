/**
 * Personal data scrubbing.
 *
 * A sibling of `redaction.ts`: that module removes secrets (passwords, tokens,
 * keys), this one removes information about people. Interface discovery reads
 * real Readymode pages, and those pages carry lead names, phone numbers,
 * addresses and account numbers. None of it is needed to identify a control, so
 * none of it is kept.
 *
 * The rule this enforces: evidence describes the *shape* of the interface, never
 * the data inside it.
 */

export const PII_PLACEHOLDER = '[personal-data-removed]';

interface PiiPattern {
  label: string;
  pattern: RegExp;
  /** Optional extra test to cut false positives. */
  accept?: (match: string) => boolean;
}

/** Digits-only Luhn check, so ordinary long identifiers are not mistaken for cards. */
function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

const PATTERNS: PiiPattern[] = [
  { label: 'email', pattern: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  {
    // Bounded on both sides: an unbounded run of ten digits also matches the
    // middle of an element id like `ctl00_user_1234567890`, and scrubbing that
    // would corrupt the selector built from it.
    label: 'phone',
    pattern: /(?<![\w-])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![\w-])/g,
  },
  { label: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: 'card', pattern: /\b(?:\d[ -]?){13,19}\b/g, accept: luhn },
  {
    label: 'street',
    pattern:
      /\b\d{1,6}\s+[A-Za-z][A-Za-z.\s]{2,30}\s(?:st|street|ave|avenue|rd|road|blvd|ln|lane|dr|drive|ct|court|way|pl|place)\b/gi,
  },
  {
    label: 'date_of_birth',
    pattern: /\b(?:0?[1-9]|1[0-2])[/-](?:0?[1-9]|[12]\d|3[01])[/-](?:19|20)\d{2}\b/g,
  },
];

/**
 * Long digit runs are usually account or member numbers, but they also appear
 * inside element ids and form field names. Scrubbing those would corrupt the
 * selectors discovery is trying to build, so this rule applies to free text
 * only — never to structural identifiers.
 */
const LOOSE_PATTERNS: PiiPattern[] = [{ label: 'long_number', pattern: /\b\d{9,}\b/g }];

/** Keys that hold structural identity rather than content. */
const STRUCTURAL_KEYS = new Set([
  'id',
  'name',
  'tag',
  'type',
  'cssPath',
  'attrs',
  'method',
  'ordinal',
  'rootName',
  'inputNames',
]);

export interface PiiScrubResult {
  text: string;
  /** Labels of the categories that were removed. */
  dropped: string[];
}

/**
 * Replaces anything that looks like personal data with a placeholder.
 *
 * `structural` narrows the rules to those that cannot collide with element ids
 * and field names.
 */
export function scrubPersonalData(
  value: string,
  options: { structural?: boolean } = {},
): PiiScrubResult {
  let text = String(value ?? '');
  const dropped = new Set<string>();
  const rules = options.structural ? PATTERNS : [...PATTERNS, ...LOOSE_PATTERNS];

  for (const { label, pattern, accept } of rules) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (match) => {
      if (accept && !accept(match)) return match;
      dropped.add(label);
      return PII_PLACEHOLDER;
    });
  }

  return { text, dropped: [...dropped] };
}

export function containsPersonalData(value: string): boolean {
  return scrubPersonalData(value).dropped.length > 0;
}

/** Convenience for the common case where only the cleaned text is wanted. */
export function withoutPersonalData(value: string): string {
  return scrubPersonalData(value).text;
}

/**
 * Walks a structure and scrubs every string in it. Used as a final guard before
 * evidence is stored or returned, so a field added later cannot leak by being
 * forgotten.
 */
export function scrubDeep<T>(
  value: T,
  counter?: { dropped: number },
  structural = false,
): T {
  if (typeof value === 'string') {
    const result = scrubPersonalData(value, { structural });
    if (counter && result.dropped.length > 0) counter.dropped += result.dropped.length;
    return result.text as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => scrubDeep(entry, counter, structural)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // Identifiers keep their shape; only their genuine-PII patterns are removed.
      output[key] = scrubDeep(entry, counter, structural || STRUCTURAL_KEYS.has(key));
    }
    return output as unknown as T;
  }
  return value;
}
