import { afterEach, describe, expect, it } from 'vitest';
import {
  applyOverlay,
  assertConfigured,
  coverage,
  DEFAULT_ROUTES,
  DEFAULT_SELECTORS,
  getSelector,
  isConfigured,
  setRegistry,
  UNKNOWN,
} from '../../src/readymode/selectors.js';
import { ReadySupportError } from '../../src/domain/errors.js';

afterEach(() => {
  setRegistry(undefined);
});

describe('the shipped registry', () => {
  it('claims nothing about Readymode: every value starts UNKNOWN', () => {
    // This is the guarantee that no route, label or button in this codebase is
    // a guess about the real product. If someone hard-codes one, this fails.
    for (const [id, spec] of Object.entries(DEFAULT_SELECTORS)) {
      expect(spec.value, `selector ${id} ships with a value`).toBe(UNKNOWN);
      expect(spec.verified, `selector ${id} claims to be verified`).toBe(false);
    }

    for (const [id, spec] of Object.entries(DEFAULT_ROUTES)) {
      expect(spec.path, `route ${id} ships with a path`).toBe(UNKNOWN);
      expect(spec.verified).toBe(false);
    }
  });

  it('describes every entry, so discovery knows what to look for', () => {
    for (const spec of [...Object.values(DEFAULT_SELECTORS), ...Object.values(DEFAULT_ROUTES)]) {
      expect(spec.description.length).toBeGreaterThan(20);
    }
  });
});

describe('assertConfigured', () => {
  it('refuses to run a workflow whose selectors are unmapped', () => {
    setRegistry(undefined);

    try {
      assertConfigured({
        workflow: 'clear license',
        selectorIds: ['agents.search.input', 'clearLicense.trigger.button'],
        routeIds: ['route.agents'],
      });
      expect.unreachable('should have refused');
    } catch (error) {
      const readySupportError = error as ReadySupportError;
      expect(readySupportError.category).toBe('SELECTOR_NOT_CONFIGURED');
      expect(readySupportError.details['missingSelectors']).toEqual([
        'agents.search.input',
        'clearLicense.trigger.button',
      ]);
      expect(readySupportError.details['missingRoutes']).toEqual(['route.agents']);
    }
  });

  it('reports every gap at once rather than one per failed job', () => {
    try {
      assertConfigured({
        workflow: 'create account',
        selectorIds: ['create.firstName.input', 'create.lastName.input', 'create.email.input'],
      });
      expect.unreachable('should have refused');
    } catch (error) {
      expect((error as ReadySupportError).details['missingSelectors']).toHaveLength(3);
    }
  });

  it('passes once the values are supplied', () => {
    setRegistry({
      selectors: {
        ...DEFAULT_SELECTORS,
        'agents.search.input': {
          id: 'agents.search.input',
          description: 'search',
          strategy: 'placeholder',
          value: 'Search agents',
          verified: true,
        },
      },
      routes: {
        ...DEFAULT_ROUTES,
        'route.agents': { id: 'route.agents', description: 'list', path: '/agents', verified: true },
      },
    });

    expect(() =>
      assertConfigured({
        workflow: 'search',
        selectorIds: ['agents.search.input'],
        routeIds: ['route.agents'],
      }),
    ).not.toThrow();

    expect(isConfigured('agents.search.input')).toBe(true);
    expect(isConfigured('clearLicense.trigger.button')).toBe(false);
  });
});

describe('overlays', () => {
  it('merges captured values over the defaults', () => {
    const registry = {
      routes: { ...structuredClone(DEFAULT_ROUTES) },
      selectors: { ...structuredClone(DEFAULT_SELECTORS) },
      overlayPath: null,
      loadedAt: new Date().toISOString(),
    };

    applyOverlay(
      {
        routes: { 'route.agents': { path: '/admin/agents' } },
        selectors: {
          'agents.search.input': { strategy: 'placeholder', value: 'Find an agent' },
        },
      },
      registry,
    );

    expect(registry.routes['route.agents']?.path).toBe('/admin/agents');
    expect(registry.routes['route.agents']?.verified).toBe(true);
    expect(registry.selectors['agents.search.input']?.value).toBe('Find an agent');
    // Untouched entries stay unmapped rather than being invented.
    expect(registry.selectors['create.submit.button']?.value).toBe(UNKNOWN);
  });

  it('ignores an id that is not in the registry rather than inventing one', () => {
    // A typo in a hand-edited overlay would otherwise create a selector no
    // workflow ever asks for, while the real one stayed unmapped unnoticed.
    const registry = {
      routes: { ...structuredClone(DEFAULT_ROUTES) },
      selectors: { ...structuredClone(DEFAULT_SELECTORS) },
      overlayPath: null,
      loadedAt: new Date().toISOString(),
    };

    applyOverlay({ selectors: { 'agents.serch.input': { value: 'oops' } } }, registry);

    expect(registry.selectors['agents.serch.input']).toBeUndefined();
    expect(registry.selectors['agents.search.input']?.value).toBe(UNKNOWN);
  });
});

describe('coverage reporting', () => {
  it('reports nothing mapped for a fresh install', () => {
    setRegistry(undefined);
    const map = coverage();

    expect(map.configured).toBe(0);
    expect(map.total).toBe(Object.keys(DEFAULT_SELECTORS).length + Object.keys(DEFAULT_ROUTES).length);
    expect(map.missing).toContain('route.agents');
  });
});

describe('getSelector', () => {
  it('fails loudly on an id nobody declared', () => {
    expect(() => getSelector('does.not.exist')).toThrow(/No selector is declared/);
  });
});
