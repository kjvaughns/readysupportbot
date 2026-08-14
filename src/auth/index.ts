import type { FastifyRequest } from 'fastify';
import { supabaseAuthClient, getStore, isSupabaseConfigured } from '../database';
import {
  AuthenticationError,
  DependencyNotConfiguredError,
  PermissionError,
  ValidationError,
} from '../security/errors';
import { Permission, Role } from '../types';
import { hasPermission } from '../permissions';

/**
 * Frontend authentication.
 *
 * The frontend sends the Supabase access token of the signed-in user. The token
 * is verified server side on every request — never trusted from a claim in the
 * body — and then checked against the caller's membership in the organization
 * they are acting on.
 */

export interface AuthenticatedUser {
  id: string;
  email?: string | null;
}

export interface AuthenticatedContext {
  user: AuthenticatedUser;
  organizationId: string;
  role: Role;
}

export function bearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header || Array.isArray(header)) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Verifies the Supabase access token and returns the user it belongs to. */
export async function verifyAccessToken(token: string): Promise<AuthenticatedUser> {
  if (!isSupabaseConfigured()) throw new DependencyNotConfiguredError('Supabase');

  const client = supabaseAuthClient();
  if (!client) throw new DependencyNotConfiguredError('Supabase');

  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) throw new AuthenticationError('That session is not valid.');

  return { id: data.user.id, email: data.user.email };
}

export async function authenticate(request: FastifyRequest): Promise<AuthenticatedUser> {
  const token = bearerToken(request);
  if (!token) throw new AuthenticationError('Send a Supabase access token as a bearer token.');
  return verifyAccessToken(token);
}

/** Reads the organization id from the request, in a fixed order. */
export function organizationIdFrom(request: FastifyRequest): string {
  const fromHeader = request.headers['x-organization-id'];
  const fromQuery = (request.query as Record<string, unknown> | undefined)?.organizationId;
  const fromBody = (request.body as Record<string, unknown> | undefined)?.organizationId;

  const value =
    (typeof fromHeader === 'string' ? fromHeader : undefined) ??
    (typeof fromQuery === 'string' ? fromQuery : undefined) ??
    (typeof fromBody === 'string' ? fromBody : undefined);

  if (!value) throw new ValidationError('An organizationId is required.');
  return value;
}

/**
 * Full check: valid token, membership in the organization, and — when asked —
 * the permission the endpoint requires.
 */
export async function requireAccess(
  request: FastifyRequest,
  permission?: Permission,
): Promise<AuthenticatedContext> {
  const user = await authenticate(request);
  const organizationId = organizationIdFrom(request);

  const member = await getStore().getMemberBySupabaseUser(organizationId, user.id);
  if (!member) {
    // Membership is what isolates organizations from each other.
    throw new PermissionError('You do not have access to this organization.');
  }

  if (permission && !hasPermission(member.role, permission)) {
    throw new PermissionError(
      `Your role (${member.role}) cannot ${permission.replace(/_/g, ' ')}.`,
    );
  }

  return { user, organizationId, role: member.role };
}

/** Requires a specific minimum role, used for Owner-only operations. */
export async function requireRole(
  request: FastifyRequest,
  roles: Role[],
): Promise<AuthenticatedContext> {
  const context = await requireAccess(request);
  if (!roles.includes(context.role)) {
    throw new PermissionError(`This action is limited to: ${roles.join(', ')}.`);
  }
  return context;
}
