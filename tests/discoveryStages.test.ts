import { describe, expect, it } from 'vitest';
import { assessReadiness, REQUIRED_NAVIGATION_CONTROLS } from '../src/readymode/discovery/readiness';
import { CRAWL_TARGETS, WORKFLOW_PROBES, furthestStage } from '../src/readymode/discovery/stages';
import { proposeSelectors } from '../src/readymode/discovery/propose';
import { ALL_CONTROLS, LOGIN_CONTROLS } from '../src/readymode/selectors';
import { InterfaceEvidence, PageEvidence, RootEvidence } from '../src/readymode/discovery/evidence';
import { findArrival, findExactLabel, openPanel } from '../src/readymode/navigation';
import { buildFakePage, mutationsIn, navigationsIn } from './support/fakePage';
import type { FakeRootSpec } from './support/fakePage';

/**
 * A discovery run reported success having seen only the login page, and the
 * resulting profile was offered for approval. These hold the two halves of that
 * failure apart: the crawl has to actually happen, and a run that never got
 * past the login screen must never be presentable as one that did.
 */

const BASE = 'https://acme.readymode.com';

function root(overrides: Partial<RootEvidence> = {}): RootEvidence {
  return {
    rootName: 'main document',
    rootUrl: BASE,
    isMain: true,
    title: '',
    childFrameUrls: [],
    nav: [],
    buttons: [],
    inputs: [],
    selects: [],
    checkboxes: [],
    links: [],
    forms: [],
    tables: [],
    clickables: [],
    headings: [],
    truncated: [],
    ...overrides,
  };
}

function page(step: string, roots: RootEvidence[]): PageEvidence {
  return {
    step,
    pageUrl: BASE,
    pageTitle: '',
    panelState: null,
    roots,
    screenshotPath: null,
  };
}

function evidence(pages: PageEvidence[]): InterfaceEvidence {
  return {
    schemaVersion: 1,
    capturedAt: new Date(0).toISOString(),
    baseUrl: BASE,
    pages,
    redactions: { personalDataDropped: 0, passwordFieldsSeen: 0, truncatedCategories: [] },
  };
}

