import { describe, expect, it } from 'vitest';
import {
  PII_PLACEHOLDER,
  containsPersonalData,
  scrubDeep,
  scrubPersonalData,
} from '../src/security/personalData';

/**
 * Interface discovery reads real Readymode pages, which contain real people's
 * data. None of it is needed to identify a control, so none of it is kept.
 */
describe('personal data scrubbing', () => {
  const removed: Array<[string, string]> = [
    ['email', 'Contact sarah.chen@example.com for details'],
    ['phone', 'Call 555-867-5309 now'],
    ['phone with country code', '+1 (555) 867-5309'],
    ['ssn', 'SSN 123-45-6789'],
    ['card', 'Card 4111 1111 1111 1111'],
    ['street address', 'Lives at 1234 Sycamore Lane'],
    ['date of birth', 'Born 04/12/1985'],
    ['account number', 'Account 998877665544'],
  ];

  for (const [label, value] of removed) {
    it(`removes a ${label}`, () => {
      const result = scrubPersonalData(value);
      expect(result.text).toContain(PII_PLACEHOLDER);
      expect(result.dropped.length).toBeGreaterThan(0);
    });
  }

  const kept = [
    'Texas',
    'TX, VA, OH',
    'RS 1048',
    'Campaign 4',
    'Queue-7',
    'Save',
    'Clear License',
    'admin',
    'Assigned States',
  ];

  for (const value of kept) {
    it(`leaves interface text alone: ${value}`, () => {
      expect(scrubPersonalData(value).text).toBe(value);
      expect(containsPersonalData(value)).toBe(false);
    });
  }

  it('does not label a non-card digit run as a card number', () => {
    // Fails the Luhn check, so it is removed as an account number, not a card.
    expect(scrubPersonalData('1234567890123').dropped).toEqual(['long_number']);
  });

  it('leaves element identifiers intact so selectors are not corrupted', () => {
    // Structural fields keep their shape: scrubbing an id would break the very
    // selector discovery is trying to propose.
    const scrubbed = scrubDeep({ id: 'ctl00_user_1234567890', label: 'Username' }) as any;
    expect(scrubbed.id).toBe('ctl00_user_1234567890');
    expect(scrubbed.label).toBe('Username');
  });

  it('still removes real personal data from an identifier field', () => {
    const scrubbed = scrubDeep({ name: 'lead_sarah.chen@example.com' }) as any;
    expect(scrubbed.name).toContain(PII_PLACEHOLDER);
  });

  it('scrubs every string in a nested structure', () => {
    const counter = { dropped: 0 };
    const scrubbed = scrubDeep(
      {
        label: 'Owner',
        rows: [{ nearbyText: 'call 555-867-5309' }, { nearbyText: 'Assigned States' }],
      },
      counter,
    ) as any;

    expect(scrubbed.rows[0].nearbyText).toContain(PII_PLACEHOLDER);
    expect(scrubbed.rows[1].nearbyText).toBe('Assigned States');
    expect(counter.dropped).toBeGreaterThan(0);
  });
});
