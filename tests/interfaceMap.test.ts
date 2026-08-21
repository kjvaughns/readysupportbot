import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BLOCKED_AREAS,
  INTERFACE_CONTROLS,
  INTERFACE_PAGES,
  SHELL_NAVIGATION,
  interfaceControl,
  routeUrl,
} from '../src/readymode/interface/registry';
import {
  AUTOMATABLE_STATUSES,
  EVIDENCE_STATUSES,
  isAutomatable,
  isModifying,
} from '../src/readymode/interface/types';

/**
 * The registry is a transcription of a read-only inspection. These tests are
 * what stop it becoming something else: every selector must still appear in the
 * inspection file, and nothing that was only *described* may ever be treated as
 * something that was *seen*.
 */

const map = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'readysupport_interface_map.json'), 'utf8'),
);

/** Every selector string the inspection recorded, anywhere in the file. */
function selectorsInMap(): Set<string> {
  const found = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === 'string' && (key === 'selector' || key === 'id')) found.add(value);
        else walk(value);
      }
    }
  };
  walk(map);
  return found;
}

describe('the inspection file itself', () => {
  it('carries no tenant hostname, because this repository is public', () => {
    const text = JSON.stringify(map);
    expect(text).not.toMatch(/apexfinancial/i);
    // Every tenant URL is a placeholder resolved per organization at run time.
    expect(text).not.toMatch(/https:\/\/[a-z0-9-]+\.readymode\.com/i);
  });

  it('states that it was captured read-only, with personal data excluded', () => {
    expect(map.mode).toBe('read_only_metadata_only');
    expect(map.privacy.excluded).toEqual(
      expect.arrayContaining(['passwords', 'cookies', 'tokens', 'input values']),
    );
  });

  it('uses the same status vocabulary the registry does', () => {
    expect(map.selector_policy.allowed_statuses.sort()).toEqual([...EVIDENCE_STATUSES].sort());
    expect(map.selector_policy.approval_required).toBe(true);
  });
});

describe('registry entries trace back to the inspection', () => {
  const observed = selectorsInMap();

  const transcribed = INTERFACE_CONTROLS.filter(
    (control) =>
      control.strategy.type === 'css' &&
      !control.strategy.value.startsWith('__') &&
      // Inferred from observed column headings rather than a recorded selector,
      // which is why it is `documented` and not `discovered`.
      control.key !== 'licenses.users_table',
  );

  for (const control of transcribed) {
    it(`${control.key} uses a selector the inspection recorded`, () => {
      const value = (control.strategy as { value: string }).value;
      const bare = value.replace(/^#/, '');
      expect(
        observed.has(value) || observed.has(bare) || [...observed].some((entry) => entry.includes(bare)),
      ).toBe(true);
    });
  }

  it('covers every page the inspection recorded', () => {
    const pageKeys = INTERFACE_PAGES.map((page) => page.key);
    for (const page of map.pages) expect(pageKeys).toContain(page.key);
  });

  it('covers every navigation destination the inspection recorded', () => {
    const routes = SHELL_NAVIGATION.map((entry) => entry.route);
    for (const entry of map.shell.navigation) expect(routes).toContain(entry.path);
  });

  it('records every blocked area, rather than quietly dropping it', () => {
    expect(BLOCKED_AREAS).toHaveLength(map.blocked_or_unverified.length);
  });
});

describe('documented is never treated as verified', () => {
  it('excludes documented, blocked and unsupported from automation', () => {
    expect(AUTOMATABLE_STATUSES).toEqual(['discovered', 'dry_run_tested', 'live_tested']);
    expect(isAutomatable('documented')).toBe(false);
    expect(isAutomatable('blocked')).toBe(false);
    expect(isAutomatable('unsupported')).toBe(false);
    // Code existing is not evidence about the interface.
    expect(isAutomatable('implemented')).toBe(false);
  });

  it('keeps the bulk sign-out control unautomatable until it is seen', () => {
    const control = interfaceControl('licenses.sign_out_inactive');
    expect(control?.evidenceStatus).toBe('documented');
    expect(isAutomatable(control!.evidenceStatus)).toBe(false);
  });

  it('never marks an unresolved selector as usable', () => {
    for (const control of INTERFACE_CONTROLS) {
      if (control.strategy.type === 'css' && control.strategy.value.startsWith('__')) {
        expect(isAutomatable(control.evidenceStatus)).toBe(false);
      }
    }
  });

  it('gives every control that has never been verified a null verification date', () => {
    for (const control of INTERFACE_CONTROLS) {
      if (control.interfaceVersion === 'iq') expect(control.lastVerified).toBeNull();
    }
  });
});

describe('safety classification', () => {
  it('classifies signing a user out as terminating a session', () => {
    const control = interfaceControl('licenses.sign_out_user');
    expect(control?.safety).toBe('terminates_session');
    expect(isModifying(control!.safety)).toBe(true);
    expect(control?.perRow).toBe(true);
  });

  it('refuses to automate anything that signs out every user', () => {
    const control = interfaceControl('licenses.sign_out_all');
    expect(control?.evidenceStatus).toBe('unsupported');
    expect(isAutomatable(control!.evidenceStatus)).toBe(false);
  });

  it('treats passwords and lead uploads as work for a person', () => {
    expect(interfaceControl('users.bulk_passwords')?.safety).toBe('human_only');
    expect(interfaceControl('leads.upload_file')?.safety).toBe('human_only');
  });

  it('never opens the lead rows inside a queue', () => {
    const control = interfaceControl('queue.view_leads_tab');
    expect(control?.evidenceStatus).toBe('unsupported');
  });

  it('gives every modifying control a postcondition to verify against', () => {
    for (const control of INTERFACE_CONTROLS) {
      if (!isModifying(control.safety)) continue;
      if (!isAutomatable(control.evidenceStatus)) continue;
      expect(control.postconditions.length).toBeGreaterThan(0);
    }
  });
});

describe('playlist filtering and iQ calling restrictions stay separate', () => {
  it('describes them as different controls with different purposes', () => {
    const playlist = interfaceControl('playlists.location_filter');
    const restriction = interfaceControl('iq.state_calling_restrictions');

    expect(playlist?.page).toBe('playlist_editor');
    expect(restriction?.page).toBe('iq_advanced_settings');
    expect(playlist?.interfaceVersion).toBe('starter');
    expect(restriction?.interfaceVersion).toBe('iq');

    // Each one's notes must warn against substituting the other.
    expect(playlist?.notes).toMatch(/calling window|restriction/i);
    expect(restriction?.notes).toMatch(/lead|assignment/i);
  });
});

describe('route resolution', () => {
  it('resolves against the organization\'s own base URL', () => {
    expect(routeUrl('https://acme.readymode.com/login', '-Team/ManageUsers')).toBe(
      'https://acme.readymode.com/-Team/ManageUsers',
    );
  });

  it('keeps a leading plus literal, as the inspection recorded it', () => {
    expect(routeUrl('https://acme.readymode.com', '+Team/ManageLicenses')).toBe(
      'https://acme.readymode.com/+Team/ManageLicenses',
    );
  });

  it('encodes spaces and nothing else', () => {
    expect(routeUrl('https://acme.readymode.com', '-AI Leads/pools')).toBe(
      'https://acme.readymode.com/-AI%20Leads/pools',
    );
  });
});
