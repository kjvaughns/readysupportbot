/** Time helpers. All stored timestamps are UTC ISO-8601 strings. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoIn(milliseconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + milliseconds).toISOString();
}

export function minutes(count: number): number {
  return count * 60_000;
}

export function seconds(count: number): number {
  return count * 1_000;
}

/** True when `isoTimestamp` is in the past relative to `reference`. */
export function isExpired(isoTimestamp: string, reference: Date = new Date()): boolean {
  const expiry = Date.parse(isoTimestamp);
  if (Number.isNaN(expiry)) return true; // an unparseable expiry is treated as expired
  return expiry <= reference.getTime();
}

export function millisecondsUntil(isoTimestamp: string, reference: Date = new Date()): number {
  const target = Date.parse(isoTimestamp);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, target - reference.getTime());
}

/**
 * Format for Discord using its native timestamp markup, so each reader sees
 * the time in their own zone instead of the server's.
 */
export function discordTimestamp(iso: string, style: 't' | 'T' | 'f' | 'F' | 'R' = 'f'): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return 'unknown time';
  return `<t:${Math.floor(parsed / 1000)}:${style}>`;
}

/** Resolves after the given delay; used for polling backoff. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Race a promise against a deadline. On timeout the underlying work is left to
 * settle on its own — callers that need cancellation pass an AbortSignal to
 * the work itself.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
