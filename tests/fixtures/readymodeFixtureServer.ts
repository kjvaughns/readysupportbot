import { createServer, type Server } from 'node:http';

/**
 * A synthetic admin interface for testing.
 *
 * IMPORTANT: this is NOT a model of Readymode. No route, label, button or
 * message here is a claim about how the real product looks — the real values
 * are unknown to this codebase by design and are captured with the discovery
 * script.
 *
 * What it is: a small stateful app with the same *shape* the workflows expect
 * — a sign-in page, a searchable list, a detail page, a create form — so the
 * control flow can be exercised for real. The tests point the selector
 * registry at this app's markup, which means they verify the logic (search,
 * single-match enforcement, act, reload, re-read, verify, stop on mismatch)
 * without asserting anything about Readymode itself.
 *
 * It is stateful on purpose. If clearing a license did not actually change
 * what the detail page then reports, the verification step would pass without
 * verifying anything.
 */

export interface FixtureAgent {
  id: string;
  username: string;
  email: string;
  fullName: string;
  role: string;
  licenseType: string;
  team: string;
  campaign: string;
  queue: string;
  active: boolean;
  licenseInUse: boolean;
  loggedIn: boolean;
  onCall: boolean;
}

export const DEFAULT_AGENTS: FixtureAgent[] = [
  {
    id: '1001',
    username: 'jbrown',
    email: 'john.brown@example.test',
    fullName: 'John Brown',
    role: 'Agent',
    licenseType: 'Standard',
    team: 'Team A',
    campaign: 'Vantage',
    queue: 'Inbound',
    active: true,
    licenseInUse: true,
    loggedIn: true,
    onCall: false,
  },
  {
    id: '1002',
    username: 'sgarcia',
    email: 'sarah.garcia@example.test',
    fullName: 'Sarah Garcia',
    role: 'Agent',
    licenseType: 'Standard',
    team: 'Team A',
    campaign: 'Vantage',
    queue: 'Outbound',
    active: true,
    licenseInUse: true,
    loggedIn: true,
    onCall: true,
  },
  {
    id: '1003',
    username: 'msmith',
    email: 'marcus.smith@example.test',
    fullName: 'Marcus Smith',
    role: 'Agent',
    licenseType: 'Premium',
    team: 'Team B',
    campaign: 'Horizon',
    queue: 'Inbound',
    active: true,
    licenseInUse: false,
    loggedIn: false,
    onCall: false,
  },
  {
    // Same full name as 1003, so the ambiguity path is reachable.
    id: '1004',
    username: 'msmith2',
    email: 'marcus.smith2@example.test',
    fullName: 'Marcus Smith',
    role: 'Supervisor',
    licenseType: 'Premium',
    team: 'Team C',
    campaign: 'Horizon',
    queue: 'Escalations',
    active: true,
    licenseInUse: true,
    loggedIn: true,
    onCall: false,
  },
  {
    id: '1005',
    username: 'dlee',
    email: 'dana.lee@example.test',
    fullName: 'Dana Lee',
    role: 'Agent',
    licenseType: 'Standard',
    team: 'Team B',
    campaign: 'Vantage',
    queue: 'Inbound',
    active: false,
    licenseInUse: false,
    loggedIn: false,
    onCall: false,
  },
];

