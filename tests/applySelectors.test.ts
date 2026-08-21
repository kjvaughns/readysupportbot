import { describe, expect, it } from 'vitest';
import { buildObservedModule } from '../scripts/applySelectors';

/**
 * The codegen step is the last gate before a selector becomes committed code.
 * It emits only what the evidence justifies.
 */

function report(selectors: Array<Record<string, unknown>>) {
  return {
    reportId: '11111111-1111-1111-1111-111111111111',
    capturedAt: '2026-01-01T00:00:00.000Z',
    host: 'https://rm.test/',
    selectors: selectors as never,
  };
}

const good = {
  control: 'agents.save',
  strategy: { type: 'testId', value: 'save-agent' },
  tier: 'stable-attribute',
  confidence: 100,
  rootName: 'frame:body',
  rootUrl: 'https://rm.test/body',
  verified: true,
};

describe('generating committed selectors', () => {
  it('emits a verified, high-confidence selector', () => {
    const result = buildObservedModule(report([good]), 'abc');
    expect(result.emitted).toEqual(['agents.save']);
    expect(result.source).toContain('agents.save');
    expect(result.source).toContain('GENERATED FILE');
  });

  it('skips a selector that was not verified', () => {
    const result = buildObservedModule(report([{ ...good, verified: false }]), 'abc');
    expect(result.emitted).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/not verified/i);
  });

  it('skips a selector below the confidence threshold', () => {
    const result = buildObservedModule(report([{ ...good, confidence: 55 }]), 'abc');
    expect(result.emitted).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/confidence/i);
  });

  it('keeps a selector exactly at the threshold', () => {
    expect(buildObservedModule(report([{ ...good, confidence: 60 }]), 'abc').emitted).toEqual([
      'agents.save',
    ]);
  });

  it('skips a brittle structural selector however confident it is', () => {
    const result = buildObservedModule(
      report([{ ...good, tier: 'css-path', strategy: { type: 'css', value: 'div > button' } }]),
      'abc',
    );
    expect(result.emitted).toHaveLength(0);
    expect(result.skipped[0].reason).toMatch(/brittle/i);
  });

  it('refuses to write a report containing personal data', () => {
    expect(() =>
      buildObservedModule(
        report([{ ...good, rootUrl: 'https://rm.test/?agent=sarah.chen@example.com' }]),
        'abc',
      ),
    ).toThrowError(/personal data/i);
  });

  it('skips a strategy that cannot be read back safely', () => {
    const result = buildObservedModule(
      report([{ ...good, strategy: { type: 'javascript', value: 'alert(1)' } }]),
      'abc',
    );
    expect(result.emitted).toHaveLength(0);
  });

  it('is deterministic, so drift detection is meaningful', () => {
    const first = buildObservedModule(report([good, { ...good, control: 'agents.create' }]), 'abc');
    const second = buildObservedModule(report([{ ...good, control: 'agents.create' }, good]), 'abc');
    expect(first.source).toBe(second.source);
  });

  it('does not mistake identifiers and UUIDs for personal data', () => {
    const result = buildObservedModule(
      report([{ ...good, rootUrl: 'https://rm.test/frame?id=998877665544' }]),
      'abc',
    );
    expect(result.emitted).toEqual(['agents.save']);
  });

  it('records the report it came from', () => {
    const result = buildObservedModule(report([good]), 'deadbeef');
    expect(result.source).toContain('deadbeef');
    expect(result.source).toContain('11111111-1111-1111-1111-111111111111');
  });
});
