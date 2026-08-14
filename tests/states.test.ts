import { describe, expect, it } from 'vitest';
import {
  US_STATES,
  applyStateOperation,
  diffStates,
  formatStates,
  normalizeState,
  normalizeStateList,
  requireStates,
  sortStates,
} from '../src/readymode/states';

describe('state normalization', () => {
  it('covers the fifty states and Washington, DC', () => {
    expect(US_STATES).toHaveLength(51);
    expect(US_STATES.map((state) => state.abbr)).toContain('DC');
  });

  it('accepts postal abbreviations in any case', () => {
    expect(normalizeState('tx')).toBe('TX');
    expect(normalizeState('Va')).toBe('VA');
    expect(normalizeState(' OH ')).toBe('OH');
  });

  it('accepts full state names', () => {
    expect(normalizeState('Texas')).toBe('TX');
    expect(normalizeState('virginia')).toBe('VA');
    expect(normalizeState('New Hampshire')).toBe('NH');
    expect(normalizeState('west virginia')).toBe('WV');
  });

  it('resolves Washington, DC without confusing it with Washington state', () => {
    expect(normalizeState('Washington')).toBe('WA');
    expect(normalizeState('Washington, DC')).toBe('DC');
    expect(normalizeState('District of Columbia')).toBe('DC');
    expect(normalizeState('DC')).toBe('DC');
  });

  it('rejects values that are not states', () => {
    expect(normalizeState('Ontario')).toBeNull();
    expect(normalizeState('ZZ')).toBeNull();
    expect(normalizeState('')).toBeNull();
    expect(normalizeState('Carolina')).toBeNull();
  });

  it('splits a written list and reports what it could not resolve', () => {
    const result = normalizeStateList('TX, Virginia and Ohio');
    expect(result.states).toEqual(['OH', 'TX', 'VA']);
    expect(result.invalid).toEqual([]);

    const mixed = normalizeStateList('TX, Atlantis, OH');
    expect(mixed.states).toEqual(['OH', 'TX']);
    expect(mixed.invalid).toEqual(['Atlantis']);
  });

  it('collapses duplicates and sorts canonically', () => {
    expect(sortStates(['VA', 'TX', 'TX', 'OH'])).toEqual(['OH', 'TX', 'VA']);
  });

  it('throws with the offending values listed', () => {
    expect(() => requireStates('TX, Narnia')).toThrowError(/Narnia/);
    expect(() => requireStates([])).toThrowError(/No states/);
    expect(requireStates('tx,va,oh')).toEqual(['OH', 'TX', 'VA']);
  });

  it('formats for display', () => {
    expect(formatStates(['TX', 'VA', 'OH'])).toBe('OH, TX, VA');
    expect(formatStates([])).toBe('none');
  });
});

describe('state differences', () => {
  it('reports what was added and removed', () => {
    const diff = diffStates(['TX', 'FL', 'GA'], ['TX', 'VA', 'OH']);
    expect(diff.previous).toEqual(['FL', 'GA', 'TX']);
    expect(diff.next).toEqual(['OH', 'TX', 'VA']);
    expect(diff.added).toEqual(['OH', 'VA']);
    expect(diff.removed).toEqual(['FL', 'GA']);
    expect(diff.unchanged).toEqual(['TX']);
    expect(diff.changed).toBe(true);
  });

  it('reports no change when the sets match', () => {
    const diff = diffStates(['VA', 'TX'], ['TX', 'VA']);
    expect(diff.changed).toBe(false);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('applies each supported operation', () => {
    expect(applyStateOperation('SET_STATES', ['TX', 'FL'], ['VA', 'OH'])).toEqual(['OH', 'VA']);
    expect(applyStateOperation('ADD_STATES', ['TX'], ['FL'])).toEqual(['FL', 'TX']);
    expect(applyStateOperation('REMOVE_STATES', ['TX', 'CA', 'FL'], ['CA'])).toEqual(['FL', 'TX']);
  });

  it('removing a state that is not assigned changes nothing', () => {
    expect(applyStateOperation('REMOVE_STATES', ['TX'], ['CA'])).toEqual(['TX']);
  });
});
