import { z } from 'zod';
import { getStore } from '../database';
import { recordEvent } from '../audit';
import { decrypt, encrypt, isEncryptionConfigured } from '../security/encryption';
import { DependencyNotConfiguredError, NotFoundError, ValidationError } from '../security/errors';
import { env } from '../config';

/**
 * Readymode administrator credentials.
 *
 * The password arrives over HTTPS from the frontend, is encrypted immediately,
 * and only the ciphertext is stored. It is never returned by an endpoint, never
 * logged, never sent to OpenAI and never written into Discord. The plaintext
 * exists only inside this module and the browser login step.
 */

export const credentialInputSchema = z.object({
  loginUrl: z
    .string()
    .trim()
    .max(500)
    .url('Provide the full Readymode login URL, including https://')
    .refine((value) => value.startsWith('https://'), 'The Readymode login URL must use HTTPS.'),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(500),
});

export type CredentialInput = z.infer<typeof credentialInputSchema>;

/** Binds the ciphertext to the organization and field it belongs to. */
function encryptionContext(organizationId: string): string {
  return `org:${organizationId}:readymode_admin_password`;
}

export interface CredentialSummary {
  configured: boolean;
  loginUrl?: string;
  username?: string;
  updatedAt?: string;
  /** Always absent. Present in the type only to document that it is never sent. */
  password?: never;
}

export async function storeCredentials(input: {
  organizationId: string;
  credentials: CredentialInput;
  actorId?: string | null;
}): Promise<CredentialSummary> {
  if (!isEncryptionConfigured()) {
    throw new DependencyNotConfiguredError('Credential encryption (ENCRYPTION_KEY)');
  }

  const parsed = credentialInputSchema.parse(input.credentials);
  const store = getStore();
  const existing = await store.getCredentials(input.organizationId);

  await store.upsertCredentials({
    organizationId: input.organizationId,
    username: parsed.username,
    loginUrl: parsed.loginUrl.replace(/\/+$/, ''),
    encryptedPassword: encrypt(parsed.password, encryptionContext(input.organizationId)),
    updatedAt: new Date().toISOString(),
    updatedBy: input.actorId ?? null,
  });

  await store.upsertConnection({
    organizationId: input.organizationId,
    loginUrl: parsed.loginUrl.replace(/\/+$/, ''),
    username: parsed.username,
    status: 'unverified',
    lastVerifiedAt: null,
    lastError: null,
  });

  await recordEvent({
    organizationId: input.organizationId,
    type: existing ? 'credentials.replaced' : 'credentials.stored',
    message: existing
      ? 'Readymode administrator credentials were replaced.'
      : 'Readymode administrator credentials were stored.',
    data: { username: parsed.username, loginUrl: parsed.loginUrl },
  });

  return summarize(input.organizationId, parsed.loginUrl, parsed.username, new Date().toISOString());
}

export async function deleteCredentials(input: {
  organizationId: string;
  actorId?: string | null;
}): Promise<void> {
  const store = getStore();
  await store.deleteCredentials(input.organizationId);
  await store.upsertConnection({
    organizationId: input.organizationId,
    loginUrl: '',
    username: '',
    status: 'disconnected',
    lastVerifiedAt: null,
    lastError: 'Credentials were deleted.',
  });
  await recordEvent({
    organizationId: input.organizationId,
    type: 'credentials.deleted',
    message: 'Readymode administrator credentials were deleted.',
  });
}

/** Metadata only. The password is never part of this shape. */
export async function credentialSummary(organizationId: string): Promise<CredentialSummary> {
  const stored = await getStore().getCredentials(organizationId);
  if (!stored) {
    if (env.READYMODE_BASE_URL && env.READYMODE_USERNAME) {
      return {
        configured: true,
        loginUrl: env.READYMODE_BASE_URL,
        username: env.READYMODE_USERNAME,
      };
    }
    return { configured: false };
  }
  return summarize(organizationId, stored.loginUrl, stored.username, stored.updatedAt);
}

function summarize(
  _organizationId: string,
  loginUrl: string,
  username: string,
  updatedAt: string,
): CredentialSummary {
  return { configured: true, loginUrl, username, updatedAt };
}

export interface ResolvedCredentials {
  loginUrl: string;
  username: string;
  password: string;
}

/**
 * Internal use only: returns the decrypted credentials for a login attempt.
 * Callers must not log, store, or forward the result.
 */
export async function resolveCredentials(organizationId: string): Promise<ResolvedCredentials> {
  const stored = await getStore().getCredentials(organizationId);

  if (!stored) {
    // Single-tenant fallback for self-hosted installs.
    if (env.READYMODE_BASE_URL && env.READYMODE_USERNAME && env.READYMODE_PASSWORD) {
      return {
        loginUrl: env.READYMODE_BASE_URL,
        username: env.READYMODE_USERNAME,
        password: env.READYMODE_PASSWORD,
      };
    }
    throw new NotFoundError(
      'Readymode is not connected yet. Add the connection in the ReadySupport dashboard.',
    );
  }

  if (!isEncryptionConfigured()) {
    throw new DependencyNotConfiguredError('Credential encryption (ENCRYPTION_KEY)');
  }

  const password = decrypt(stored.encryptedPassword, encryptionContext(organizationId));
  if (!password) throw new ValidationError('The stored Readymode password could not be read.');

  return { loginUrl: stored.loginUrl, username: stored.username, password };
}

export async function hasCredentials(organizationId: string): Promise<boolean> {
  const stored = await getStore().getCredentials(organizationId);
  if (stored) return true;
  return Boolean(env.READYMODE_BASE_URL && env.READYMODE_USERNAME && env.READYMODE_PASSWORD);
}
