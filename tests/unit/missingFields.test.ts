import { describe, expect, it } from 'vitest';
import { buildProvideDetailsRow, readMissingFields } from '../../src/discord/outcomeSink.js';
import { decodeComponentId } from '../../src/discord/customIds.js';
import { OPTIONAL_FIELDS } from '../../src/readymode/workflows/createAccount.js';

/**
 * When Readymode turns out to require a field ReadySupport treats as optional,
 * the requester gets a form rather than an apology. These check the wiring that
 * carries the field list from the failure to that form.
 */

describe('fields a failure asks for', () => {
  it('reads the list off a failure', () => {
    expect(readMissingFields({ missingFields: ['team', 'campaign'] })).toEqual(['team', 'campaign']);
  });

  it('returns nothing when a failure did not ask for any', () => {
    expect(readMissingFields({})).toEqual([]);
    expect(readMissingFields({ missingFields: 'team' })).toEqual([]);
    expect(readMissingFields({ missingFields: [] })).toEqual([]);
  });

  it('drops anything that is not a field name', () => {
    expect(readMissingFields({ missingFields: ['team', 42, null, 'queue'] })).toEqual(['team', 'queue']);
  });

  it('never asks for more than a Discord form can hold', () => {
    const many = Array.from({ length: 12 }, (_value, index) => `field${index}`);
    expect(readMissingFields({ missingFields: many })).toHaveLength(5);
  });
});

/** Buttons with an SKU id have no custom_id, so the union needs narrowing. */
function customIdOf(row: ReturnType<typeof buildProvideDetailsRow>): string {
  const component = row.toJSON().components[0];
  return component && 'custom_id' in component ? component.custom_id : '';
}

describe('the form button', () => {
  const requestId = crypto.randomUUID();

  it('carries the field list intact', () => {
    const fields = OPTIONAL_FIELDS.map((field) => field.key);
    const row = buildProvideDetailsRow(requestId, [...fields]);

    const decoded = decodeComponentId(customIdOf(row));

    expect(decoded?.kind).toBe('provide_info');
    expect(decoded?.requestId).toBe(requestId);
    // Every field name survives — a truncated list would open a form asking
    // for a field that does not exist.
    expect(decoded?.nonce.split('-')).toEqual([...fields]);
  });

  it('stays inside the length Discord allows, with every optional field asked for', () => {
    const row = buildProvideDetailsRow(requestId, OPTIONAL_FIELDS.map((field) => field.key));
    const customId = customIdOf(row);

    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it('refuses to build an id too long for Discord rather than truncating one', () => {
    const absurd = Array.from({ length: 10 }, () => 'averylongfieldname');
    expect(() => buildProvideDetailsRow(requestId, absurd)).toThrow(/too long/i);
  });
});

describe('the optional fields themselves', () => {
  it('are the ones a Readymode instance might make mandatory', () => {
    expect(OPTIONAL_FIELDS.map((field) => field.key)).toEqual(['team', 'campaign', 'queue']);
  });

  it('each name a selector in the registry', async () => {
    const { DEFAULT_SELECTORS } = await import('../../src/readymode/selectors.js');
    for (const field of OPTIONAL_FIELDS) {
      expect(DEFAULT_SELECTORS[field.selectorId], field.selectorId).toBeDefined();
    }
  });
});