const escape = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function shell(id: string, title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body id="${id}"><h1>${escape(title)}</h1>${body}</body></html>`;
}

export interface FixtureOptions {
  agents?: FixtureAgent[];
  /** Start signed out, so the sign-in path runs. */
  signedIn?: boolean;
  /** Show a CAPTCHA instead of the sign-in form. */
  showCaptcha?: boolean;
  /** Show a verification-code prompt instead of the sign-in form. */
  showMfa?: boolean;
  /** Reject the credentials even when they are correct. */
  rejectLogin?: boolean;
  username?: string;
  password?: string;
}

export class ReadymodeFixture {
  private server: Server | undefined;
  private agents: FixtureAgent[];
  private signedIn: boolean;
  private readonly options: Required<Pick<FixtureOptions, 'username' | 'password'>> & FixtureOptions;

  /** Everything the workflows submitted, so tests can assert on it. */
  readonly submissions: Array<{ kind: string; detail: Record<string, string> }> = [];

  constructor(options: FixtureOptions = {}) {
    this.agents = (options.agents ?? DEFAULT_AGENTS).map((agent) => ({ ...agent }));
    this.signedIn = options.signedIn ?? true;
    this.options = {
      username: options.username ?? 'admin',
      password: options.password ?? 'correct-horse-battery',
      ...options,
    };
  }

  async start(): Promise<string> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'POST') {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          const params = new URLSearchParams(body);
          const { status, location, html } = this.handlePost(url.pathname, params);
          if (location) {
            response.writeHead(302, { location });
            response.end();
            return;
          }
          response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
          response.end(html ?? '');
        });
        return;
      }

      const { status, html } = this.handleGet(url);
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      response.end(html);
    });

    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve);
    });

    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind a port');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  find(username: string): FixtureAgent | undefined {
    return this.agents.find((agent) => agent.username === username);
  }

  setSignedIn(value: boolean): void {
    this.signedIn = value;
  }

  private handleGet(url: URL): { status: number; html: string } {
    const path = url.pathname;

    if (path === '/login') return { status: 200, html: this.loginPage() };

    if (!this.signedIn) {
      return { status: 200, html: this.loginPage('Your session has expired. Please sign in again.') };
    }

    if (path === '/' || path === '/dashboard') {
      return {
        status: 200,
        html: shell('page-dashboard', 'Admin Dashboard', '<nav id="main-nav">Agents · Licenses</nav>'),
      };
    }

    if (path === '/agents') return { status: 200, html: this.agentsPage(url.searchParams.get('q') ?? '') };
    if (path === '/agents/new') return { status: 200, html: this.createPage() };

    const detail = /^\/agents\/(\d+)$/.exec(path);
    if (detail?.[1]) {
      const agent = this.agents.find((candidate) => candidate.id === detail[1]);
      if (!agent) return { status: 404, html: shell('page-missing', 'Not found', '') };
      return { status: 200, html: this.detailPage(agent, url.searchParams.get('notice') ?? '') };
    }

    if (path === '/licenses') return { status: 200, html: this.licensesPage() };

    return { status: 404, html: shell('page-missing', 'Not found', '') };
  }

  private handlePost(
    path: string,
    params: URLSearchParams,
  ): { status: number; location?: string; html?: string } {
    if (path === '/login') {
      const ok =
        !this.options.rejectLogin &&
        params.get('username') === this.options.username &&
        params.get('password') === this.options.password;

      if (!ok) {
        return { status: 200, html: this.loginPage('Sign-in failed. Check your username and password.') };
      }
      this.signedIn = true;
      return { status: 302, location: '/dashboard' };
    }

    if (path === '/agents/new') {
      const username = params.get('username') ?? '';
      const email = params.get('email') ?? '';

      if (this.agents.some((agent) => agent.username === username)) {
        return { status: 200, html: this.createPage('That username is already taken.') };
      }
      if (this.agents.some((agent) => agent.email === email)) {
        return { status: 200, html: this.createPage('That email is already in use.') };
      }

      const created: FixtureAgent = {
        id: String(2000 + this.agents.length),
        username,
        email,
        fullName: `${params.get('first_name') ?? ''} ${params.get('last_name') ?? ''}`.trim(),
        role: params.get('role') ?? '',
        licenseType: params.get('license_type') ?? '',
        team: params.get('team') ?? '',
        campaign: params.get('campaign') ?? '',
        queue: params.get('queue') ?? '',
        active: params.get('active') !== null,
        licenseInUse: false,
        loggedIn: false,
        onCall: false,
      };

      this.agents.push(created);
      this.submissions.push({ kind: 'create', detail: { username, email } });
      return { status: 302, location: `/agents/${created.id}?notice=created` };
    }

    const action = /^\/agents\/(\d+)\/(clear-license|reset-password|deactivate)$/.exec(path);
    if (action?.[1] && action[2]) {
      const agent = this.agents.find((candidate) => candidate.id === action[1]);
      if (!agent) return { status: 404, html: shell('page-missing', 'Not found', '') };

      if (action[2] === 'clear-license') {
        agent.licenseInUse = false;
        agent.loggedIn = false;
        agent.onCall = false;
        this.submissions.push({ kind: 'clear-license', detail: { username: agent.username } });
        return { status: 302, location: `/agents/${agent.id}?notice=license-cleared` };
      }

      if (action[2] === 'deactivate') {
        agent.active = false;
        agent.licenseInUse = false;
        agent.loggedIn = false;
        agent.onCall = false;
        this.submissions.push({ kind: 'deactivate', detail: { username: agent.username } });
        return { status: 302, location: `/agents/${agent.id}?notice=deactivated` };
      }

      // Password reset. The fixture records that a reset happened and the
      // length of what was submitted, never the value — the same rule the
      // system itself follows.
      const submitted = params.get('new_password') ?? '';
      this.submissions.push({
        kind: 'reset-password',
        detail: { username: agent.username, length: String(submitted.length) },
      });
      return { status: 302, location: `/agents/${agent.id}?notice=password-reset` };
    }

    return { status: 404, html: shell('page-missing', 'Not found', '') };
  }

  private loginPage(error = ''): string {
    if (this.options.showCaptcha) {
      return shell(
        'page-login',
        'Sign in',
        '<div id="captcha-challenge">Please complete the security check to continue.</div>',
      );
    }
    if (this.options.showMfa) {
      return shell('page-login', 'Sign in', '<div id="mfa-prompt">Enter the verification code we sent you.</div>');
    }

    return shell(
      'page-login',
      'Sign in',
      `${error ? `<p id="login-error">${escape(error)}</p>` : ''}
       <form method="post" action="/login">
         <label for="u">Username</label><input id="u" name="username">
         <label for="p">Password</label><input id="p" name="password" type="password">
         <button type="submit">Sign in</button>
       </form>`,
    );
  }

  private agentsPage(query: string): string {
    const needle = query.trim().toLowerCase();
    const matches = needle
      ? this.agents.filter((agent) =>
          [agent.username, agent.email, agent.fullName, agent.id].some((field) =>
            field.toLowerCase().includes(needle),
          ),
        )
      : this.agents;

    const rows = matches
      .map(
        (agent) => `<tr>
          <td data-cell="userId">${escape(agent.id)}</td>
          <td data-cell="username">${escape(agent.username)}</td>
          <td data-cell="email">${escape(agent.email)}</td>
          <td data-cell="fullName">${escape(agent.fullName)}</td>
          <td><a data-cell="open" href="/agents/${escape(agent.id)}">Open</a></td>
        </tr>`,
      )
      .join('');

    return shell(
      'page-agents',
      'Agents',
      `<form method="get" action="/agents">
         <input name="q" placeholder="Search agents" value="${escape(query)}">
         <button type="submit">Search</button>
       </form>
       <a href="/agents/new">New agent</a>
       ${matches.length === 0 ? '<p id="no-results">No agents matched that search.</p>' : ''}
       <table><thead><tr><th>ID</th><th>Username</th><th>Email</th><th>Name</th><th></th></tr></thead>
       <tbody>${rows}</tbody></table>`,
    );
  }

  private detailPage(agent: FixtureAgent, notice: string): string {
    const notices: Record<string, string> = {
      created: 'Agent created.',
      'license-cleared': 'License released.',
      'password-reset': 'Password updated.',
      deactivated: 'Agent deactivated.',
    };

    return shell(
      'page-agent-detail',
      `Agent ${agent.username}`,
      `${notice && notices[notice] ? `<p id="notice">${escape(notices[notice])}</p>` : ''}
       <dl>
         <dd data-field="userId">${escape(agent.id)}</dd>
         <dd data-field="username">${escape(agent.username)}</dd>
         <dd data-field="email">${escape(agent.email)}</dd>
         <dd data-field="fullName">${escape(agent.fullName)}</dd>
         <dd data-field="role">${escape(agent.role)}</dd>
         <dd data-field="licenseType">${escape(agent.licenseType)}</dd>
         <dd data-field="team">${escape(agent.team)}</dd>
         <dd data-field="campaign">${escape(agent.campaign)}</dd>
         <dd data-field="queue">${escape(agent.queue)}</dd>
         <dd data-field="activeState">${agent.active ? 'Active' : 'Deactivated'}</dd>
         <dd data-field="licenseState">${agent.licenseInUse ? 'License in use' : 'No license assigned'}</dd>
         <dd data-field="loginState">${agent.loggedIn ? 'Signed in' : 'Signed out'}</dd>
         <dd data-field="callState">${agent.onCall ? 'On a call' : 'Not on a call'}</dd>
       </dl>
       <form method="post" action="/agents/${escape(agent.id)}/clear-license">
         <button type="submit">Release license</button>
       </form>
       <form method="post" action="/agents/${escape(agent.id)}/deactivate">
         <button type="submit">Deactivate agent</button>
       </form>
       <form method="post" action="/agents/${escape(agent.id)}/reset-password">
         <label for="np">New password</label><input id="np" name="new_password" type="password">
         <button type="submit">Save new password</button>
       </form>`,
    );
  }

  private createPage(error = ''): string {
    return shell(
      'page-agent-create',
      'New agent',
      `${error ? `<p id="form-error">${escape(error)}</p>` : ''}
       <form method="post" action="/agents/new">
         <label for="fn">First name</label><input id="fn" name="first_name">
         <label for="ln">Last name</label><input id="ln" name="last_name">
         <label for="em">Email</label><input id="em" name="email">
         <label for="un">Username</label><input id="un" name="username">
         <label for="pw">Password</label><input id="pw" name="password" type="password">
         <label for="rl">Agent role</label>
         <select id="rl" name="role"><option>Agent</option><option>Supervisor</option><option>Manager</option></select>
         <label for="lt">License type</label>
         <select id="lt" name="license_type"><option>Standard</option><option>Premium</option></select>
         <label for="tm">Team</label>
         <select id="tm" name="team"><option>Team A</option><option>Team B</option><option>Team C</option></select>
         <label for="cp">Campaign</label>
         <select id="cp" name="campaign"><option>Vantage</option><option>Horizon</option></select>
         <label for="qu">Queue</label>
         <select id="qu" name="queue"><option>Inbound</option><option>Outbound</option><option>Escalations</option></select>
         <button type="submit">Create agent</button>
       </form>`,
    );
  }

  private licensesPage(): string {
    const holders = this.agents.filter((agent) => agent.licenseInUse);

    const rows = holders
      .map(
        (agent) => `<tr>
          <td data-cell="agent">${escape(agent.fullName)}</td>
          <td data-cell="licenseType">${escape(agent.licenseType)}</td>
          <td data-cell="status">${agent.onCall ? 'On a call' : agent.loggedIn ? 'Signed in' : 'Idle'}</td>
        </tr>`,
      )
      .join('');

    return shell(
      'page-licenses',
      'License usage',
      `<p id="total-in-use">${holders.length} licenses in use</p>
       <p id="total-available">${this.agents.length} seats</p>
       <table><thead><tr><th>Agent</th><th>License</th><th>Status</th></tr></thead>
       <tbody>${rows}</tbody></table>`,
    );
  }
}

/**
 * The selector overlay matching the fixture markup above.
 *
 * This exists only so tests have *some* concrete mapping to run against. It
 * is not a starting point for a real deployment — real values come from
 * discovery, against a real instance.
 */
export const FIXTURE_OVERLAY = {
  routes: {
    'route.login': { path: '/login' },
    'route.dashboard': { path: '/dashboard' },
    'route.agents': { path: '/agents' },
    'route.agentCreate': { path: '/agents/new' },
    'route.licenses': { path: '/licenses' },
  },
  selectors: {
    'page.login.marker': { strategy: 'css' as const, value: '#page-login' },
    'page.dashboard.marker': { strategy: 'css' as const, value: '#page-dashboard' },
    'page.agents.marker': { strategy: 'css' as const, value: '#page-agents' },
    'page.agentDetail.marker': { strategy: 'css' as const, value: '#page-agent-detail' },
    'page.agentCreate.marker': { strategy: 'css' as const, value: '#page-agent-create' },
    'page.licenses.marker': { strategy: 'css' as const, value: '#page-licenses' },

    'login.username.input': { strategy: 'label' as const, value: 'Username' },
    'login.password.input': { strategy: 'label' as const, value: 'Password' },
    'login.submit.button': { strategy: 'role' as const, value: 'button', name: 'Sign in' },
    'login.error.marker': { strategy: 'css' as const, value: '#login-error' },
    'auth.captcha.marker': { strategy: 'css' as const, value: '#captcha-challenge' },
    'auth.mfa.marker': { strategy: 'css' as const, value: '#mfa-prompt' },

    'agents.search.input': { strategy: 'placeholder' as const, value: 'Search agents' },
    'agents.search.submit': { strategy: 'role' as const, value: 'button', name: 'Search' },
    'agents.results.row': { strategy: 'css' as const, value: 'table tbody tr' },
    'agents.results.empty.marker': { strategy: 'css' as const, value: '#no-results' },
    'agents.row.userId': { strategy: 'css' as const, value: '[data-cell="userId"]' },
    'agents.row.username': { strategy: 'css' as const, value: '[data-cell="username"]' },
    'agents.row.email': { strategy: 'css' as const, value: '[data-cell="email"]' },
    'agents.row.fullName': { strategy: 'css' as const, value: '[data-cell="fullName"]' },
    'agents.row.open': { strategy: 'css' as const, value: '[data-cell="open"]' },

    'agent.detail.userId': { strategy: 'css' as const, value: '[data-field="userId"]' },
    'agent.detail.username': { strategy: 'css' as const, value: '[data-field="username"]' },
    'agent.detail.email': { strategy: 'css' as const, value: '[data-field="email"]' },
    'agent.detail.fullName': { strategy: 'css' as const, value: '[data-field="fullName"]' },
    'agent.detail.role': { strategy: 'css' as const, value: '[data-field="role"]' },
    'agent.detail.licenseType': { strategy: 'css' as const, value: '[data-field="licenseType"]' },
    'agent.detail.team': { strategy: 'css' as const, value: '[data-field="team"]' },
    'agent.detail.campaign': { strategy: 'css' as const, value: '[data-field="campaign"]' },
    'agent.detail.queue': { strategy: 'css' as const, value: '[data-field="queue"]' },
    'agent.detail.activeState': { strategy: 'css' as const, value: '[data-field="activeState"]' },
    'agent.detail.licenseState': { strategy: 'css' as const, value: '[data-field="licenseState"]' },
    'agent.detail.loginState': { strategy: 'css' as const, value: '[data-field="loginState"]' },
    'agent.detail.callState': { strategy: 'css' as const, value: '[data-field="callState"]' },

    'create.firstName.input': { strategy: 'label' as const, value: 'First name' },
    'create.lastName.input': { strategy: 'label' as const, value: 'Last name' },
    'create.email.input': { strategy: 'label' as const, value: 'Email' },
    'create.username.input': { strategy: 'label' as const, value: 'Username' },
    'create.password.input': { strategy: 'label' as const, value: 'Password' },
    'create.role.select': { strategy: 'label' as const, value: 'Agent role' },
    'create.licenseType.select': { strategy: 'label' as const, value: 'License type' },
    'create.team.select': { strategy: 'label' as const, value: 'Team' },
    'create.campaign.select': { strategy: 'label' as const, value: 'Campaign' },
    'create.queue.select': { strategy: 'label' as const, value: 'Queue' },
    'create.submit.button': { strategy: 'role' as const, value: 'button', name: 'Create agent' },
    'create.success.marker': { strategy: 'css' as const, value: '#notice' },
    'create.validationError.marker': { strategy: 'css' as const, value: '#form-error' },

    'clearLicense.trigger.button': { strategy: 'role' as const, value: 'button', name: 'Release license' },
    'clearLicense.success.marker': { strategy: 'css' as const, value: '#notice' },

    'resetPassword.trigger.button': { strategy: 'label' as const, value: 'New password' },
    'resetPassword.newPassword.input': { strategy: 'label' as const, value: 'New password' },
    'resetPassword.submit.button': { strategy: 'role' as const, value: 'button', name: 'Save new password' },
    'resetPassword.success.marker': { strategy: 'css' as const, value: '#notice' },

    'deactivate.trigger.button': { strategy: 'role' as const, value: 'button', name: 'Deactivate agent' },
    'deactivate.success.marker': { strategy: 'css' as const, value: '#notice' },

    'licenses.row': { strategy: 'css' as const, value: 'table tbody tr' },
    'licenses.row.agent': { strategy: 'css' as const, value: '[data-cell="agent"]' },
    'licenses.row.licenseType': { strategy: 'css' as const, value: '[data-cell="licenseType"]' },
    'licenses.row.status': { strategy: 'css' as const, value: '[data-cell="status"]' },
    'licenses.total.inUse': { strategy: 'css' as const, value: '#total-in-use' },
    'licenses.total.available': { strategy: 'css' as const, value: '#total-available' },
  },
};
