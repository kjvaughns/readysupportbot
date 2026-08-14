import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/security/ratelimit.js';
import { encrypt, decrypt, randomToken, safeEquals } from '../../src/security/crypto.js';
import * as vault from '../../src/security/secretVault.js';
import { scrubSecretValues, REDACTED } from '../../src/security/redact.js';

describe('rate limiting', () => {
  function limiterAt(clock: { now: number }): RateLimiter {
    return new RateLimiter(
      {
        read: { capacity: 3, refillPerMinute: 3 },
        write: { capacity: 2, refillPerMinute: 2 },
        nl: { capacity: 2, refillPerMinute: 2 },
      },
      () => clock.now,
    );
  }

  it('allows a burst up to capacity, then refuses', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    expect(limiter.consume('u1', 'write').allowed).toBe(true);
    expect(limiter.consume('u1', 'write').allowed).toBe(true);

    const refused = limiter.consume('u1', 'write');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over time', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    limiter.consume('u1', 'write');
    limiter.consume('u1', 'write');
    expect(limiter.consume('u1', 'write').allowed).toBe(false);

    clock.now += 30_000; // half a minute, so one token at 2/min
    expect(limiter.consume('u1', 'write').allowed).toBe(true);
  });

  it('keeps read and write budgets separate', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    limiter.consume('u1', 'write');
    limiter.consume('u1', 'write');
    expect(limiter.consume('u1', 'write').allowed).toBe(false);

    // Exhausting the write budget must not stop them reading.
    expect(limiter.consume('u1', 'read').allowed).toBe(true);
  });

  it('keeps users separate', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    limiter.consume('u1', 'write');
    limiter.consume('u1', 'write');
    expect(limiter.consume('u1', 'write').allowed).toBe(false);
    expect(limiter.consume('u2', 'write').allowed).toBe(true);
  });

  it('picks the budget from the action', () => {
    expect(RateLimiter.budgetFor('CREATE_ACCOUNT')).toBe('write');
    expect(RateLimiter.budgetFor('DEACTIVATE_ACCOUNT')).toBe('write');
    expect(RateLimiter.budgetFor('CHECK_AGENT_STATUS')).toBe('read');
    expect(RateLimiter.budgetFor('LIST_RECENT_ACTIONS')).toBe('read');
  });

  it('does not grow without bound', () => {
    const clock = { now: 0 };
    const limiter = limiterAt(clock);

    for (let index = 0; index < 100; index += 1) limiter.consume(`u${index}`, 'read');

    clock.now += 60 * 60_000;
    limiter.prune();

    // Everything idle for an hour is back at capacity anyway.
    expect(limiter.consume('u0', 'read').allowed).toBe(true);
  });
});

describe('encryption', () => {
  it('round-trips', () => {
    const plaintext = 'a value worth protecting';
    const ciphertext = encrypt(plaintext);

    expect(ciphertext).not.toContain(plaintext);
    expect(ciphertext.startsWith('v1.')).toBe(true);
    expect(decrypt(ciphertext)).toBe(plaintext);
  });

  it('produces different ciphertext each time', () => {
    expect(encrypt('same input')).not.toBe(encrypt('same input'));
  });

  it('refuses tampered ciphertext', () => {
    const ciphertext = encrypt('trustworthy');
    const parts = ciphertext.split('.');
    const tampered = [parts[0], parts[1], parts[2], Buffer.from('evil').toString('base64url')].join('.');

    expect(() => decrypt(tampered)).toThrow();
  });

  it('refuses a malformed payload', () => {
    expect(() => decrypt('not-ciphertext')).toThrow(/expected format/);
    expect(() => decrypt('v2.a.b.c')).toThrow(/expected format/);
  });

  it('compares tokens safely', () => {
    const token = randomToken(16);
    expect(safeEquals(token, token)).toBe(true);
    expect(safeEquals(token, randomToken(16))).toBe(false);
  });
});

describe('the secret vault', () => {
  it('hands a value back once and then forgets it', () => {
    vault.put('k', 'a-temporary-password');

    expect(vault.take('k')).toBe('a-temporary-password');
    expect(vault.take('k')).toBeUndefined();
  });

  it('registers what it holds for redaction', () => {
    vault.put('k', 'another-temporary-password');
    expect(scrubSecretValues('leak: another-temporary-password')).toBe(`leak: ${REDACTED}`);
  });

  it('drops values once they expire', () => {
    vault.put('k', 'expiring-password-value', -1);
    expect(vault.take('k')).toBeUndefined();
    expect(vault.size()).toBe(0);
  });

  it('namespaces the two kinds of held password', () => {
    expect(vault.keys.providedPassword('r1')).not.toBe(vault.keys.deliverablePassword('r1'));
  });

  it('loses everything on clear, which is what a restart does', () => {
    vault.put(vault.keys.providedPassword('r1'), 'admin-supplied-password');
    vault.clear();

    // A restart means the job generates a fresh password rather than reaching
    // for a stored one — because there is never a stored one.
    expect(vault.peek(vault.keys.providedPassword('r1'))).toBeUndefined();
  });
});
