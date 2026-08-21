/**
 * A minimal fake of the Playwright surface this codebase actually uses.
 *
 * Two things make it worth having: frames can be modelled explicitly, so the
 * frame-aware resolution can be tested without a browser; and every interaction
 * is recorded, so a test can assert that a read-only code path really did not
 * click, fill or submit anything.
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

function matchesValue(actual: string | undefined, expected: string | RegExp, exact?: boolean): boolean {
  if (actual === undefined) return false;
  if (expected instanceof RegExp) return expected.test(actual);
  return exact ? actual === expected : actual.includes(expected);
}

class FakeLocator {
  constructor(
    private readonly elements: FakeElement[],
    private readonly log: InteractionLog,
    private readonly description: string,
  ) {}

  async count(): Promise<number> {
    return this.elements.length;
  }

  first(): FakeLocator {
    return new FakeLocator(this.elements.slice(0, 1), this.log, this.description);
  }

  nth(index: number): FakeLocator {
    return new FakeLocator(this.elements.slice(index, index + 1), this.log, this.description);
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
    return this.elements[0]?.text ?? this.elements[0]?.name ?? '';
  }

  async getAttribute(attribute: string): Promise<string | null> {
    return this.elements[0]?.attributes?.[attribute] ?? null;
  }

  async click(): Promise<void> {
    this.log.calls.push({ method: 'click', detail: this.description });
  }

  async fill(value: string): Promise<void> {
    this.log.calls.push({ method: 'fill', detail: `${this.description}=${value}` });
  }

  async press(key: string): Promise<void> {
    this.log.calls.push({ method: 'press', detail: key });
  }

  locator(selector: string): FakeLocator {
    return new FakeLocator(
      this.elements.filter((element) => element.css?.includes(selector)),
      this.log,
      selector,
    );
  }
}

class FakeRoot {
  constructor(
    readonly spec: FakeRootSpec,
    private readonly log: InteractionLog,
  ) {}

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
    return new FakeLocator(this.spec.elements.filter(predicate), this.log, description);
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

export interface FakePage extends FakeRoot {
  frames(): FakeRoot[];
  mainFrame(): FakeRoot;
  isClosed(): boolean;
}

/**
 * Builds a page from a list of roots. The first entry is the main frame; the
 * rest are child frames.
 */
export function buildFakePage(roots: FakeRootSpec[]): { page: any; log: InteractionLog } {
  const log: InteractionLog = { calls: [] };
  const [main, ...children] = roots;

  const mainRoot = new FakeRoot(main, log);
  const childRoots = children.map((spec) => new FakeRoot(spec, log));

  const page = Object.assign(mainRoot, {
    frames: () => [mainRoot, ...childRoots],
    mainFrame: () => mainRoot,
    isClosed: () => false,
    context: () => ({}),
    waitForLoadState: async () => undefined,
    goto: async (url: string) => {
      log.calls.push({ method: 'goto', detail: url });
    },
    reload: async () => {
      log.calls.push({ method: 'reload' });
    },
    screenshot: async () => Buffer.from(''),
    waitForTimeout: async () => undefined,
  });

  return { page, log };
}
