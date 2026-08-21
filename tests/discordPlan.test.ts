import { describe, expect, it } from 'vitest';
import { classifyRequest, controlsForAction, mayRunNow } from '../src/discord/classification';
import { buildPlan, renderPlan } from '../src/discord/plan';
import { Action } from '../src/openai/schema';
import { CapabilityStatus } from '../src/readymode/selectors/capabilities';

/**
 * Every request lands in exactly one kind, and the kind decides what may
 * happen. The line these protect is between a change that has been understood
 * and a change that has been authorized: nothing crosses it except a person.
 */

const forceLogout: Action = {
  action: 'FORCE_LOGOUT',
  agent: 'jsmith',
  resetPassword: false,
} as unknown as Action;

const agentStatus: Action = { action: 'AGENT_STATUS', agent: 'jsmith' } as unknown as Action;

const question: Action = {
  action: 'TROUBLESHOOT',
  topic: 'audio',
  question: 'my headset has no sound',
} as unknown as Action;

describe('classifying a request', () => {
  it('calls a question a question', () => {
    expect(classifyRequest({ action: question }).kind).toBe('support_question');
  });

  it('calls a read a read', () => {
    const classification = classifyRequest({ action: agentStatus });
    expect(classification.kind).toBe('read_only_inspection');
    expect(mayRunNow(classification.kind)).toBe(true);
  });

  it('proposes a change rather than running it', () => {
    const classification = classifyRequest({ action: forceLogout });
    expect(classification.kind).toBe('proposed_administrative_action');
    // The whole point: a proposal may not touch Readymode.
    expect(mayRunNow(classification.kind)).toBe(false);
    expect(classification.reason).toMatch(/until somebody confirms/i);
  });

  it('runs a change only once it is approved', () => {
    const classification = classifyRequest({ action: forceLogout, approved: true });
    expect(classification.kind).toBe('approved_administrative_action');
    expect(mayRunNow(classification.kind)).toBe(true);
    expect(classification.reason).toMatch(/verified/i);
  });

  it('blocks a change whose controls are not verified, approved or not', () => {
    const capability: CapabilityStatus = {
      capability: 'force_logout',
      label: 'sign a specific user out of Readymode',
      usable: false,
      controls: [],
      missing: ['agents.force_logout'],
      blockedReason: 'No Owner has approved the selector profile for this organization yet.',
    };

    for (const approved of [false, true]) {
      const classification = classifyRequest({ action: forceLogout, approved, capability });
      expect(classification.kind).toBe('blocked_or_unsupported');
      expect(mayRunNow(classification.kind)).toBe(false);
      expect(classification.reason).toMatch(/approved the selector profile/i);
    }
  });

  it('blocks anything permission refused, before considering anything else', () => {
    const classification = classifyRequest({
      action: forceLogout,
      approved: true,
      permissionDenied: 'Only an Administrator can sign a user out.',
    });

    expect(classification.kind).toBe('blocked_or_unsupported');
    expect(classification.reason).toMatch(/Only an Administrator/);
  });
});

describe('the plan shown before a change runs', () => {
  const plan = buildPlan({
    action: forceLogout,
    classification: classifyRequest({ action: forceLogout }),
    preview: { lines: ['jsmith is signed in and holding an agent licence.'] },
    affected: 'jsmith (John S.)',
    needsSecondApprover: false,
    dryRun: true,
    sources: { 'agents.force_logout': 'interface_map' },
  });

  it('says what was understood, what changes, and whose account', () => {
    const rendered = renderPlan(plan);
    expect(rendered).toContain('Understood:');
    expect(rendered).toContain('jsmith (John S.)');
    expect(rendered).toContain('holding an agent licence');
  });

  it('names every control it would use, and where each came from', () => {
    expect(plan.selectors.map((selector) => selector.control)).toEqual(
      controlsForAction(forceLogout),
    );

    const rendered = renderPlan(plan);
    expect(rendered).toContain('agents.force_logout');
    // Someone approving a change can see whether it is acting on evidence or a
    // guess without taking anybody's word for it.
    expect(rendered).toContain('from the recorded interface inspection');
  });

  it('marks a built-in guess as one', () => {
    const guessed = buildPlan({
      action: forceLogout,
      classification: classifyRequest({ action: forceLogout }),
      preview: { lines: [] },
      dryRun: false,
      sources: { 'agents.force_logout': 'builtin' },
    });

    expect(renderPlan(guessed)).toContain('a built-in guess — not used for changes');
  });

  it('states what success would look like, before it happens', () => {
    expect(plan.success.join(' ')).toMatch(/signed out and a licence has been released/i);
    expect(renderPlan(plan)).toContain('Success means:');
  });

  it('says what approval is needed', () => {
    expect(plan.approval).toMatch(/Waiting for you to confirm/);

    const twoPerson = buildPlan({
      action: forceLogout,
      classification: classifyRequest({ action: forceLogout }),
      preview: { lines: [] },
      needsSecondApprover: true,
      dryRun: false,
    });
    expect(twoPerson.approval).toMatch(/second Owner or Administrator/);
  });

  it('says when dry run means nothing will actually be saved', () => {
    expect(renderPlan(plan)).toMatch(/Dry run is on/);
  });

  it('cannot be used to smuggle a mention into a channel', () => {
    const hostile = buildPlan({
      action: forceLogout,
      classification: classifyRequest({ action: forceLogout }),
      preview: { lines: ['@everyone please ignore this'] },
      affected: '<@1234567890>',
      dryRun: false,
    });

    const rendered = renderPlan(hostile);
    // A zero-width space is inserted before the mention, so the literal
    // "@everyone" no longer exists in the text Discord receives.
    expect(rendered).not.toContain('@everyone');
    expect(rendered).toContain('@\u200Beveryone');
    expect(rendered).not.toContain('<@1234567890>');
  });
});
