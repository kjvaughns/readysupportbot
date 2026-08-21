import { describe, expect, it } from 'vitest';
import {
  APPROVED_PANEL_LABELS,
  PANELS,
  currentPanelHeading,
  detectPanelState,
  findControlInRow,
  findExactLabel,
  isApprovedPanelLabel,
  openPanel,
  openStep,
  waitForHeading,
} from '../src/readymode/navigation';
import { buildFakePage, mutationsIn, navigationsIn } from './support/fakePage';
import type { FakeRootSpec } from './support/fakePage';
import type { RootEvidence } from '../src/readymode/discovery/evidence';

/**
 * Readymode Starter has routes, and going to one is not the same as arriving.
 * The shell answers with a page either way, so every one of these tests is
 * really the same question: does the code believe the address, or does it
 * believe what is on the screen?
 */

const BASE = 'https://acme.readymode.com';

function heading(text: string) {
  return { text, css: ['h1, h2, h3, h4, h5, h6, [role="heading"], legend, caption, .panel-title, .panelTitle, .ui-dialog-title'] };
}

function screen(name: string, url: string, elements: FakeRootSpec['elements']): FakeRootSpec[] {
  return [{ name, url, elements }];
}

const DASHBOARD = screen('page', `${BASE}/-Dashboard`, [
  heading('Dashboard'),
  { role: 'link', name: 'User Management', text: 'User Management', opens: '-Team/ManageUsers' },
  { role: 'link', name: 'License Usage', text: 'License Usage', opens: '+Team/ManageLicenses' },
]);

const USER_MANAGEMENT = screen('page', `${BASE}/-Team/ManageUsers`, [
  heading('User Management'),
  { css: ['#userMgmtSearchUser'], placeholder: 'Search Users' },
]);

const LICENSE_USAGE = screen('page', `${BASE}/+Team/ManageLicenses`, [
  heading('License Usage'),
]);

/** A shell that answers every route with the dashboard — the failure that matters. */
const STUBBORN_SHELL = screen('page', `${BASE}/-Team/ManageUsers`, [
  heading('Dashboard'),
  { role: 'link', name: 'User Management', text: 'User Management', opens: 'opened-by-label' },
]);

const OPENED_BY_LABEL = screen('page', `${BASE}/-Dashboard`, [heading('User Management')]);

describe('opening a panel', () => {
  it('goes to the inspected route and confirms the heading', async () => {
    const { page, log } = buildFakePage(DASHBOARD, {
      screens: {
        '-Dashboard': DASHBOARD,
        '-Team/ManageUsers': USER_MANAGEMENT,
        '+Team/ManageLicenses': LICENSE_USAGE,
      },
      start: '-Dashboard',
    });

    const result = await openPanel(page, 'users');

    expect(result.opened).toBe(true);
    expect(result.heading).toBe('User Management');
    expect(navigationsIn(log)[0]).toContain('-Team/ManageUsers');
  });

  it('keeps a leading plus in the route literal', async () => {
    const { page, log } = buildFakePage(DASHBOARD, {
      screens: { '-Dashboard': DASHBOARD, '+Team/ManageLicenses': LICENSE_USAGE },
      start: '-Dashboard',
    });

    await openPanel(page, 'licenses');
    expect(navigationsIn(log)[0]).toBe(`${BASE}/+Team/ManageLicenses`);
  });

  it('falls back to the exact label when the route does not open the screen', async () => {
    const { page, log } = buildFakePage(DASHBOARD, {
      screens: {
        '-Dashboard': DASHBOARD,
        // The route "works" — it answers — but the screen never changes.
        '-Team/ManageUsers': STUBBORN_SHELL,
        'opened-by-label': OPENED_BY_LABEL,
      },
      start: '-Dashboard',
    });

    const result = await openPanel(page, 'users', { timeoutMs: 200 });

    expect(result.opened).toBe(true);
    expect(result.heading).toBe('User Management');
    expect(mutationsIn(log)).toContain('click');
  });

  it('reports a failure rather than assuming the route worked', async () => {
    const { page } = buildFakePage(STUBBORN_SHELL, {
      screens: { '-Team/ManageUsers': screen('page', `${BASE}/-Team/ManageUsers`, [heading('Dashboard')]) },
      start: '-Team/ManageUsers',
    });

    const result = await openPanel(page, 'users', { timeoutMs: 200 });

    expect(result.opened).toBe(false);
    expect(result.heading).toBeNull();
    expect(result.reason).toBeTruthy();
  });

  it('does not click again when the panel is already open', async () => {
    const { page, log } = buildFakePage(USER_MANAGEMENT, {
      screens: { '-Team/ManageUsers': USER_MANAGEMENT },
      start: '-Team/ManageUsers',
    });

    const result = await openPanel(page, 'users');

    expect(result.opened).toBe(true);
    // Clicking an open panel's label would toggle it shut.
    expect(mutationsIn(log)).toEqual([]);
    expect(navigationsIn(log)).toEqual([]);
  });

  it('opens the parent screen before a tab that lives inside it', async () => {
    const leads = screen('page', `${BASE}/-AI%20Leads/pools`, [
      heading('Lead Management'),
      { role: 'tab', name: 'Queues', text: 'Queues' },
    ]);

    const { page, log } = buildFakePage(DASHBOARD, {
      screens: { '-Dashboard': DASHBOARD, '-AI%20Leads/pools': leads },
      start: '-Dashboard',
    });

    const result = await openPanel(page, 'queues');

    expect(result.opened).toBe(true);
    expect(navigationsIn(log).some((url) => url.includes('-AI%20Leads/pools'))).toBe(true);
  });
});

