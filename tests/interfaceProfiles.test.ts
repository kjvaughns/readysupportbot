import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore, setStore } from '../src/database';
import {
  deserializeStrategy,
  serializeStrategy,
  tryDeserializeStrategy,
} from '../src/readymode/selectors/serialize';
import { invalidateProfileCache, loadProfile } from '../src/readymode/selectors/resolve';
import { SelectorStrategy } from '../src/readymode/selectors';

let store: MemoryStore;

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function profileInput(organizationId: string, controls: string[]) {
  return {
    profile: {
      organizationId,
      schemaVersion: 1,
      baseUrl: 'https://rm.test/',
      interfaceVersion: 'starter' as const,
      pagesCaptured: 3,
      controlsTotal: 21,
      controlsProposed: controls.length,
      capabilities: [],
      unproposed: [],
      screenshotPaths: [],
      discoveredBy: 'user-1',
      discoveredAt: new Date().toISOString(),
      notes: null,
    },
    selectors: controls.map((control) => ({
      organizationId,
      controlName: control,
      strategy: { type: 'testId', value: `${control}-id` },
      tier: 'stable-attribute',
      confidence: 100,
      rootName: 'frame:body',
      rootUrl: 'https://rm.test/body',
      evidenceRef: {},
      verified: true,
      verifiedMatches: 1,
    })),
    evidence: { schemaVersion: 1, pages: [] },
  };
}

beforeEach(() => {
  store = new MemoryStore();
  setStore(store);
  invalidateProfileCache();
});

describe('interface profiles', () => {
  it('stores a discovery run as incomplete, never active', async () => {
    const profile = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.save']));

    // A fresh run has reached nothing yet, so it starts at the state that
    // cannot be approved.
    expect(profile.status).toBe('incomplete');
    expect(await store.getActiveInterfaceProfile(ORG_A)).toBeNull();
  });

  it('activates a profile only when an Owner approves it', async () => {
    const profile = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.save']));
    const approved = await store.approveInterfaceProfile({
      organizationId: ORG_A,
      profileId: profile.id,
      approvedBy: 'owner-1',
    });

    expect(approved.status).toBe('active');
    expect(approved.approvedBy).toBe('owner-1');
    expect((await store.getActiveInterfaceProfile(ORG_A))?.id).toBe(profile.id);
  });

  it('keeps exactly one active profile per organization', async () => {
    const first = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.save']));
    await store.approveInterfaceProfile({
      organizationId: ORG_A,
      profileId: first.id,
      approvedBy: 'owner-1',
    });

    const second = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.deactivate']));
    await store.approveInterfaceProfile({
      organizationId: ORG_A,
      profileId: second.id,
      approvedBy: 'owner-1',
    });

    const active = store.interfaceProfiles.filter(
      (entry) => entry.organizationId === ORG_A && entry.status === 'active',
    );
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.id);

    const superseded = store.interfaceProfiles.find((entry) => entry.id === first.id);
    expect(superseded?.status).toBe('superseded');
    expect(superseded?.supersededBy).toBe(second.id);
  });

  it('never leaks a profile across organizations', async () => {
    const profile = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.save']));
    await store.approveInterfaceProfile({
      organizationId: ORG_A,
      profileId: profile.id,
      approvedBy: 'owner-1',
    });

    expect(await store.getActiveInterfaceProfile(ORG_B)).toBeNull();
    expect(await store.listInterfaceProfiles(ORG_B, 10)).toHaveLength(0);
  });

  it('rejects a profile without activating it', async () => {
    const profile = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.save']));
    await store.rejectInterfaceProfile({
      organizationId: ORG_A,
      profileId: profile.id,
      notes: 'wrong screen',
    });

    expect(await store.getActiveInterfaceProfile(ORG_A)).toBeNull();
  });
});

describe('selector resolution order', () => {
  it('uses an approved profile selector ahead of the built-in guesses', async () => {
    const profile = await store.createInterfaceProfile(profileInput(ORG_A, ['agents.save']));
    await store.approveInterfaceProfile({
      organizationId: ORG_A,
      profileId: profile.id,
      approvedBy: 'owner-1',
    });

    const resolved = await loadProfile(ORG_A);
    expect(resolved.byControl.get('agents.save')?.source).toBe('approved_profile');
  });

  it('has nothing to offer before a profile is approved', async () => {
    const resolved = await loadProfile(ORG_A);
    // The committed observed file is empty until a real report is applied.
    expect(resolved.byControl.size).toBe(0);
    expect(resolved.profileId).toBeNull();
  });
});

describe('strategy serialization', () => {
  const strategies: SelectorStrategy[] = [
    { type: 'testId', value: 'save' },
    { type: 'role', role: 'button', name: /save|update/i },
    { type: 'label', value: /password/i, exact: false },
    { type: 'placeholder', value: 'Search' },
    { type: 'text', value: /logged ?in/i },
    { type: 'css', value: 'input[name="username"]' },
  ];

  for (const strategy of strategies) {
    it(`round-trips a ${strategy.type} strategy`, () => {
      const restored = deserializeStrategy(serializeStrategy(strategy));
      expect(restored).toEqual(strategy);
    });
  }

  it('refuses a stored pattern long enough to be a denial of service', () => {
    expect(() =>
      deserializeStrategy({ type: 'text', value: { __regex: { source: 'a'.repeat(5000), flags: 'i' } } }),
    ).toThrowError(/too long/i);
  });

  it('refuses unsupported pattern flags', () => {
    expect(() =>
      deserializeStrategy({ type: 'text', value: { __regex: { source: 'ok', flags: 'e' } } }),
    ).toThrowError(/flags/i);
  });

  it('refuses an unrecognized strategy type', () => {
    expect(() => deserializeStrategy({ type: 'javascript', value: 'alert(1)' })).toThrowError();
    expect(tryDeserializeStrategy({ type: 'javascript' })).toBeNull();
  });
});
