/**
 * A minimal fake of the Playwright surface this codebase actually uses.
 *
 * Three things make it worth having. Frames can be modelled explicitly, so
 * frame-aware resolution can be tested without a browser. Every interaction is
 * recorded, so a test can assert that a read-only code path really did not
 * click, fill or submit anything. And screens can change — by navigating to a
 * route or by clicking something — which is the only way to test that arrival
 * is confirmed by what appears on screen rather than by the address.
 */

export interface FakeElement {
  testId?: string;
  role?: string;
  /** Accessible name / visible text. */
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  /** CSS selectors this element should answer to. */
  css?: string[];
  visible?: boolean;
  attributes?: Record<string, string>;
  checked?: boolean;
  /** Screen this element switches to when clicked. */
  opens?: string;
  /** Elements nested inside this one, reachable through `locator()`. */
  children?: FakeElement[];
}

export interface FakeRootSpec {
  name: string;
  url: string;
  detached?: boolean;
  title?: string;
  bodyText?: string;
  elements: FakeElement[];
}

export interface InteractionLog {
  calls: Array<{ method: string; detail?: string }>;
}

const MUTATING_METHODS = new Set([
  'click',
  'fill',
  'check',
  'uncheck',
  'press',
  'selectOption',
  'submit',
  'setInputFiles',
  'dblclick',
  'tap',
  'focus',
]);

export function mutationsIn(log: InteractionLog): string[] {
  return log.calls.filter((call) => MUTATING_METHODS.has(call.method)).map((call) => call.method);
}

export function navigationsIn(log: InteractionLog): string[] {
  return log.calls.filter((call) => call.method === 'goto').map((call) => call.detail ?? '');
}

function matchesValue(actual: string | undefined, expected: string | RegExp, exact?: boolean): boolean {
  if (actual === undefined) return false;
  if (expected instanceof RegExp) return expected.test(actual);
  return exact ? actual === expected : actual.includes(expected);
}

function textOf(element: FakeElement): string {
  const own = element.text ?? element.name ?? '';
  const nested = (element.children ?? []).map(textOf).join(' ');
  return [own, nested].filter(Boolean).join(' ');
}

class FakeLocator {
  constructor(
    private readonly elements: FakeElement[],
    private readonly log: InteractionLog,
    private readonly description: string,
    private readonly onNavigate: (screen: string) => void = () => undefined,
  ) {}

  private derive(elements: FakeElement[], description: string): FakeLocator {
    return new FakeLocator(elements, this.log, description, this.onNavigate);
  }

  async count(): Promise<number> {
    return this.elements.length;
  }

  first(): FakeLocator {
    return this.derive(this.elements.slice(0, 1), this.description);
  }

  nth(index: number): FakeLocator {
    return this.derive(this.elements.slice(index, index + 1), this.description);
  }

  /** Playwright's `filter({ hasText })`, matched against the element's own text. */
  filter(options: { hasText?: string | RegExp }): FakeLocator {
    if (options.hasText === undefined) return this;
    return this.derive(
      this.elements.filter((element) => matchesValue(textOf(element), options.hasText!)),
      `${this.description}.filter`,
    );
  }

  async isVisible(): Promise<boolean> {
    return this.elements[0]?.visible !== false && this.elements.length > 0;
  }

  async isChecked(): Promise<boolean> {
    return this.elements[0]?.checked === true;
  }

  async waitFor(options?: { state?: string }): Promise<void> {
    const state = options?.state ?? 'visible';
    if (this.elements.length === 0) throw new Error('No element');
    if (state === 'visible' && this.elements[0].visible === false) throw new Error('Not visible');
  }

  async innerText(): Promise<string> {
    const element = this.elements[0];
    return element ? textOf(element) : '';
  }

  async getAttribute(attribute: string): Promise<string | null> {
    return this.elements[0]?.attributes?.[attribute] ?? null;
  }

  async click(): Promise<void> {
    this.log.calls.push({ method: 'click', detail: this.description });
    const opens = this.elements[0]?.opens;
    if (opens) this.onNavigate(opens);
  }

  async fill(value: string): Promise<void> {
    this.log.calls.push({ method: 'fill', detail: `${this.description}=${value}` });
  }

  async press(key: string): Promise<void> {
    this.log.calls.push({ method: 'press', detail: key });
  }

  /** Descendants: this locator's elements' children, plus the elements themselves. */
  private descendants(): FakeElement[] {
    const found: FakeElement[] = [];
    const walk = (element: FakeElement) => {
      for (const child of element.children ?? []) {
        found.push(child);
        walk(child);
      }
    };
    this.elements.forEach(walk);
    return found;
  }

  locator(selector: string): FakeLocator {
    return this.derive(
      this.descendants().filter((element) => element.css?.includes(selector) === true),
      selector,
    );
  }

