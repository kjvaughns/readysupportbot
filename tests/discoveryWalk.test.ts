import { describe, expect, it } from 'vitest';
import { isSafeToClick } from '../src/readymode/discovery/walk';

/**
 * Discovery explores by clicking navigation. The guard below is what keeps that
 * exploration read-only: anything that could change data is refused, even when
 * it also looks like navigation.
 */
describe('safe-to-click guard', () => {
  const navigation = [
    'Users',
    'Agents',
    'License Usage',
    'Campaigns',
    'Queues',
    'Playlists',
    'Lead Management',
    'Reports',
    'VOIP',
    'Settings',
    'Admin',
  ];

  for (const label of navigation) {
    it(`allows the navigation item "${label}"`, () => {
      expect(isSafeToClick(label)).toBe(true);
    });
  }

  const dangerous = [
    'Save',
    'Save Campaign',
    'Delete User',
    'Remove Queue',
    'Deactivate Agent',
    'Reset Password',
    'Clear License',
    'Sign Out',
    'Create User',
    'Add Agent',
    'Import Leads',
    'Start Dialing',
    'Confirm',
    'Continue',
    'Charge Card',
  ];

  for (const label of dangerous) {
    it(`refuses "${label}"`, () => {
      expect(isSafeToClick(label)).toBe(false);
    });
  }

  it('refuses labels that are not recognizable navigation', () => {
    expect(isSafeToClick('')).toBe(false);
    expect(isSafeToClick('   ')).toBe(false);
    expect(isSafeToClick('Xyzzy')).toBe(false);
    expect(isSafeToClick('a'.repeat(80))).toBe(false);
  });

  it('refuses a dangerous action even when it names a section', () => {
    // "Delete Campaign" contains a navigation word, so the denylist has to win.
    expect(isSafeToClick('Delete Campaign')).toBe(false);
    expect(isSafeToClick('Save Queue Settings')).toBe(false);
  });
});
