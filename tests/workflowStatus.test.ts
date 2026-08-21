import { describe, expect, it } from 'vitest';
import {
  WORKFLOWS,
  attemptableWorkflows,
  statusProblems,
  statusTable,
  unusedControls,
  workflowSpec,
} from '../src/readymode/interface/workflows';
import { EVIDENCE_STATUSES, isAutomatable, isModifying } from '../src/readymode/interface/types';
import { interfaceControl } from '../src/readymode/interface/registry';

/**
 * The status model is only worth having if it cannot be quietly inflated.
 * These tests are the mechanism: a workflow may not claim more evidence than
 * the controls it depends on actually have.
 */

describe('workflow statuses', () => {
  it('never claims more than its controls support', () => {
    // This is the check that caught `view_license_usage` claiming `discovered`
    // while depending on a table selector nobody had seen.
    expect(statusProblems()).toEqual([]);
  });

  it('uses only the agreed status vocabulary', () => {
    for (const workflow of WORKFLOWS) {
      expect(EVIDENCE_STATUSES).toContain(workflow.status);
    }
  });

  it('covers every workflow that was asked for', () => {
    const required = [
      'continue_existing_session',
      'create_user',
      'assign_folder_and_role',
      'manage_user_permissions',
      'view_license_usage',
      'sign_out_user',
      'open_lead_management',
      'open_queue',
      'view_queue_members',
      'configure_queue',
      'open_campaigns',
      'open_playlists',
      'filter_playlist_by_location',
      'explain_state_calling_restrictions',
      'diagnose_problem',
    ];

    for (const key of required) {
      expect(workflowSpec(key), `${key} is missing`).not.toBeNull();
    }
  });

  it('gives every modifying workflow a postcondition to verify against', () => {
    for (const workflow of WORKFLOWS) {
      if (!isModifying(workflow.safety)) continue;
      expect(workflow.postconditions.length, workflow.key).toBeGreaterThan(0);
    }
  });

  it('requires approval before anything that changes Readymode', () => {
    for (const workflow of attemptableWorkflows()) {
      if (!isModifying(workflow.safety)) continue;
      const text = workflow.preconditions.join(' ').toLowerCase();
      expect(text, workflow.key).toMatch(/approv/);
    }
  });

  it('leaves nothing in the registry unaccounted for', () => {
    // Controls no workflow uses are fine — they are recorded so they can be
    // recognized and avoided — but each one has to be deliberately so.
    const deliberatelyUnused = [
      'login.username',
      'login.password',
      'login.submit',
      'login.admin_mode',
      'shell.search',
      'shell.sign_out',
      'users.search_toggle',
      'users.search',
      'users.open_queues',
      'users.toggle_deleted',
      'users.bulk_passwords',
      'licenses.sign_out_all',
      'leads.upload_file',
      'queue.view_leads_tab',
      'queue.agent_announcement',
      'queue.start_time',
      'queue.end_time',
      'queue.ringtone',
      'iq.state_calling_restrictions',
    ];

    expect(unusedControls().sort()).toEqual(deliberatelyUnused.sort());
  });
});

describe('the honest status table', () => {
  it('names what blocks each workflow that is not ready', () => {
    const table = statusTable();

    const createUser = table.find((row) => row.workflow === 'create_user');
    expect(createUser?.status).toBe('blocked');
    expect(createUser?.blockedBy).toContain('users.create');

    const signOut = table.find((row) => row.workflow === 'sign_out_user');
    expect(signOut?.status).toBe('discovered');
    expect(signOut?.blockedBy).toEqual([]);
  });

  it('does not claim anything has been tested against the live account', () => {
    // Nothing has been run against real Readymode from this environment, so no
    // workflow may say it was.
    for (const workflow of WORKFLOWS) {
      expect(workflow.status).not.toBe('live_tested');
      expect(workflow.status).not.toBe('dry_run_tested');
    }
  });
});

describe('playlist filtering is not a calling restriction', () => {
  it('keeps them as separate workflows for separate products', () => {
    const playlist = workflowSpec('filter_playlist_by_location');
    const restriction = workflowSpec('explain_state_calling_restrictions');

    expect(playlist?.interfaceVersion).toBe('starter');
    expect(restriction?.interfaceVersion).toBe('iq');
    expect(playlist?.safety).toBe('modifies_data');
    expect(restriction?.safety).toBe('read_only');

    // Each warns against being used as the other.
    expect(playlist?.notes).toMatch(/calling window|restriction/i);
    expect(restriction?.notes).toMatch(/playlist|lead assignment/i);
  });

  it('cites the official article for the iQ restriction rather than describing it from memory', () => {
    const restriction = workflowSpec('explain_state_calling_restrictions');
    expect(restriction?.officialSourceUrls[0]).toMatch(
      /^https:\/\/help\.readymode\.com\/support\/solutions\/articles\//,
    );
  });
});

describe('the session takeover workflow', () => {
  it('is not automatable until the notice has actually been seen', () => {
    const workflow = workflowSpec('continue_existing_session');
    expect(isAutomatable(workflow!.status)).toBe(false);
    expect(interfaceControl('login.multiple_session_continue')?.evidenceStatus).toBe('documented');
  });

  it('states the guards that make pressing Continue safe', () => {
    const preconditions = workflowSpec('continue_existing_session')!.preconditions.join(' ').toLowerCase();
    expect(preconditions).toMatch(/human verification/);
    expect(preconditions).toMatch(/not already been pressed/);
    expect(preconditions).toMatch(/takeover/);
  });
});
