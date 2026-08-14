/**
 * Human-facing request references.
 *
 * Requests carry two identifiers: a UUID primary key used everywhere
 * internally, and a short sequential reference (`RS-1048`) that a person can
 * read out loud. The sequence lives in Postgres so it stays unique and
 * monotonic across restarts and multiple instances.
 */

export const REFERENCE_PREFIX = 'RS';

export function formatReference(sequence: number): string {
  return `${REFERENCE_PREFIX}-${sequence}`;
}

const REFERENCE_PATTERN = new RegExp(`^${REFERENCE_PREFIX}[\\s-]?(\\d+)$`, 'i');

/** Parse `RS-1048`, `RS 1048` or `rs1048` back to its sequence number. */
export function parseReference(value: string): number | undefined {
  const match = REFERENCE_PATTERN.exec(value.trim());
  if (!match?.[1]) return undefined;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Opaque nonce bound into approval button ids so clicks cannot be forged. */
export function newNonce(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 16);
}

export function newUuid(): string {
  return crypto.randomUUID();
}
