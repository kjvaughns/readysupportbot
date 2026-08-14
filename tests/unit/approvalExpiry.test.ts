import { describe, expect, it } from 'vitest';
import { discordTimestamp, isExpired, millisecondsUntil, minutes, withTimeout } from '../../src/util/time.js';
import { decodeComponentId, encodeComponentId } from '../../src/discord/customIds.js';
import { newNonce } from '../../src/util/ids.js';
import { safeEquals } from '../../src/security/crypto.js';

describe('approval expiry', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');

  it('treats a window that has passed as expired', () => {
    const expiresAt = new Date(now.getTime() - 1_000).toISOString();
    expect(isExpired(expiresAt, now)).toBe(true);
  });

  it('treats a window still open as live', () => {
    const expiresAt = new Date(now.getTime() + minutes(10)).toISOString();
    expect(isExpired(expiresAt, now)).toBe(false);
    expect(millisecondsUntil(expiresAt, now)).toBe(minutes(10));
  });

  it('expires exactly on the boundary rather than a moment after', () => {
    expect(isExpired(now.toISOString(), now)).toBe(true);
  });

  it('treats an unreadable expiry as expired', () => {
    // Failing closed matters here: a corrupt timestamp must not leave an
    // approval valid forever.
    expect(isExpired('not-a-timestamp', now)).toBe(true);
    expect(isExpired('', now)).toBe(true);
  });

  it('never reports negative time remaining', () => {
    expect(millisecondsUntil(new Date(now.getTime() - minutes(5)).toISOString(), now)).toBe(0);
  });

  it('renders the deadline in the reader own timezone', () => {
    expect(discordTimestamp('2026-01-01T12:00:00.000Z', 'R')).toBe('<t:1767268800:R>');
    expect(discordTimestamp('nonsense')).toBe('unknown time');
  });
});

describe('approval button ids', () => {
  it('round-trips', () => {
    const id = { kind: 'approve' as const, requestId: crypto.randomUUID(), nonce: newNonce() };
    expect(decodeComponentId(encodeComponentId(id))).toEqual(id);
  });

  it('stays inside the 100 character limit Discord allows', () => {
    const encoded = encodeComponentId({
      kind: 'pick_account',
      requestId: crypto.randomUUID(),
      nonce: newNonce(),
    });
    expect(encoded.length).toBeLessThanOrEqual(100);
  });

  it.each([
    'not-ours',
    'rs:approve:missing-nonce',
    'rs:unknown_kind:id:nonce',
    'xx:approve:id:nonce',
    'rs:approve::nonce',
  ])('refuses to decode %s', (raw) => {
    expect(decodeComponentId(raw)).toBeUndefined();
  });

  it('produces a different nonce every time', () => {
    const nonces = new Set(Array.from({ length: 100 }, () => newNonce()));
    expect(nonces.size).toBe(100);
  });

  it('compares nonces without leaking length through timing', () => {
    const nonce = newNonce();
    expect(safeEquals(nonce, nonce)).toBe(true);
    expect(safeEquals(nonce, newNonce())).toBe(false);
    expect(safeEquals(nonce, `${nonce}x`)).toBe(false);
  });
});

describe('workflow deadlines', () => {
  it('resolves when the work finishes in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1_000, 'test')).resolves.toBe('done');
  });

  it('rejects with a named deadline when it does not', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5_000));
    await expect(withTimeout(slow, 20, 'clear license workflow')).rejects.toThrow(
      /clear license workflow timed out after 20ms/,
    );
  });
});