describe('a password field is identified by its type', () => {
  /**
   * The real failure: a password field's placeholder is deliberately withheld
   * from evidence, so a login form whose password input carries no id and no
   * name had nothing left but a positional CSS path — which is never
   * promotable. It reported one match and stayed unusable, while username and
   * submit resolved beside it.
   */
  const passwordOnly = evidence([
    page(
      'login',
      [
        root({
          inputs: [
            {
              ordinal: 1,
              tag: 'input',
              visible: true,
              type: 'password',
              required: true,
              readOnly: false,
              sensitive: true,
              cssPath: 'form > div:nth-of-type(2) > input',
            },
          ],
        }),
      ],
    ),
  ]);

  it('proposes a stable selector with no id, name or placeholder to go on', () => {
    const outcome = proposeSelectors(passwordOnly, [LOGIN_CONTROLS.password]);

    expect(outcome.proposals).toHaveLength(1);
    expect(outcome.proposals[0].strategy).toEqual({ type: 'css', value: 'input[type="password"]' });
    expect(outcome.proposals[0].tier).toBe('field-type');
  });

  it('makes it usable, rather than one match that is never confirmed', () => {
    const outcome = proposeSelectors(passwordOnly, [LOGIN_CONTROLS.password]);
    expect(outcome.proposals[0].confidence).toBeGreaterThanOrEqual(60);
    expect(outcome.unproposed).toEqual([]);
  });

  it('never records the value of a password field', () => {
    const outcome = proposeSelectors(passwordOnly, [LOGIN_CONTROLS.password]);

    // The only `value` anywhere is the selector's own text.
    expect(JSON.stringify(outcome)).not.toMatch(/"value"\s*:\s*"(?!input\[type)/);
    // A password field's placeholder is withheld at collection, so no strategy
    // can be built from one.
    expect(outcome.proposals[0].strategy.type).not.toBe('placeholder');
    expect(outcome.proposals[0].evidence.excerpt).not.toMatch(/password/i);
  });

  it('still refuses when two password fields are on one page', () => {
    const two = evidence([
      page('login', [
        root({
          inputs: [
            { ordinal: 1, tag: 'input', visible: true, type: 'password', required: true, readOnly: false, sensitive: true, cssPath: 'a > input' },
            { ordinal: 2, tag: 'input', visible: true, type: 'password', required: true, readOnly: false, sensitive: true, cssPath: 'b > input' },
          ],
        }),
      ]),
    ]);

    const outcome = proposeSelectors(two, [LOGIN_CONTROLS.password]);

    expect(outcome.proposals).toHaveLength(0);
    // And it must not fall back to "the second one, positionally".
    expect(outcome.ambiguous.map((entry) => entry.control)).toContain('login.password');
  });
});

describe('the same control seen on two screens is one control', () => {
  it('does not treat surviving navigation as ambiguity', () => {
    const searchField = {
      ordinal: 1,
      tag: 'input',
      id: 'userMgmtSearchUser',
      visible: true,
      type: 'search',
      required: false,
      readOnly: false,
      sensitive: false,
      placeholder: 'Search Users',
      labelText: 'Search Users',
    };

    // Captured on two screens, because the crawl visits several. Counting
    // globally made every persistent control look ambiguous — which is a
    // control being more reliable, not less.
    const twice = evidence([
      page('screen:user_management', [root({ inputs: [searchField as never] })]),
      page('workflow:search_agent', [root({ inputs: [searchField as never] })]),
    ]);

    const outcome = proposeSelectors(twice, ALL_CONTROLS);
    expect(outcome.proposals.map((proposal) => proposal.control)).toContain('agents.search');
  });
});

describe('the crawl covers the screens that were asked for', () => {
  const routes = new Map(CRAWL_TARGETS.map((target) => [target.key, target.route]));

  it('visits every named administrative screen', () => {
    for (const key of [
      'dashboard',
      'user_management',
      'license_usage',
      'lead_management',
      'queues',
      'campaigns',
      'settings',
      'voip',
      'lead_distribution',
      'agent_options',
    ]) {
      expect(routes.has(key), `${key} is not crawled`).toBe(true);
    }
  });

  it('uses the routes the inspection recorded, not invented ones', () => {
    expect(routes.get('user_management')).toBe('-Team/ManageUsers');
    expect(routes.get('license_usage')).toBe('+Team/ManageLicenses');
    expect(routes.get('lead_distribution')).toBe('!Configure/AI Leads/Lead distribution');
    for (const route of routes.values()) expect(route).not.toMatch(/^\/admin/);
  });

  it('walks a workflow for every one that was asked for', () => {
    const keys = WORKFLOW_PROBES.map((probe) => probe.key);
    for (const key of [
      'search_agent',
      'open_agent',
      'create_agent',
      'clear_license',
      'reset_password',
      'deactivate_agent',
      'force_logout',
      'logout_inactive',
      'manage_states',
      'manage_campaigns',
      'manage_queues',
      'manage_playlists',
      'assign_playlist',
      'save_agent',
    ]) {
      expect(keys, `${key} has no probe`).toContain(key);
    }
  });

  it('states a reason for every workflow it already knows it cannot walk', () => {
    for (const probe of WORKFLOW_PROBES) {
      if (probe.blocked) expect(probe.blocked.length).toBeGreaterThan(20);
    }
  });
});

describe('recognizing a screen', () => {
  const heading = (text: string) => ({
    text,
    css: ['h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption, .panel-title, .panelTitle, .ui-dialog-title'],
  });

  it('accepts a heading element', async () => {
    const { page: fake } = buildFakePage([
      { name: 'page', url: BASE, elements: [heading('User Management')] },
    ]);

    expect(await findArrival(fake, ['User Management'], 50)).toEqual({
      heading: 'User Management',
      evidence: 'heading',
    });
  });

  it('accepts the window title when no heading element carries the name', async () => {
    // The failure this fixes: Starter does not always render a heading element,
    // so requiring one judged every authenticated screen not to have opened.
    const { page: fake } = buildFakePage([
      { name: 'page', url: BASE, title: 'Readymode — License Usage', elements: [] },
    ]);

    expect(await findArrival(fake, ['License Usage'], 50)).toEqual({
      heading: 'License Usage',
      evidence: 'title',
    });
  });

  it('is not fooled by a navigation link carrying the screen name', async () => {
    // A link reading "User Management" is not the User Management screen, and
    // confirming from it would capture the dashboard under the wrong name.
    const { page: fake } = buildFakePage([
      {
        name: 'page',
        url: `${BASE}/-Dashboard`,
        title: 'Dashboard',
        elements: [heading('Dashboard'), { role: 'link', name: 'User Management', text: 'User Management' }],
      },
    ]);

    const arrival = await findArrival(fake, ['User Management'], 50);
    expect(arrival.heading).toBeNull();
    expect(arrival.evidence).toBe('none');
  });
});

describe('frames', () => {
  it('inspects every accessible frame, and names them so they do not collide', async () => {
    const roots: FakeRootSpec[] = [
      { name: 'page', url: BASE, elements: [] },
      { name: 'body', url: `${BASE}/body`, elements: [{ role: 'link', name: 'Queues', text: 'Queues' }] },
      { name: '', url: `${BASE}/anon`, elements: [] },
    ];

    const { page: fake } = buildFakePage(roots);
    const { listSearchRoots, rootName, locationLabel } = await import(
      '../src/readymode/selectors/frames'
    );

    const searchRoots = listSearchRoots(fake);
    expect(searchRoots).toHaveLength(3);

    const names = searchRoots.map((entry, index) => rootName(entry, index));
    expect(names).toEqual(['main document', 'frame "body"', 'frame #2']);
    // "pagepage" came from a review screen joining two names itself.
    expect(new Set(names).size).toBe(names.length);
    expect(locationLabel('dashboard', 'main document')).toBe('dashboard');
    expect(locationLabel('dashboard', 'frame "body"')).toBe('dashboard → frame "body"');
  });

  it('finds a control that lives inside a frame', async () => {
    const { page: fake } = buildFakePage([
      { name: 'page', url: BASE, elements: [] },
      {
        name: 'body',
        url: `${BASE}/body`,
        elements: [{ role: 'link', name: 'License Usage', text: 'License Usage' }],
      },
    ]);

    expect(await findExactLabel(fake, 'License Usage')).not.toBeNull();
  });

  it('does not count a hidden element as a visible match', async () => {
    const { page: fake } = buildFakePage([
      {
        name: 'page',
        url: BASE,
        elements: [
          { role: 'link', name: 'Queues', text: 'Queues', visible: false },
          { role: 'link', name: 'Queues', text: 'Queues' },
        ],
      },
    ]);

    // Two in the DOM, one visible: that is a unique match, not an ambiguous one.
    expect(await findExactLabel(fake, 'Queues')).not.toBeNull();
  });
});

describe('the crawl continues after signing in', () => {
  const heading = (text: string) => ({
    text,
    css: ['h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption, .panel-title, .panelTitle, .ui-dialog-title'],
  });

  it('reaches an administrative screen by its route', async () => {
    const dashboard: FakeRootSpec[] = [
      { name: 'page', url: `${BASE}/-Dashboard`, elements: [heading('Dashboard')] },
    ];
    const users: FakeRootSpec[] = [
      {
        name: 'page',
        url: `${BASE}/-Team/ManageUsers`,
        elements: [heading('User Management'), { css: ['#userMgmtSearchUser'], placeholder: 'Search Users' }],
      },
    ];

    const { page: fake, log } = buildFakePage(dashboard, {
      screens: { '-Dashboard': dashboard, '-Team/ManageUsers': users },
      start: '-Dashboard',
    });

    const result = await openPanel(fake, 'users', { timeoutMs: 200 });

    expect(result.opened).toBe(true);
    expect(result.heading).toBe('User Management');
    expect(navigationsIn(log).some((url) => url.includes('-Team/ManageUsers'))).toBe(true);
    // Navigating is not a mutation.
    expect(mutationsIn(log)).toEqual([]);
  });
});

describe('readiness', () => {
  const proposal = (control: string) =>
    ({
      control,
      strategy: { type: 'css', value: `#${control}` },
      tier: 'id',
      confidence: 92,
      pageStep: 'screen:user_management',
      rootName: 'main document',
      rootUrl: BASE,
      evidence: { category: 'input', ordinal: 1, matchedOn: [], excerpt: '' },
    }) as never;

  const full = REQUIRED_NAVIGATION_CONTROLS.map(proposal);

  it('refuses to call a login-only run reviewable', () => {
    const assessment = assessReadiness({
      proposals: [proposal('login.username'), proposal('login.submit')],
      workflows: [],
      dashboardConfirmed: true,
      screensInspected: 1,
    });

    expect(assessment.readiness).toBe('incomplete');
    expect(assessment.loginOnly).toBe(true);
    expect(assessment.summary).toMatch(/credentials work and nothing else/i);
  });

  it('refuses when the authenticated interface was never confirmed', () => {
    const assessment = assessReadiness({
      proposals: full,
      workflows: [],
      dashboardConfirmed: false,
      screensInspected: 4,
    });

    expect(assessment.readiness).toBe('incomplete');
    expect(assessment.summary).toMatch(/never confirmed/i);
  });

  it('refuses when no administrative screen was inspected', () => {
    const assessment = assessReadiness({
      proposals: full,
      workflows: [],
      dashboardConfirmed: true,
      screensInspected: 0,
    });

    expect(assessment.readiness).toBe('incomplete');
  });

  it('names the required controls that are still missing', () => {
    const assessment = assessReadiness({
      proposals: [proposal('agents.search')],
      workflows: [],
      dashboardConfirmed: true,
      screensInspected: 5,
    });

    expect(assessment.readiness).toBe('incomplete');
    expect(assessment.missing).toContain('licenses.table');
    expect(assessment.satisfied).toContain('agents.search');
  });

  it('refuses when a workflow could not be walked and does not say why', () => {
    const assessment = assessReadiness({
      proposals: full,
      workflows: [
        { key: 'create_agent', intent: '', reached: [], unreachable: [], controlsFound: [], controlsMissing: [], status: 'blocked' },
      ],
      dashboardConfirmed: true,
      screensInspected: 5,
    });

    expect(assessment.readiness).toBe('incomplete');
    expect(assessment.undocumentedWorkflows).toContain('create_agent');
    expect(assessment.summary).toMatch(/unexplained gap/i);
  });

  it('is ready only when everything required resolved and every gap is explained', () => {
    const assessment = assessReadiness({
      proposals: full,
      workflows: [
        {
          key: 'create_agent',
          intent: '',
          reached: [],
          unreachable: [],
          controlsFound: [],
          controlsMissing: [],
          status: 'blocked',
          reason: 'The creation tool opens from an unlabelled icon the inspection could not resolve.',
        },
      ],
      dashboardConfirmed: true,
      screensInspected: 6,
    });

    expect(assessment.readiness).toBe('ready_for_review');
    expect(assessment.unsupportedWorkflows).toHaveLength(1);
  });
});

describe('stage reporting', () => {
  it('reports the furthest stage a run reached', () => {
    expect(
      furthestStage([
        { stage: 'login_page_confirmed', reached: true, at: '' },
        { stage: 'credentials_submitted', reached: true, at: '' },
        { stage: 'authenticated_dashboard_confirmed', reached: false, at: '' },
      ]),
    ).toBe('credentials_submitted');
  });

  it('reports nothing when even the login page was not inspected', () => {
    expect(furthestStage([{ stage: 'login_page_confirmed', reached: false, at: '' }])).toBeNull();
  });
});

describe('every requested control has an evidence matcher', () => {
  it('leaves none of them unmatchable', async () => {
    const { CONTROL_MATCHERS } = await import('../src/readymode/discovery/propose');
    const defined = new Set(CONTROL_MATCHERS.map((matcher) => matcher.control));

    // A control with no matcher can never resolve, however many times the
    // interface is crawled. That is a gap in this repository, not in Readymode.
    const missing = ALL_CONTROLS.filter((control) => !defined.has(control.name));
    expect(missing.map((control) => control.name)).toEqual([]);
  });

  it('reports a control with no matcher separately from one that was not found', () => {
    const outcome = proposeSelectors(evidence([page('screen:users', [root({})])]), [
      { name: 'invented.control', description: 'x', candidates: [], required: true },
    ]);

    expect(outcome.withoutMatchers.map((entry) => entry.control)).toEqual(['invented.control']);
    expect(outcome.unresolved).toEqual([]);
  });
});

describe('a proposal carries what it needs to be checked', () => {
  it('states the precondition and postcondition its matcher defined', () => {
    const licenseTable = evidence([
      {
        step: 'screen:license_usage',
        pageUrl: `${BASE}/+Team/ManageLicenses`,
        pageTitle: 'License Usage',
        panelState: 'License Usage',
        screenshotPath: null,
        roots: [
          root({
            tables: [
              {
                ordinal: 1,
                tag: 'table',
                id: 'license-table',
                visible: true,
                headings: ['User Id', 'User Account', 'User Name', 'License Type', 'Signed In'],
                rowCount: 3,
                rowControls: ['Sign Out'],
              },
            ],
          }),
        ],
      },
    ]);

    const outcome = proposeSelectors(licenseTable, ALL_CONTROLS);
    const table = outcome.proposals.find((proposal) => proposal.control === 'licenses.table');

    expect(table).toBeDefined();
    expect(table?.postcondition).toBeTruthy();
  });

  it('will not propose a control from a screen its matcher does not name', () => {
    // `agents.logged_in` is observed on License Usage. A table on the dashboard
    // with similar headings is not it.
    const wrongScreen = evidence([
      {
        step: 'screen:dashboard',
        pageUrl: `${BASE}/-Dashboard`,
        pageTitle: 'Dashboard',
        panelState: 'Dashboard',
        screenshotPath: null,
        roots: [
          root({
            tables: [
              {
                ordinal: 1,
                tag: 'table',
                id: 'summary',
                visible: true,
                headings: ['Signed In', 'Last Active'],
                rowCount: 2,
                rowControls: [],
              },
            ],
          }),
        ],
      },
    ]);

    const outcome = proposeSelectors(wrongScreen, ALL_CONTROLS);
    expect(outcome.proposals.map((proposal) => proposal.control)).not.toContain('agents.logged_in');
  });
});

describe('unresolved controls stay unusable', () => {
  it('never promotes a positional path, because none is ever offered', () => {
    const positionalOnly = evidence([
      page('screen:users', [
        root({
          buttons: [
            {
              ordinal: 1,
              tag: 'button',
              visible: true,
              kind: 'button',
              label: 'Save',
              disabled: false,
              cssPath: 'form > div:nth-of-type(3) > button',
            },
          ],
        }),
      ]),
    ]);

    const outcome = proposeSelectors(positionalOnly, ALL_CONTROLS);
    for (const proposal of outcome.proposals) {
      expect(proposal.tier).not.toBe('css-path');
      expect(String((proposal.strategy as { value?: string }).value ?? '')).not.toMatch(
        /nth-of-type/,
      );
    }
  });

  it('keeps a capability unusable while its control is unresolved', async () => {
    const { capabilityStatuses } = await import('../src/readymode/selectors/capabilities');

    const [forceLogout] = capabilityStatuses([
      {
        control: 'agents.force_logout',
        required: true,
        state: 'missing',
        source: 'none',
        visibleMatches: 0,
        attachedMatches: 0,
      },
    ]).filter((entry) => entry.capability === 'force_logout');

    expect(forceLogout.usable).toBe(false);
    expect(forceLogout.missing).toContain('agents.force_logout');
  });
});