describe('the approved label allowlist', () => {
  it('admits only the labels an operator named', () => {
    for (const label of APPROVED_PANEL_LABELS) expect(isApprovedPanelLabel(label)).toBe(true);
  });

  it('refuses anything else, however navigational it sounds', () => {
    expect(isApprovedPanelLabel('Delete Users')).toBe(false);
    expect(isApprovedPanelLabel('Sign Out Everyone Else')).toBe(false);
    expect(isApprovedPanelLabel('Save')).toBe(false);
    expect(isApprovedPanelLabel('')).toBe(false);
  });

  it('refuses to click a label outside the allowlist even when asked directly', async () => {
    const { page, log } = buildFakePage(
      screen('page', BASE, [{ role: 'button', name: 'Sign Out All Users', text: 'Sign Out All Users' }]),
    );

    const { openPanelByLabel } = await import('../src/readymode/navigation');
    const result = await openPanelByLabel(page, 'Sign Out All Users', []);

    expect(result.opened).toBe(false);
    expect(mutationsIn(log)).toEqual([]);
  });

  it('names every panel target with an approved label', () => {
    for (const target of Object.values(PANELS)) {
      expect(isApprovedPanelLabel(target.label)).toBe(true);
    }
  });
});

describe('finding a label uniquely', () => {
  it('refuses when the same label is visible in two frames', async () => {
    const { page } = buildFakePage([
      { name: 'page', url: BASE, elements: [{ role: 'link', name: 'Queues', text: 'Queues' }] },
      {
        name: 'inner',
        url: `${BASE}/inner`,
        elements: [{ role: 'link', name: 'Queues', text: 'Queues' }],
      },
    ]);

    expect(await findExactLabel(page, 'Queues')).toBeNull();
  });

  it('refuses when the label appears twice in one frame', async () => {
    const { page } = buildFakePage(
      screen('page', BASE, [
        { role: 'link', name: 'Queues', text: 'Queues' },
        { role: 'link', name: 'Queues', text: 'Queues' },
      ]),
    );

    expect(await findExactLabel(page, 'Queues')).toBeNull();
  });

  it('ignores a hidden duplicate', async () => {
    const { page } = buildFakePage(
      screen('page', BASE, [
        { role: 'link', name: 'Queues', text: 'Queues' },
        { role: 'link', name: 'Queues', text: 'Queues', visible: false },
      ]),
    );

    expect(await findExactLabel(page, 'Queues')).not.toBeNull();
  });
});

describe('a control inside one user\'s row', () => {
  const table: FakeRootSpec[] = screen('page', `${BASE}/+Team/ManageLicenses`, [
    heading('License Usage'),
    {
      css: ['table'],
      children: [
        {
          css: ['tr'],
          text: 'jsmith John Smith Agent',
          children: [{ text: 'Sign Out', name: 'Sign Out', css: ['a#sign-out-btn.button.primary'] }],
        },
        {
          css: ['tr'],
          text: 'bjones Barbara Jones Agent',
          children: [{ text: 'Sign Out', name: 'Sign Out', css: ['a#sign-out-btn.button.primary'] }],
        },
      ],
    },
  ]);

  it('finds the control in the row that names the user', async () => {
    const { page } = buildFakePage(table);

    const found = await findControlInRow(page, { rowIdentifier: 'jsmith', label: 'Sign Out' });
    expect(found).not.toBeNull();
  });

  it('refuses when the identifier matches no row', async () => {
    const { page } = buildFakePage(table);
    expect(await findControlInRow(page, { rowIdentifier: 'nobody', label: 'Sign Out' })).toBeNull();
  });

  it('does not confuse one account with another whose name starts the same', async () => {
    const similar: FakeRootSpec[] = screen('page', BASE, [
      {
        css: ['table'],
        children: [
          {
            css: ['tr'],
            text: 'jsmith John Smith',
            children: [{ text: 'Sign Out', name: 'Sign Out' }],
          },
          {
            css: ['tr'],
            text: 'jsmith2 Jane Smith',
            children: [{ text: 'Sign Out', name: 'Sign Out' }],
          },
        ],
      },
    ]);

    const { page } = buildFakePage(similar);

    // Matching on a substring would make these two rows indistinguishable, and
    // signing out the wrong person is exactly the failure to avoid.
    expect(await findControlInRow(page, { rowIdentifier: 'jsmith', label: 'Sign Out' })).not.toBeNull();
    expect(await findControlInRow(page, { rowIdentifier: 'jsmith2', label: 'Sign Out' })).not.toBeNull();
  });

  it('refuses when two rows genuinely mention the same user', async () => {
    const ambiguous: FakeRootSpec[] = screen('page', BASE, [
      {
        css: ['table'],
        children: [
          {
            css: ['tr'],
            text: 'jsmith John Smith Agent',
            children: [{ text: 'Sign Out', name: 'Sign Out' }],
          },
          {
            // The same account also appears as somebody's supervisor.
            css: ['tr'],
            text: 'bjones Barbara Jones Agent manager jsmith',
            children: [{ text: 'Sign Out', name: 'Sign Out' }],
          },
        ],
      },
    ]);

    const { page, log } = buildFakePage(ambiguous);

    // Which row is meant is a question this code cannot answer, so it does not
    // answer it.
    expect(await findControlInRow(page, { rowIdentifier: 'jsmith', label: 'Sign Out' })).toBeNull();
    expect(mutationsIn(log)).toEqual([]);
  });

  it('never falls back to a position when the row cannot be identified', async () => {
    const { page } = buildFakePage(table);
    expect(await findControlInRow(page, { rowIdentifier: '', label: 'Sign Out' })).toBeNull();
  });
});

