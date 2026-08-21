import { SelectorStrategy } from './index';

/**
 * JSON-safe form of a selector strategy.
 *
 * Strategies may carry regular expressions, which do not survive JSON. They are
 * stored as `{ __regex: { source, flags } }` and rehydrated on the way back.
 *
 * A strategy read from the database is *data*, not code: rehydration validates
 * it, because an attacker-supplied or corrupted pattern would otherwise become a
 * regular-expression denial of service inside the backend.
 */

export interface SerializedRegex {
  __regex: { source: string; flags: string };
}

export type SerializedValue = string | SerializedRegex;
export type SerializedStrategy = Record<string, unknown>;

const MAX_REGEX_SOURCE = 200;
const ALLOWED_FLAGS = /^[gimsuy]*$/;

function isRegex(value: unknown): value is RegExp {
  return value instanceof RegExp;
}

function encodeValue(value: unknown): unknown {
  if (isRegex(value)) return { __regex: { source: value.source, flags: value.flags } };
  return value;
}

function decodeValue(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    '__regex' in (value as Record<string, unknown>)
  ) {
    const raw = (value as SerializedRegex).__regex;
    if (!raw || typeof raw.source !== 'string' || typeof raw.flags !== 'string') {
      throw new Error('Malformed serialized pattern.');
    }
    if (raw.source.length > MAX_REGEX_SOURCE) {
      throw new Error('Stored pattern is too long to be safe.');
    }
    if (!ALLOWED_FLAGS.test(raw.flags)) {
      throw new Error('Stored pattern uses unsupported flags.');
    }
    return new RegExp(raw.source, raw.flags);
  }
  return value;
}

export function serializeStrategy(strategy: SelectorStrategy): SerializedStrategy {
  const output: SerializedStrategy = {};
  for (const [key, value] of Object.entries(strategy)) {
    output[key] = encodeValue(value);
  }
  return output;
}

const VALID_TYPES = new Set(['testId', 'rowControl', 'role', 'label', 'placeholder', 'text', 'css']);

export function deserializeStrategy(raw: unknown): SelectorStrategy {
  if (!raw || typeof raw !== 'object') throw new Error('Stored selector is not an object.');

  const record = raw as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
    throw new Error('Stored selector has an unrecognized type.');
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    output[key] = decodeValue(value);
  }
  return output as SelectorStrategy;
}

/** Deserializes without throwing, for callers that must degrade gracefully. */
export function tryDeserializeStrategy(raw: unknown): SelectorStrategy | null {
  try {
    return deserializeStrategy(raw);
  } catch {
    return null;
  }
}
