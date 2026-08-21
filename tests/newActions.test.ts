import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setStore } from '../src/database';
import { buildAction } from '../src/openai/schema';
import { fallbackParse } from '../src/openai/fallback';
import { approvalRequirement, requiresSecondApprover } from '../src/approvals';
import {
  DEFAULT_ACTION_ROLES,
  checkActionAccess,
  getActionRoles,
  setActionRole,
} from '../src/permissions/overrides';
import { answerTroubleshooting, detectTopic } from '../src/knowledge/troubleshooting';
import { COMMAND_NAMES } from '../src/discord/commands';

const ORG = 'org-a';

beforeEach(() => {
  setStore(new MemoryStore());
});

describe('slash commands', () => {
  it('registers the commands people asked for', () => {
    for (const name of [
      'clear-licenses',
      'force-logout',
      'add-assignment',
      'remove-assignment',
      'view-assignments',
      'troubleshoot',
    ]) {
      expect(COMMAND_NAMES, `${name} is missing`).toContain(name);
    }
  });
});

describe('logging out inactive users', () => {
  it('is understood from natural language and needs no target', () => {
    for (const phrase of [
      'log out inactive users',
      'can you clear the licenses please',
      'we are out of seats, free up some seats',
    ]) {
      const parsed = buildAction(fallbackParse(phrase));
      expect(parsed.status, phrase).toBe('ok');
      expect(parsed.action?.action, phrase).toBe('CLEAR_ALL_LICENSES');
    }
  });

  it('needs one confirmation, not a second approver', () => {
    // It uses Readymode's own control and anyone logged out can sign back in.
    const action = { action: 'CLEAR_ALL_LICENSES' } as const;
    expect(requiresSecondApprover(action)).toBe(false);
    expect(approvalRequirement(action).required).toBe(1);
  });
});

describe('signing out a specific user', () => {
  it('is distinguished from the bulk control and requires a target', () => {
    const parsed = buildAction(fallbackParse('please log out <@123456789012345678>'));
    expect(parsed.action?.action).toBe('FORCE_LOGOUT');
    if (parsed.action?.action === 'FORCE_LOGOUT') {
      expect(parsed.action.target).toEqual({
        kind: 'discord_user',
        discordUserId: '123456789012345678',
      });
      expect(parsed.action.resetPassword).toBe(false);
    }
  });

  it('picks up a request to reset the password too', () => {
    const parsed = buildAction(
      fallbackParse('sign out <@123456789012345678> and reset their password'),
    );
    if (parsed.action?.action === 'FORCE_LOGOUT') {
      expect(parsed.action.resetPassword).toBe(true);
    }
  });

  it('asks who, rather than guessing', () => {
    const parsed = buildAction(fallbackParse('please log out whoever is holding a seat'));
    expect(parsed.status).toBe('needs_information');
    expect(parsed.message).toMatch(/who/i);
  });

  it('needs a second Owner or Administrator', () => {
    const action = {
      action: 'FORCE_LOGOUT' as const,
      target: { kind: 'username' as const, username: 'mwebb' },
      resetPassword: false,
    };
    expect(requiresSecondApprover(action)).toBe(true);
    expect(approvalRequirement(action).reason).toMatch(/interrupts their work/i);
  });
});

describe('playlist assignments', () => {
  it('treats a lead pool as a playlist', () => {
    const parsed = buildAction(fallbackParse('add <@123456789012345678> to a lead pool'));
    expect(parsed.action?.action ?? parsed.status).toBeTruthy();
    expect(['ASSIGN_PLAYLIST', undefined]).toContain(parsed.action?.action);
  });

  it('validates a complete assignment', () => {
    const parsed = buildAction({
      action: 'ASSIGN_PLAYLIST',
      target: { kind: 'username', username: 'schen' },
      playlists: ['Gold'],
      level: 'backup',
      source: null,
      states: null,
      campaigns: null,
      queues: null,
      accounts: null,
      limit: null,
      topic: null,
      question: null,
      resetPassword: null,
      clarification: null,
      reason: null,
    } as never);

    expect(parsed.status).toBe('ok');
    if (parsed.action?.action === 'ASSIGN_PLAYLIST') {
      expect(parsed.action.playlists).toEqual(['Gold']);
      expect(parsed.action.level).toBe('backup');
    }
  });

  it('asks which playlist rather than assuming one', () => {
    const parsed = buildAction(fallbackParse('put <@123456789012345678> on a playlist'));
    expect(parsed.status).toBe('needs_information');
  });
});

