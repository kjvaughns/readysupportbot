import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Authenticated encryption for the few values that must survive a restart in
 * the database — currently only the manual-reconnect handoff token.
 *
 * Readymode passwords and temporary agent passwords are deliberately NOT
 * stored, encrypted or otherwise.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = 'v1';

let cachedKey: Buffer | undefined;

/** Accepts a base64 or hex encoded 32-byte key. */
function decodeKey(raw: string): Buffer {
  const trimmed = raw.trim();

  if (/^[0-9a-f]{64}$/i.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === KEY_BYTES) return decoded;

  throw new Error(
    `ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${decoded.length}). ` +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
  );
}

function key(): Buffer {
  cachedKey ??= decodeKey(env().ENCRYPTION_KEY);
  return cachedKey;
}

/** Test helper. */
export function resetKeyCache(): void {
  cachedKey = undefined;
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join(
    '.',
  );
}

export function decrypt(payload: string): string {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Ciphertext is not in the expected format');
  }

  const iv = Buffer.from(parts[1] as string, 'base64url');
  const tag = Buffer.from(parts[2] as string, 'base64url');
  const ciphertext = Buffer.from(parts[3] as string, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Ciphertext is not in the expected format');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Constant-time comparison for nonces and handoff tokens. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** A URL-safe random token for the manual reconnect flow. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
