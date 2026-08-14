import { describe, expect, it } from 'vitest';
import {
  ACTION_PERMISSIONS,
  atLeast,
  hasPermission,
  highestRole,
  isModifyingAction,
  requireActionPermission,
  requirePermission,
} from '../src/permissions';
import { PermissionError } from '../src/security/errors';
import { ACTION_TYPES } from '../src/types';

describe('permission enforcement', () => {
  it('gives a Viewer read access only', () => {
    expect(hasPermission('viewer', 'view_activity')).toBe(true);
    expect(hasPermission('viewer', 'check_agent_status')).toBe(true);
    expect(hasPermission('viewer', 'configure_states')).toBe(false);
    expect(hasPermission('viewer', 'create_accounts')).toBe(false);
  });

  it('lets Support operate but not deactivate', () => {
    expect(hasPermission('support', 'create_accounts')).toBe(true);
    expect(hasPermission('support', 'configure_states')).toBe(true);
    expect(hasPermission('support', 'clear_licenses')).toBe(true);
    expect(hasPermission('support', 'deactivate_accounts')).toBe(false);
    expect(hasPermission('support', 'manage_connections')).toBe(false);
  });

  it('lets an Administrator deactivate but not manage connections', () => {
    expect(hasPermission('administrator', 'deactivate_accounts')).toBe(true);
    expect(hasPermission('administrator', 'manage_members')).toBe(true);
    expect(hasPermission('administrator', 'manage_connections')).toBe(false);
  });

  it('gives an Owner everything', () => {
    expect(hasPermission('owner', 'manage_connections')).toBe(true);
    expect(hasPermission('owner', 'deactivate_accounts')).toBe(true);
    expect(hasPermission('owner', 'view_activity')).toBe(true);
  });

  it('throws a permission error naming the role', () => {
    expect(() => requirePermission('viewer', 'configure_states')).toThrowError(PermissionError);
    expect(() => requirePermission('viewer', 'configure_states')).toThrowError(/viewer/);
    expect(() => requirePermission('owner', 'configure_states')).not.toThrow();
  });

  it('enforces the permission each action needs', () => {
    expect(() => requireActionPermission('viewer', 'SET_STATES')).toThrowError(PermissionError);
    expect(() => requireActionPermission('support', 'SET_STATES')).not.toThrow();
    expect(() => requireActionPermission('support', 'DEACTIVATE_ACCOUNT')).toThrowError(
      PermissionError,
    );
    expect(() => requireActionPermission('administrator', 'DEACTIVATE_ACCOUNT')).not.toThrow();
    expect(() => requireActionPermission('viewer', 'HELP')).not.toThrow();
  });

  it('maps every action to a permission decision', () => {
    for (const action of ACTION_TYPES) {
      expect(ACTION_PERMISSIONS).toHaveProperty(action);
    }
  });

  it('ranks roles', () => {
    expect(atLeast('owner', 'administrator')).toBe(true);
    expect(atLeast('administrator', 'administrator')).toBe(true);
    expect(atLeast('support', 'administrator')).toBe(false);
    expect(highestRole(['viewer', 'administrator', 'support'])).toBe('administrator');
    expect(highestRole([])).toBeNull();
  });

  it('knows which actions modify Readymode', () => {
    expect(isModifyingAction('SET_STATES')).toBe(true);
    expect(isModifyingAction('DEACTIVATE_ACCOUNT')).toBe(true);
    expect(isModifyingAction('VIEW_STATES')).toBe(false);
    expect(isModifyingAction('AGENT_STATUS')).toBe(false);
  });
});