describe('panel state from evidence', () => {
  const root = (headings: Array<{ level: number; text: string }>): RootEvidence =>
    ({
      rootName: 'page',
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
      headings,
      truncated: [],
    }) as RootEvidence;

  it('names the panel from its heading', () => {
    expect(detectPanelState([root([{ level: 1, text: 'User Management' }])])).toBe('User Management');
    expect(detectPanelState([root([{ level: 2, text: 'Lead Playlist Editor' }])])).toBe(
      'Lead Playlist Editor',
    );
  });

  it('prefers a specific screen over the shell', () => {
    const state = detectPanelState([
      root([
        { level: 1, text: 'Dashboard' },
        { level: 2, text: 'License Usage' },
      ]),
    ]);
    expect(state).toBe('License Usage');
  });

  it('reads a heading that carries extra text, such as a queue name', () => {
    expect(detectPanelState([root([{ level: 2, text: 'Edit Queue: Morning Callbacks' }])])).toBe(
      'Edit Queue',
    );
  });

  it('answers null rather than guessing when no heading is known', () => {
    expect(detectPanelState([root([{ level: 1, text: 'Something Else' }])])).toBeNull();
    expect(detectPanelState([])).toBeNull();
  });
});

describe('waiting for a heading', () => {
  it('returns the heading that appeared', async () => {
    const { page } = buildFakePage(LICENSE_USAGE);
    expect(await waitForHeading(page, ['License Usage'], 50)).toBe('License Usage');
  });

  it('gives up rather than reporting success', async () => {
    const { page } = buildFakePage(DASHBOARD);
    expect(await waitForHeading(page, ['Edit Queue'], 50)).toBeNull();
  });

  it('reports which panel is open right now', async () => {
    const { page } = buildFakePage(USER_MANAGEMENT);
    expect(await currentPanelHeading(page)).toBe('User Management');
  });
});

describe('a walk step', () => {
  it('opens a record without a fixed label, and confirms the heading', async () => {
    const detail = screen('page', `${BASE}/-Team/ManageUsers`, [heading('Account Settings')]);
    const list: FakeRootSpec[] = screen('page', `${BASE}/-Team/ManageUsers`, [
      heading('User Management'),
      {
        css: ['table'],
        children: [
          {
            css: ['tr'],
            children: [{ css: ['td a'], text: 'jsmith', name: 'jsmith', opens: 'detail' }],
          },
        ],
      },
    ]);

    const { page } = buildFakePage(list, { screens: { list, detail }, start: 'list' });

    const result = await openStep(page, {
      kind: 'record',
      expectHeadings: ['Account Settings'],
    }, { timeoutMs: 200 });

    expect(result.opened).toBe(true);
    expect(result.heading).toBe('Account Settings');
  });

  it('never opens a row whose link would change something', async () => {
    const rows: FakeRootSpec[] = screen('page', BASE, [
      {
        css: ['table'],
        children: [
          {
            css: ['tr'],
            children: [{ css: ['td a'], text: 'Delete this user', name: 'Delete this user' }],
          },
        ],
      },
    ]);

    const { page, log } = buildFakePage(rows);

    const result = await openStep(page, { kind: 'record', expectHeadings: ['Account Settings'] }, {
      timeoutMs: 200,
    });

    expect(result.opened).toBe(false);
    expect(mutationsIn(log)).toEqual([]);
  });
});
