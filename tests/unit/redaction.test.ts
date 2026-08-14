import { describe, expect, it } from 'vitest';
import {
  isSensitiveKey,
  REDACTED,
  registerSecret,
  sanitize,
  sanitizeForAudit,
  scrubSecretValues,
} from '../../src/security/redact.js';
import { generateTemporaryPassword, checkPasswordStrength, MIN_PASSWORD_LENGTH } from '../../src/util/password.js';

describe('sensitive key detection', () => {
  it.each([
    'password',
    'temporaryPassword',
    'admin_password',
    'apiKey',
    'api_key',
    'authorization',
    'cookie',
    'sessionId',
    'ENCRYPTION_KEY',
    'service_role_key',
    'privateKey',
  ])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(['username', 'email', 'fullName', 'licenseType', 'passwordDelivered', 'passwordSource'])(
    'leaves %s alone',
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );
});

describe('structural redaction', () => {
  it('removes a password however deeply nested', () => {
    const sanitized = sanitize({
      request: {
        input: { username: 'msmith', temporaryPassword: 'hunter2-hunter2' },
        nested: [{ password: 'another-secret-value' }],
      },
    }) as Record<string, Record<string, Record<string, unknown>>>;

    expect(sanitized['request']?.['input']?.['temporaryPassword']).toBe(REDACTED);
    expect(sanitized['request']?.['input']?.['username']).toBe('msmith');

    const nested = sanitized['request']?.['nested'] as unknown as Array<Record<string, unknown>>;
    expect(nested[0]?.['password']).toBe(REDACTED);
  });

  it('keeps the marker fields that say a password was delivered', () => {
    const sanitized = sanitize({ passwordDelivered: true, passwordSource: 'generated' }) as Record<string, unknown>;
    expect(sanitized['passwordDelivered']).toBe(true);
    expect(sanitized['passwordSource']).toBe('generated');
  });

  it('survives a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    const sanitized = sanitize(circular) as Record<string, unknown>;
    expect(sanitized['self']).toBe('[circular]');
  });

  it('truncates a very long array rather than logging all of it', () => {
    const sanitized = sanitize(Array.from({ length: 200 }, (_value, index) => index)) as unknown[];
    expect(sanitized).toHaveLength(51);
    expect(sanitized[50]).toContain('more items omitted');
  });

  it('turns an Error into something loggable without a stack', () => {
    const sanitized = sanitize(new Error('something went wrong')) as Record<string, unknown>;
    expect(sanitized['message']).toBe('something went wrong');
    expect(sanitized['stack']).toBeUndefined();
  });
});

describe('value scrubbing', () => {
  it('removes a registered secret from arbitrary text', () => {
    registerSecret('super-secret-token-value');

    const text = 'The request failed with header Authorization: super-secret-token-value at 10:04';
    expect(scrubSecretValues(text)).toBe(
      `The request failed with header Authorization: ${REDACTED} at 10:04`,
    );
  });

  it('catches a generated password even in a field with an innocent name', () => {
    // This is the case key-based redaction alone would miss: a password
    // echoed back inside a Readymode error banner.
    const password = generateTemporaryPassword();

    const sanitized = sanitize({
      readymodeBanner: `Could not set password "${password}" — try again`,
    }) as Record<string, string>;

    expect(sanitized['readymodeBanner']).not.toContain(password);
    expect(sanitized['readymodeBanner']).toContain(REDACTED);
  });

  it('ignores values too short to scrub safely', () => {
    registerSecret('abc');
    expect(scrubSecretValues('abc appears in many words like abcdef')).toBe(
      'abc appears in many words like abcdef',
    );
  });
});

describe('audit sanitisation', () => {
  it('always returns a JSON object', () => {
    expect(sanitizeForAudit('a bare string')).toEqual({ value: 'a bare string' });
    expect(sanitizeForAudit([1, 2])).toEqual({ value: [1, 2] });
    expect(sanitizeForAudit({ a: 1 })).toEqual({ a: 1 });
  });

  it('strips credentials from a create-account payload', () => {
    const audited = sanitizeForAudit({
      action: 'CREATE_ACCOUNT',
      username: 'msmith',
      email: 'marcus@example.com',
      temporaryPassword: 'a-real-password-here',
    });

    expect(audited['temporaryPassword']).toBe(REDACTED);
    expect(audited['username']).toBe('msmith');
  });

  it('does not keep cookies or tokens', () => {
    const audited = sanitizeForAudit({
      cookie: 'session=abc123; path=/',
      sessionToken: 'eyJhbGciOi',
      browserSessionId: 'bb-session-1',
    });

    expect(audited['cookie']).toBe(REDACTED);
    expect(audited['sessionToken']).toBe(REDACTED);
    // A session *identifier* is not a credential and is genuinely useful.
    expect(audited['browserSessionId']).toBe('bb-session-1');
  });
});

describe('generated passwords', () => {
  it('meets the length and character-class rules', () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const password = generateTemporaryPassword();
      expect(password.length).toBeGreaterThanOrEqual(16);
      expect(checkPasswordStrength(password).ok).toBe(true);
    }
  });

  it('never repeats', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(50);
  });

  it('registers itself for redaction the moment it exists', () => {
    const password = generateTemporaryPassword();
    expect(scrubSecretValues(`value=${password}`)).toBe(`value=${REDACTED}`);
  });

  it('rejects a weak administrator-supplied password', () => {
    expect(checkPasswordStrength('short').ok).toBe(false);
    expect(checkPasswordStrength('alllowercaseletters').problems).toContain('must contain an uppercase letter');
    expect(checkPasswordStrength('NoDigitsInHere!!').problems).toContain('must contain a digit');
    expect(checkPasswordStrength('a'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
  });
});
