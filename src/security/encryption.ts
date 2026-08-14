import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config';

/**
 * Authenticated encryption for stored Readymode credentials.
 *
 * AES-256-GCM, a fresh 12-byte initialization vector per record, and the
 * record's own context bound in as additional authenticated data so a
 * ciphertext cannot be replayed against a different organization or field.
 *
 * Envelope format: v1:<iv>:<authTag>:<ciphertext>, each part base64.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class EncryptionNotConfiguredError extends Error {
  constructor() {
    super('ENCRYPTION_KEY is not configured. Credential storage is unavailable.');
    this.name = 'EncryptionNotConfiguredError';
  }
}

export class DecryptionError extends Error {
  constructor(message = 'Unable to decrypt value.') {
    super(message);
    this.name = 'DecryptionError';
  }
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }

  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === KEY_BYTES) return decoded;

  const utf8 = Buffer.from(trimmed, 'utf8');
  if (utf8.length === KEY_BYTES) return utf8;

  throw new Error(
    'ENCRYPTION_KEY must be 32 bytes, supplied as 64 hex characters or base64.',
  );
}

let cachedKey: Buffer | null = null;
let cachedSource: string | null = null;

function encryptionKey(): Buffer {
  const raw = env.ENCRYPTION_KEY ?? process.env.ENCRYPTION_KEY;
  if (!raw) throw new EncryptionNotConfiguredError();
  if (cachedKey && cachedSource === raw) return cachedKey;
  cachedKey = parseKey(raw);
  cachedSource = raw;
  return cachedKey;
}

export function isEncryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param plaintext value to protect
 * @param context   binds the ciphertext to where it is stored, for example
 *                  `org:<id>:readymode_password`
 */
export function encrypt(plaintext: string, context = 'readysupport'): string {
  const key = encryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));

  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, 'utf8')),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(envelope: string, context = 'readysupport'): string {
  const key = encryptionKey();
  const parts = envelope.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new DecryptionError('Unrecognized ciphertext envelope.');
  }

  const [, ivPart, tagPart, dataPart] = parts;
  const iv = Buffer.from(ivPart, 'base64');
  const authTag = Buffer.from(tagPart, 'base64');
  const ciphertext = Buffer.from(dataPart, 'base64');

  if (iv.length !== IV_BYTES) throw new DecryptionError('Invalid initialization vector.');
  if (authTag.length !== 16) throw new DecryptionError('Invalid authentication tag.');

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    // Authentication failure and malformed input are reported the same way so
    // the error cannot be used as an oracle.
    throw new DecryptionError();
  }
}

/** Constant-time comparison for tokens and signatures. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Generates a fresh key in the format ENCRYPTION_KEY expects. */
export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}
