/**
 * Shapes of the evidence collected from the real Readymode interface.
 *
 * Pure types and caps — no Playwright import — so the rules are testable on
 * their own. The guiding constraint: evidence describes the structure of a
 * page, never the data displayed on it. There is deliberately no `value` field
 * anywhere in this file.
 */

export const EVIDENCE_CAPS = {
  maxRoots: 25,
  maxButtons: 120,
  maxInputs: 200,
  maxLinks: 200,
  maxSelects: 60,
  maxOptionsPerSelect: 80,
  maxCheckboxes: 200,
  maxTables: 20,
  maxHeadingsPerTable: 30,
  maxNavItems: 80,
  maxForms: 30,
  maxTextLength: 120,
  maxUrlLength: 300,
  maxNearbyTextLength: 60,
  maxPages: 20,
  maxEvidenceBytes: 512_000,
} as const;

/** Attributes stable enough to build a selector from. Nothing else is read. */
export const STABLE_ATTRIBUTES = [
  'id',
  'name',
  'data-testid',
  'data-test',
  'data-id',
  'data-field',
  'data-action',
  'role',
  'aria-label',
  'type',
  'for',
  'method',
] as const;

export interface ElementRef {
  /** Position within its category in its root. Never a DOM handle. */
  ordinal: number;
  tag: string;
  id?: string;
  name?: string;
  attrs?: Record<string, string>;
  /** Structural fallback, capped in depth. */
  cssPath?: string;
  visible: boolean;
}

export interface ButtonEvidence extends ElementRef {
  kind: 'button' | 'submit' | 'reset' | 'link-button' | 'image';
  label: string;
  role?: string;
  disabled: boolean;
}

export interface InputEvidence extends ElementRef {
  type: string;
  placeholder?: string;
  ariaLabel?: string;
  labelText?: string;
  required: boolean;
  readOnly: boolean;
  /**
   * True for password fields. The field's existence and name are structure;
   * its contents are a secret, and are never read.
   */
  sensitive: boolean;
}

export interface SelectEvidence extends ElementRef {
  multiple: boolean;
  ariaLabel?: string;
  labelText?: string;
  optionCount: number;
  /** Option labels and values describe the choices offered, not a person's data. */
  optionLabels: string[];
  optionValues: string[];
}

export interface CheckboxEvidence extends ElementRef {
  ariaLabel?: string;
  labelText?: string;
  nearbyText: string;
}

export interface LinkEvidence extends ElementRef {
  label: string;
  href: string;
}

export interface FormEvidence extends ElementRef {
  action: string;
  method: string;
  inputNames: string[];
}

export interface TableEvidence extends ElementRef {
  /** Column headings only. Table cells are never read — that is where leads live. */
  headings: string[];
  rowCount: number;
}

export interface NavEvidence {
  label: string;
  href?: string;
  role?: string;
  depth: number;
}

export interface RootEvidence {
  rootName: string;
  rootUrl: string;
  isMain: boolean;
  title: string;
  childFrameUrls: string[];
  nav: NavEvidence[];
  buttons: ButtonEvidence[];
  inputs: InputEvidence[];
  selects: SelectEvidence[];
  checkboxes: CheckboxEvidence[];
  links: LinkEvidence[];
  forms: FormEvidence[];
  tables: TableEvidence[];
  /** Categories that hit a cap. */
  truncated: string[];
  /** Set when the root could not be read at all. Recorded, never thrown. */
  error?: string;
}

/** One captured location in the interface. */
export interface PageEvidence {
  /** How this location was reached, for the navigation profile. */
  step: string;
  pageUrl: string;
  pageTitle: string;
  roots: RootEvidence[];
  screenshotPath: string | null;
}

export interface InterfaceEvidence {
  schemaVersion: 1;
  capturedAt: string;
  baseUrl: string;
  pages: PageEvidence[];
  redactions: {
    personalDataDropped: number;
    passwordFieldsSeen: number;
    truncatedCategories: string[];
  };
}

/**
 * Exactly what the browser-side collector returns, before the Node side
 * sanitizes it and adds the root's identity.
 *
 * Naming this precisely matters: the collector used to return `unknown` and be
 * invoked through `as never` casts, which silently hid a wrong argument shape
 * and produced empty evidence on every page.
 */
export interface CollectorOutput {
  title: string;
  childFrameUrls: string[];
  nav: NavEvidence[];
  buttons: ButtonEvidence[];
  inputs: InputEvidence[];
  selects: SelectEvidence[];
  checkboxes: CheckboxEvidence[];
  links: LinkEvidence[];
  forms: FormEvidence[];
  tables: TableEvidence[];
  truncated: string[];
  passwordFieldsSeen: number;
}

/**
 * The single argument the collector receives.
 *
 * Playwright serializes one argument into the page, so everything the collector
 * needs travels in this object.
 */
export interface CollectorOptions {
  caps: typeof EVIDENCE_CAPS;
  stableAttributes: readonly string[];
}

/** How many roots produced evidence, and how many failed outright. */
export function rootStats(evidence: InterfaceEvidence): {
  total: number;
  failed: number;
  succeeded: number;
} {
  const roots = evidence.pages.flatMap((page) => page.roots);
  const failed = roots.filter((root) => root.error).length;
  return { total: roots.length, failed, succeeded: roots.length - failed };
}

export function emptyRedactions(): InterfaceEvidence['redactions'] {
  return { personalDataDropped: 0, passwordFieldsSeen: 0, truncatedCategories: [] };
}

/** Total size guard. Categories are dropped in a fixed order, never silently. */
export function enforceSizeCap(
  evidence: InterfaceEvidence,
  maxBytes = EVIDENCE_CAPS.maxEvidenceBytes,
): InterfaceEvidence {
  const order: Array<keyof RootEvidence> = ['links', 'nav', 'checkboxes', 'tables'];
  let current = evidence;

  for (const category of order) {
    if (JSON.stringify(current).length <= maxBytes) break;
    current = {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        roots: page.roots.map((root) => ({ ...root, [category]: [] })),
      })),
      redactions: {
        ...current.redactions,
        truncatedCategories: [...new Set([...current.redactions.truncatedCategories, String(category)])],
      },
    };
  }

  return current;
}