  getByText(value: string | RegExp, options?: { exact?: boolean }): FakeLocator {
    return this.derive(
      this.descendants().filter((element) =>
        matchesValue(element.text ?? element.name, value, options?.exact),
      ),
      `text=${value}`,
    );
  }

  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): FakeLocator {
    return this.derive(
      this.descendants().filter(
        (element) =>
          element.role === role &&
          (options?.name === undefined || matchesValue(element.name, options.name, options.exact)),
      ),
      `role=${role}`,
    );
  }
}

class FakeRoot {
  constructor(
    protected readonly read: () => FakeRootSpec,
    protected readonly log: InteractionLog,
    protected readonly onNavigate: (screen: string) => void = () => undefined,
  ) {}

  get spec(): FakeRootSpec {
    return this.read();
  }

  url(): string {
    return this.spec.url;
  }

  name(): string {
    return this.spec.name;
  }

  isDetached(): boolean {
    return this.spec.detached === true;
  }

  async title(): Promise<string> {
    return this.spec.title ?? '';
  }

  async innerText(): Promise<string> {
    return this.spec.bodyText ?? '';
  }

  private make(predicate: (element: FakeElement) => boolean, description: string): FakeLocator {
    const found: FakeElement[] = [];
    const walk = (element: FakeElement) => {
      if (predicate(element)) found.push(element);
      (element.children ?? []).forEach(walk);
    };
    this.spec.elements.forEach(walk);
    return new FakeLocator(found, this.log, description, this.onNavigate);
  }

  getByTestId(value: string): FakeLocator {
    return this.make((element) => element.testId === value, `testId=${value}`);
  }

  getByRole(role: string, options?: { name?: string | RegExp; exact?: boolean }): FakeLocator {
    return this.make(
      (element) =>
        element.role === role &&
        (options?.name === undefined || matchesValue(element.name, options.name, options.exact)),
      `role=${role}`,
    );
  }

  getByLabel(value: string | RegExp, options?: { exact?: boolean }): FakeLocator {
    return this.make((element) => matchesValue(element.label, value, options?.exact), `label=${value}`);
  }

  getByPlaceholder(value: string | RegExp): FakeLocator {
    return this.make((element) => matchesValue(element.placeholder, value), `placeholder=${value}`);
  }

  getByText(value: string | RegExp, options?: { exact?: boolean }): FakeLocator {
    return this.make(
      (element) => matchesValue(element.text ?? element.name, value, options?.exact),
      `text=${value}`,
    );
  }

  locator(selector: string): FakeLocator {
    return this.make((element) => element.css?.includes(selector) === true, `css=${selector}`);
  }
}

export interface FakeBrowserOptions {
  /**
   * Screens this fake browser knows, keyed by a name a route or a click can
   * ask for. A `goto` whose URL contains the key switches to that screen.
   */
  screens?: Record<string, FakeRootSpec[]>;
  /** Screen to start on, when `screens` is given. */
  start?: string;
}

/**
 * Builds a page from a list of roots. The first entry is the main frame; the
 * rest are child frames.
 */
export function buildFakePage(
  roots: FakeRootSpec[],
  options: FakeBrowserOptions = {},
): { page: any; log: InteractionLog } {
  const log: InteractionLog = { calls: [] };
  const screens = options.screens ?? {};

  let current: FakeRootSpec[] = options.start ? (screens[options.start] ?? roots) : roots;

  const show = (screen: string): boolean => {
    const found = screens[screen];
    if (!found) return false;
    current = found;
    return true;
  };

  const onNavigate = (screen: string) => {
    show(screen);
  };

  // One object per index, reused. `listSearchRoots` drops the main frame by
  // identity — `frame === page.mainFrame()` — so a fresh object per call would
  // let the main frame be searched twice.
  const rootsByIndex = new Map<number, FakeRoot>();
  const rootAt = (index: number): FakeRoot => {
    let root = rootsByIndex.get(index);
    if (!root) {
      root = new FakeRoot(() => current[index], log, onNavigate);
      rootsByIndex.set(index, root);
    }
    return root;
  };

  const mainRoot = rootAt(0);

  const page = Object.assign(mainRoot, {
    frames: () => current.map((_, index) => rootAt(index)),
    mainFrame: () => rootAt(0),
    isClosed: () => false,
    context: () => ({}),
    waitForLoadState: async () => undefined,
    goto: async (url: string) => {
      log.calls.push({ method: 'goto', detail: url });
      // A screen is matched by name appearing in the URL, so a test names its
      // screens after the routes it expects ReadySupport to ask for.
      const match = Object.keys(screens).find((key) => url.includes(key));
      if (match) show(match);
    },
    reload: async () => {
      log.calls.push({ method: 'reload' });
    },
    screenshot: async () => Buffer.from(''),
    waitForTimeout: async () => undefined,
  });

  return { page, log };
}

/** The shape `sessionDiagnostics` returns, for tests that do not need a browser. */
export interface SessionDiagnosticsLike {
  provider: 'browserbase' | 'local';
  browserbaseSessionId: string | null;
  contextIndex: number;
  contextCount: number;
  pageIndex: number;
  pageCount: number;
  url: string;
  cookieCount: number;
  hasAuthenticationCookie: boolean;
}