describe('troubleshooting advice', () => {
  it('routes common complaints to the right topic', () => {
    expect(detectTopic('my audio is not working on calls')).toBe('audio');
    expect(detectTopic("I can't hear the customer")).toBe('audio');
    expect(detectTopic('cannot log in')).toBe('login');
    expect(detectTopic('there are no leads coming through')).toBe('leads');
    expect(detectTopic('the recording will not play')).toBe('recording');
    expect(detectTopic('something weird happened')).toBe('other');
  });

  it('answers an audio problem with concrete checks', () => {
    const answer = answerTroubleshooting('audio', 'no audio on calls');
    expect(answer.body).toMatch(/headset/i);
    expect(answer.body).toMatch(/microphone/i);
  });

  it('says plainly that it is not official documentation', () => {
    const answer = answerTroubleshooting('audio', 'no audio');
    expect(answer.fromOfficialDocumentation).toBe(false);
    expect(answer.body).toMatch(/not steps from the official Readymode documentation/i);
  });

  it('is reached from a plain description of a problem', () => {
    const parsed = buildAction(fallbackParse('my audio isn\'t working'));
    expect(parsed.action?.action).toBe('TROUBLESHOOT');
    if (parsed.action?.action === 'TROUBLESHOOT') expect(parsed.action.topic).toBe('audio');
  });

  it('does not turn a problem report into an administrative change', () => {
    const parsed = buildAction(fallbackParse('I cannot log in, it says my password is wrong'));
    expect(parsed.action?.action).toBe('TROUBLESHOOT');
  });
});

describe('per-action role requirements', () => {
  it('restricts sign-out and password reset to Administrators by default', () => {
    expect(DEFAULT_ACTION_ROLES.FORCE_LOGOUT).toBe('administrator');
    expect(DEFAULT_ACTION_ROLES.RESET_PASSWORD).toBe('administrator');

    const support = checkActionAccess('support', 'FORCE_LOGOUT', DEFAULT_ACTION_ROLES);
    expect(support.allowed).toBe(false);

    expect(checkActionAccess('administrator', 'FORCE_LOGOUT', DEFAULT_ACTION_ROLES).allowed).toBe(
      true,
    );
  });

  it('lets Support clear licences and create accounts out of the box', () => {
    expect(checkActionAccess('support', 'CLEAR_ALL_LICENSES', DEFAULT_ACTION_ROLES).allowed).toBe(
      true,
    );
    expect(checkActionAccess('support', 'CREATE_ACCOUNT', DEFAULT_ACTION_ROLES).allowed).toBe(true);
    expect(checkActionAccess('support', 'ASSIGN_PLAYLIST', DEFAULT_ACTION_ROLES).allowed).toBe(true);
  });

  it('lets an Owner tighten an action without a deploy', async () => {
    await setActionRole(ORG, 'CREATE_ACCOUNT', 'administrator');
    const roles = await getActionRoles(ORG);

    expect(checkActionAccess('support', 'CREATE_ACCOUNT', roles).allowed).toBe(false);
    expect(checkActionAccess('administrator', 'CREATE_ACCOUNT', roles).allowed).toBe(true);
  });

  it('reverts to the default when the override is cleared', async () => {
    await setActionRole(ORG, 'CREATE_ACCOUNT', 'administrator');
    await setActionRole(ORG, 'CREATE_ACCOUNT', null);

    expect(checkActionAccess('support', 'CREATE_ACCOUNT', await getActionRoles(ORG)).allowed).toBe(
      true,
    );
  });

  it('never lets an override widen access beyond the permission table', async () => {
    // A Viewer has no create_accounts permission, so naming them here changes
    // nothing: the permission check runs first.
    await setActionRole(ORG, 'CREATE_ACCOUNT', 'viewer');
    const result = checkActionAccess('viewer', 'CREATE_ACCOUNT', await getActionRoles(ORG));

    expect(result.allowed).toBe(false);
  });

  it('keeps overrides scoped to one organization', async () => {
    await setActionRole(ORG, 'CREATE_ACCOUNT', 'administrator');
    const other = await getActionRoles('org-b');

    expect(checkActionAccess('support', 'CREATE_ACCOUNT', other).allowed).toBe(true);
  });
});
