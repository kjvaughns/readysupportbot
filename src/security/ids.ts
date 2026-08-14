import { createHash, randomUUID } from 'node:crypto';

/** Opaque identifier used for correlating a request across logs and Discord. */
export function newRequestId(): string {
  return randomUUID();
}

let referenceCounter = Math.floor(Math.random() * 1000);

/**
 * Human-facing reference shown in Discord, for example `RS 1048`. Uniqueness is
 * guaranteed by the database; this is the display form.
 */
export function newReference(): string {
  referenceCounter = (referenceCounter + 1) % 100000;
  const value = 1000 + referenceCounter;
  return `RS ${value}`;
}

/**
 * Stable key used to collapse duplicate requests. The same actor asking for the
 * same action with the same arguments inside the dedupe window is one request.
 */
export function dedupeKey(parts: {
  organizationId: string;
  actorId: string;
  actionType: string;
  payload: unknown;
}): string {
  const canonical = JSON.stringify(canonicalize(parts.payload));
  return createHash('sha256')
    .update(`${parts.organizationId}|${parts.actorId}|${parts.actionType}|${canonical}`)
    .digest('hex');
}

/** Sorts object keys so semantically identical payloads hash identically. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
