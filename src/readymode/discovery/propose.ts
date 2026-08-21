import { ControlDefinition, SelectorStrategy } from '../selectors';
import {
  ButtonEvidence,
  CheckboxEvidence,
  ClickableEvidence,
  ElementRef,
  InputEvidence,
  InterfaceEvidence,
  SelectEvidence,
  TableEvidence,
} from './evidence';

/**
 * Turning observed evidence into proposed selectors.
 *
 * This is where the "never invent a selector" rule is enforced mechanically. A
 * proposal is emitted only when the evidence contains exactly one element,
 * anywhere in the captured interface, that the strategy would match. A control
 * with no qualifying evidence is reported as unproposed with a reason — it is
 * never filled in with a plausible guess.
 */

export type ProposalTier =
  | 'stable-attribute'
  | 'id'
  | 'name'
  | 'field-type'
  | 'role-name'
  | 'row-control'
  | 'label'
  | 'placeholder'
  | 'text'
  | 'icon-source'
  | 'css-path';

const TIER_SCORE: Record<ProposalTier, number> = {
  'stable-attribute': 100,
  id: 92,
  name: 88,
  /**
   * A distinctive input type, such as `input[type="password"]`.
   *
   * This exists because of a real failure: a password field's placeholder is
   * deliberately withheld from evidence, so a login form whose password input
   * carries no id and no name had nothing left but a positional CSS path — and
   * positional paths are never promotable. The field reported one match and
   * stayed unusable. A type attribute is stable, is not a position, and does
   * not require reading anything the field contains.
   */
  'field-type': 86,
  // A uniquely identified table plus a control label repeated down its rows.
  // Strong evidence: both halves come from the interface, neither from position.
  'row-control': 85,
  'role-name': 76,
  label: 70,
  placeholder: 60,
  text: 48,
  // An icon's image file name is developer-supplied, so it is real evidence —
  // but it is scored below the promotion threshold deliberately. It is recorded
  // for a human to look at; it never becomes a usable selector on its own.
  'icon-source': 45,
  'css-path': 25,
};

/** Below this a proposal is recorded but never usable. */
export const PROMOTION_THRESHOLD = 60;

export interface ProposedSelector {
  control: string;
  strategy: SelectorStrategy;
  tier: ProposalTier;
  confidence: number;
  pageStep: string;
  rootName: string;
  rootUrl: string;
  evidence: {
    category: string;
    ordinal: number;
    matchedOn: string[];
    excerpt: string;
  };
  /** What must be true before this control is used, from its matcher. */
  precondition?: string;
  /** What must become true afterwards, checked before reporting success. */
  postcondition?: string;
}

export interface ProposalOutcome {
  proposals: ProposedSelector[];
  /** Every control that produced no proposal, whatever the reason. */
  unproposed: Array<{ control: string; reason: string }>;
  /**
   * Matched elements in the evidence, but none that could be identified
   * uniquely. Distinct from unresolved: something is there, and the fix is a
   * better matcher rather than another crawl.
   */
  ambiguous: Array<{ control: string; reason: string }>;
  /** Nothing in the captured interface matched at all. */
  unresolved: Array<{ control: string; reason: string }>;
  /** No evidence matcher is defined, so no run could ever resolve it. */
  withoutMatchers: Array<{ control: string; reason: string }>;
  /**
   * Controls that were never on screen during this run — the login form when
   * the session was already signed in, for example. Distinct from unproposed:
   * nothing was wrong, there was simply nothing to look at.
   */
  notObservable: Array<{ control: string; reason: string }>;
}

export interface ProposalOptions {
  /** Control name to the reason it could not be observed this run. */
  skip?: Record<string, string>;
}

type Category = 'input' | 'button' | 'select' | 'checkbox' | 'table' | 'clickable';

interface ControlMatcher {
  control: string;
  categories: Category[];
  inputTypes?: string[];
  requireMultiple?: boolean;
  signals: RegExp[];
  antiSignals?: RegExp[];
  /**
   * The element's own label must equal one of these exactly.
   *
   * This is how a control an operator named is pinned down: "Sign Out Inactive
   * Users" is one specific button, and "Sign Out Everyone Else" — which signs
   * out every other administrator — sits next to it. A pattern that admits both
   * is not good enough here.
   */
  exactLabels?: string[];
  /**
   * The panel the control has to have been observed in, by heading.
   *
   * Starter shows "Save" in the Lead Playlist Editor, in Edit Queue and in
   * Campaign Settings, and they are three different controls. Nothing but the
   * surrounding panel tells them apart, so a matcher for one of them says which
   * panel it means.
   */
  panels?: string[];
  /** For tables: headings that must be present, and how many of them. */
  requireHeadings?: string[];
  minHeadings?: number;
  /** For tables: a control label repeated down the rows, e.g. "Sign Out". */
  requireRowControl?: string;
  /**
   * The route the control was observed on, as recorded by the inspection.
   *
   * Matched against the URL the evidence was captured at, so a control that
   * only exists on License Usage cannot be proposed from something that looked
   * similar on the dashboard.
   */
  route?: string;
  /** The frame the control lives in. Absent means the main document. */
  frame?: string;
  /** `button`, `input`, `select`, `table`, `tab`, `link`, `checkbox`. */
  elementType?: string;
  /** What has to be true before this control can be used. Carried into the proposal. */
  precondition?: string;
  /** What has to become true afterwards, checked before reporting success. */
  postcondition?: string;
}

/**
 * What each control looks like in evidence. These are matching heuristics over
 * observed elements — not selectors. Nothing here reaches Readymode unless an
 * element in the real captured page satisfies it.
 */
export const CONTROL_MATCHERS: ControlMatcher[] = [
  {
    control: 'login.username',
    categories: ['input'],
    inputTypes: ['text', 'email', 'tel'],
    signals: [/user\s*name|username|^user$|login|email|account/i],
    antiSignals: [/password|search|remember/i],
    precondition: 'The login page is on screen.',
    postcondition: 'The field accepts input.',
  },
  {
    // Identified by its type alone. A password field's placeholder is withheld
    // at collection, so a login form that gives its password box no id and no
    // name leaves nothing else stable to go on — and the value is never read.
    control: 'login.password',
    categories: ['input'],
    inputTypes: ['password'],
    elementType: 'input',
    signals: [/.*/],
    precondition: 'The login page is on screen.',
    postcondition: 'The field accepts input; its value is never read.',
  },
  {
    /**
     * The Continue control on Readymode's "already logged in" notice.
     *
     * Context is required, not optional. A bare "Continue" somewhere on a page
     * is not this control, and clicking one because it said Continue is
     * precisely the mistake to avoid — so the notice's own wording has to be on
     * screen for the evidence to count.
     */
    control: 'login.continue_existing_session',
    categories: ['button', 'clickable'],
    exactLabels: ['Continue'],
    // The notice text, which the collector captures as surrounding context.
    signals: [/already (?:logged|signed) ?in|log out all your other sessions/i],
    antiSignals: [/delete|remove|purge|cancel/i],
    precondition:
      'Readymode reported that this administrator is already signed in, on the configured domain, with no human verification on screen.',
    postcondition: 'The Dashboard or License Usage becomes visible.',
  },
  {
    control: 'login.submit',
    categories: ['button'],
    signals: [/log\s?in|sign\s?in|submit|enter|go\b/i],
    antiSignals: [/forgot|reset|cancel|register/i],
    precondition: 'The login page is on screen.',
    postcondition: 'The field accepts input; its value is never read.',
  },
  {
    control: 'agents.search',
    categories: ['input'],
    inputTypes: ['text', 'search'],
    signals: [/search|find|filter|lookup/i],
    antiSignals: [/password|lead|phone/i],
    precondition: 'User Management is open.',
    postcondition: 'The user list narrows to the search term.',
  },
  {
    control: 'agents.rows',
    categories: ['table'],
    signals: [/user|agent|login|name|licen[cs]e|status/i],
    precondition: 'User Management is open.',
    postcondition: 'At least one row is listed.',
  },
  {
    control: 'agents.create',
    categories: ['button'],
    signals: [/add\s+(?:a\s+)?(?:new\s+)?(?:user|agent|account)|create\s+(?:user|agent|account)|new\s+(?:user|agent|account)/i],
    antiSignals: [/lead|campaign|queue|playlist|delete/i],
    precondition: 'User Management is open and a destination folder is chosen.',
    postcondition: 'The User Creation Tool opens.',
  },
  {
    control: 'agents.clear_license',
    categories: ['button'],
    signals: [/clear\s+licen[cs]e|release\s+licen[cs]e|free\s+licen[cs]e|force\s?log\s?out|sign\s?out\s+user/i],
    antiSignals: [/delete|remove\s+user|purge/i],
    precondition: 'The agent holding the licence has been uniquely identified.',
    postcondition: 'The agent no longer holds a licence.',
  },
  {
    // Observed: a "Reset password" field with a "Reset" button beside it, on a
    // user's Account Settings tab. "Reset" alone is far too generic to accept
    // anywhere else, so the panel is part of the matcher.
    control: 'agents.reset_password',
    categories: ['button', 'clickable'],
    exactLabels: ['Reset', 'Reset Password', 'Reset password'],
    panels: ['Account Settings', 'User Management'],
    signals: [/.*/],
    antiSignals: [/delete|purge|factory/i],
    precondition: 'The agent\'s Account Settings tab is open.',
    postcondition: 'Readymode confirms the password was reset; ReadySupport never sees it.',
  },
  {
    // Observed at the foot of License Usage. "Sign Out Everyone Else" sits
    // beside it and signs out every other administrator; the exact label is the
    // only thing that keeps them apart.
    control: 'users.log_out_inactive',
    categories: ['button', 'clickable'],
    exactLabels: ['Sign Out Inactive Users'],
    panels: ['License Usage'],
    signals: [/.*/],
    precondition: 'License Usage is open and an administrator approved releasing idle sessions.',
    postcondition: 'Fewer licences are in use, or Readymode reported none were idle.',
  },
  {
    // Per-row, by construction: one "Sign Out" in every user's row. The
    // proposal identifies the table and the repeated label; which row is acted
    // on is decided at run time by matching the user.
    control: 'agents.force_logout',
    categories: ['table'],
    panels: ['License Usage'],
    requireRowControl: 'Sign Out',
    signals: [/.*/],
    precondition: 'License Usage is open and exactly one row matches the named user.',
    postcondition: 'That row reads as signed out and the remaining licence count rose.',
  },
  {
    control: 'agents.deactivate',
    categories: ['button'],
    signals: [/deactivate|disable\s+(?:user|account|agent)|suspend/i],
    antiSignals: [/delete|remove|purge|erase|terminate/i],
    precondition: 'The agent\'s record is open.',
    postcondition: 'The record reads as inactive.',
  },
  {
    control: 'agents.save',
    categories: ['button'],
    signals: [/^\s*(?:save|update|apply|save\s+changes)\s*$/i],
    antiSignals: [/delete|remove|cancel|purge/i],
    precondition: 'The agent\'s record is open and a field was changed.',
    postcondition: 'Re-reading the record shows the new value.',
  },
  {
    control: 'states.section',
    categories: ['select', 'checkbox'],
    signals: [/state|territor|region/i],
    antiSignals: [/estate|statement|status/i],
    precondition: 'The agent\'s record is open.',
    postcondition: 'The state control is on screen.',
  },
  {
    control: 'states.multiselect',
    categories: ['select'],
    requireMultiple: true,
    signals: [/state|territor|region/i],
    antiSignals: [/estate|statement|status/i],
    precondition: 'The agent\'s record is open.',
    postcondition: 'The control lists the states available.',
  },
  {
    control: 'states.checkboxes',
    categories: ['checkbox'],
    signals: [/state|territor|region/i],
    antiSignals: [/estate|statement|status/i],
    precondition: 'The agent\'s record is open.',
    postcondition: 'One checkbox per state is on screen.',
  },
  {
    // Observed as a tab inside Lead Management, not a form section.
    control: 'campaigns.section',
    categories: ['clickable', 'button', 'select', 'checkbox'],
    exactLabels: ['Campaigns'],
    panels: ['Lead Management', 'Campaign Settings'],
    signals: [/.*/],
    precondition: 'Lead Management is open.',
    postcondition: 'The Campaigns tab panel is shown.',
  },
  {
    control: 'campaigns.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close'],
    // Only from inside Campaign Settings. A "Save" seen anywhere else is a
    // different button, and using it would save the wrong screen.
    panels: ['Campaign Settings'],
    signals: [/.*/],
    precondition: 'Campaign Settings is open and a field was changed.',
    postcondition: 'Re-reading the campaign shows the new value.',
  },
  {
    control: 'queues.section',
    categories: ['clickable', 'button', 'select', 'checkbox'],
    exactLabels: ['Queues'],
    panels: ['Lead Management', 'Edit Queue'],
    signals: [/.*/],
    precondition: 'Lead Management is open.',
    postcondition: 'The Queues tab panel is shown.',
  },
  {
    control: 'queues.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close'],
    panels: ['Edit Queue'],
    signals: [/.*/],
    precondition: 'Edit Queue is open and a field was changed.',
    postcondition: 'Re-reading the queue shows the new value.',
  },
  {
    // Queue membership is organized into playlists, each offering "Add a queue
    // member". That phrase is the section's own name for itself.
    control: 'playlists.section',
    categories: ['clickable', 'button', 'select', 'checkbox'],
    panels: ['Edit Queue', 'Lead Playlist Editor'],
    signals: [/add\s+a\s+queue\s+member|playlist/i],
    precondition: 'A queue is open on its Members tab.',
    postcondition: 'The playlist membership section is on screen.',
  },
  {
    control: 'playlists.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close'],
    panels: ['Lead Playlist Editor'],
    signals: [/.*/],
    precondition: 'The Lead Playlist Editor is open and a filter was changed.',
    postcondition: 'Re-opening the playlist shows the new filter.',
  },
  {
    // Read-only: whether an agent currently holds a session. Never a claim
    // about a named person outside the row it was read in.
    control: 'agents.logged_in',
    categories: ['table', 'clickable'],
    route: '+Team/ManageLicenses',
    signals: [/signed\s*in|logged\s*in|last\s*active|status/i],
    precondition: 'License Usage is open.',
    postcondition: 'The column that reports session state was read.',
  },
  {
    control: 'states.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close', 'Update'],
    // A user's own record, reached by matching the person — the only screen
    // where saving means saving that person's states.
    panels: ['Account Settings', 'User Management'],
    signals: [/.*/],
    antiSignals: [/delete|remove|cancel|purge|reset/i],
    precondition: "The agent's record is open and the state control was changed.",
    postcondition: 'Re-reading the record shows the states that were set.',
  },
  {
    // The users table on License Usage, identified by the columns an operator
    // read off the screen — so it is not confused with the two summary tables
    // above it.
    control: 'licenses.table',
    categories: ['table'],
    panels: ['License Usage'],
    requireHeadings: [
      'User Id',
      'User Account',
      'User Name',
      'License Type',
      'Signed In',
      'Last Active',
    ],
    minHeadings: 3,
    signals: [/.*/],
    precondition: 'License Usage is open.',
    postcondition: 'The table of users holding a licence was read; row contents are never captured.',
  },
];
interface Candidate {
  category: Category;
  element: ElementRef & Record<string, unknown>;
  pageStep: string;
  /** The address the evidence was captured at, for route-scoped matchers. */
  pageUrl: string;
  /** The panel that was open when this element was seen, by heading. */
  panelState: string | null;
  rootName: string;
  rootUrl: string;
  /** Text fields searched by the matcher signals. */
  haystack: string;
  /** The element's own label text, for exact-label matching. */
  labels: string[];
  matchedOn: string[];
  /**
   * Identity of the underlying DOM element, independent of which category it
   * was collected under.
   *
   * A <button> is reported both as a button and as a legacy clickable — the
   * collector looks for both because Starter's toolbars are neither. Without
   * this, one element would be counted twice and every button would look like
   * two identical elements, which is to say ambiguous, which is to say no
   * selector would ever be proposed for one.
   */
  identity: string;
}

function textOf(element: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => (typeof element[key] === 'string' ? (element[key] as string) : ''))
    .filter(Boolean)
    .join(' ');
}

function labelsOf(element: Record<string, unknown>): string[] {
  return ['label', 'labelText', 'ariaLabel', 'title', 'alt']
    .map((key) => (typeof element[key] === 'string' ? (element[key] as string).trim() : ''))
    .filter(Boolean);
}

function identityOf(element: ElementRef & Record<string, unknown>, pageStep: string, root: string): string {
  return [
    pageStep,
    root,
    element.tag,
    element.id ?? '',
    element.name ?? '',
    element.cssPath ?? '',
    JSON.stringify(element.attrs ?? {}),
    labelsOf(element).join('|'),
  ].join('~');
}

function collectCandidates(evidence: InterfaceEvidence): Candidate[] {
  const candidates: Candidate[] = [];

  for (const page of evidence.pages) {
    for (const root of page.roots) {
      const push = (category: Category, list: ElementRef[] | undefined, keys: string[]) => {
        for (const element of list ?? []) {
          const record = element as ElementRef & Record<string, unknown>;
          candidates.push({
            category,
            element: record,
            pageStep: page.step,
            pageUrl: page.pageUrl,
            panelState: page.panelState ?? null,
            rootName: root.rootName,
            rootUrl: root.rootUrl,
            haystack: [
              textOf(record, keys),
              record.id ?? '',
              record.name ?? '',
              Object.values(record.attrs ?? {}).join(' '),
            ].join(' '),
            labels: labelsOf(record),
            matchedOn: keys,
            identity: identityOf(record, page.step, root.rootName),
          });
        }
      };

      push('input', root.inputs as InputEvidence[], ['labelText', 'ariaLabel', 'placeholder']);
      push('button', root.buttons as ButtonEvidence[], ['label']);
      push('select', root.selects as SelectEvidence[], ['labelText', 'ariaLabel']);
      push('checkbox', root.checkboxes as CheckboxEvidence[], ['labelText', 'ariaLabel', 'nearbyText']);
      push('table', root.tables as TableEvidence[], []);
      // Legacy clickables: toolbar icons, spans with onclick, clickable images.
      // Without these an interface built out of <img onclick> looks empty.
      push('clickable', root.clickables as ClickableEvidence[], [
        'label',
        'title',
        'alt',
        'ariaLabel',
        'context',
        'imageSource',
      ]);

      // A table's searchable text is its column headings and the labels of the
      // controls repeated down its rows. Cell contents are never collected.
      for (const candidate of candidates) {
        if (candidate.category !== 'table') continue;
        const headings = (candidate.element.headings as string[]) ?? [];
        const rowControls = (candidate.element.rowControls as string[]) ?? [];
        if (candidate.haystack.includes(headings.join(' ')) && headings.length > 0) continue;
        candidate.haystack = `${candidate.haystack} ${headings.join(' ')} ${rowControls.join(' ')}`;
      }
    }
  }

  return candidates;
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matches(matcher: ControlMatcher, candidate: Candidate): boolean {
  if (!matcher.categories.includes(candidate.category)) return false;

  if (matcher.inputTypes) {
    const type = String(candidate.element.type ?? '').toLowerCase();
    if (!matcher.inputTypes.includes(type)) return false;
  }
  if (matcher.requireMultiple && candidate.element.multiple !== true) return false;

  // Panel scoping. A control that says which panel it belongs to is only
  // matched by evidence captured while that panel was open — which is what
  // keeps three different "Save" buttons from being confused for one.
  if (matcher.panels) {
    const panel = candidate.panelState;
    if (!panel || !matcher.panels.some((allowed) => normalizeLabel(allowed) === normalizeLabel(panel))) {
      return false;
    }
  }

  if (matcher.exactLabels) {
    const wanted = matcher.exactLabels.map(normalizeLabel);
    const actual = candidate.labels.map(normalizeLabel);
    if (!actual.some((label) => wanted.includes(label))) return false;
  }

  if (matcher.requireHeadings) {
    const headings = ((candidate.element.headings as string[]) ?? []).map(normalizeLabel);
    const present = matcher.requireHeadings.filter((heading) =>
      headings.includes(normalizeLabel(heading)),
    ).length;
    if (present < (matcher.minHeadings ?? matcher.requireHeadings.length)) return false;
  }

  if (matcher.requireRowControl) {
    const rowControls = ((candidate.element.rowControls as string[]) ?? []).map(normalizeLabel);
    if (!rowControls.includes(normalizeLabel(matcher.requireRowControl))) return false;
  }

  // Route scoping. A control observed only on License Usage may not be proposed
  // from something that looked similar on another screen.
  if (matcher.route) {
    const wanted = matcher.route.replace(/ /g, '%20');
    const url = candidate.pageUrl ?? '';
    if (!url.includes(matcher.route) && !url.includes(wanted)) return false;
  }

  if (matcher.frame && normalizeLabel(candidate.rootName) !== normalizeLabel(matcher.frame)) {
    return false;
  }

  if (matcher.elementType) {
    const tag = String(candidate.element.tag ?? '').toLowerCase();
    const role = String(candidate.element.role ?? '').toLowerCase();
    if (tag !== matcher.elementType && role !== matcher.elementType) return false;
  }

  const haystack = candidate.haystack;
  if (matcher.antiSignals?.some((pattern) => pattern.test(haystack))) return false;
  return matcher.signals.some((pattern) => pattern.test(haystack));
}

interface StrategyOption {
  tier: ProposalTier;
  strategy: SelectorStrategy;
  /** Identity used to test uniqueness across the whole evidence set. */
  key: string;
}

const GENERATED_LOOKING = /^(?:ctl|ui|comp|react|ember|ng)[-_]?\d|\d{4,}|[0-9a-f]{8}-[0-9a-f]{4}/i;

/**
 * Input types specific enough to identify a field by themselves.
 *
 * `text` is deliberately absent: every form has several.
 */
const DISTINCTIVE_INPUT_TYPES = new Set(['password', 'email', 'search', 'tel', 'file']);

function strategyOptions(candidate: Candidate, matcher?: ControlMatcher): StrategyOption[] {
  const options: StrategyOption[] = [];
  const element = candidate.element;
  const attrs = element.attrs ?? {};

  for (const attribute of ['data-testid', 'data-test', 'data-id', 'data-field', 'data-action']) {
    const value = attrs[attribute];
    if (value) {
      options.push({
        tier: 'stable-attribute',
        strategy: { type: 'testId', value },
        key: `attr:${attribute}=${value}`,
      });
    }
  }

  if (element.id) {
    options.push({
      tier: 'id',
      strategy: { type: 'css', value: `#${element.id}` },
      key: `id:${element.id}`,
    });
  }

  if (element.name) {
    options.push({
      tier: 'name',
      strategy: { type: 'css', value: `${element.tag}[name="${element.name}"]` },
      key: `name:${element.tag}[${element.name}]`,
    });
  }

  /**
   * An unlabelled icon gets nothing beyond the DOM evidence above.
   *
   * Starter's toolbars are images with no text — a green plus, and others whose
   * purpose is not written anywhere. A selector for one of those could only be
   * built from how it looks or where it sits, and both are guesses about what
   * the control does. So: an icon with no id, no name and no stable attribute
   * produces no proposal at all, and the control stays unresolved until someone
   * looks at the evidence.
   */
  const hasLabel = candidate.labels.length > 0;
  if (candidate.category === 'clickable' && !hasLabel) {
    const imageSource = typeof element.imageSource === 'string' ? element.imageSource : '';
    if (imageSource) {
      // Recorded, deliberately below the promotion threshold: a file name is
      // real evidence a person can check, but it is not a selector to act on.
      options.push({
        tier: 'icon-source',
        strategy: { type: 'css', value: `${element.tag}:has(img[src*="${imageSource}"])` },
        key: `icon:${imageSource}`,
      });
    }
    return options;
  }

  // A table with a control repeated down its rows: propose the table plus the
  // exact row-control label, never a selector that would match every row.
  if (candidate.category === 'table' && matcher?.requireRowControl) {
    const scope = element.id
      ? `#${element.id}`
      : element.cssPath
        ? String(element.cssPath)
        : '';
    if (scope) {
      options.push({
        tier: 'row-control',
        strategy: { type: 'rowControl', scope, label: matcher.requireRowControl },
        key: `row:${scope}:${matcher.requireRowControl}`,
      });
    }
    return options;
  }

  // A distinctive input type identifies the field on its own. Login forms are
  // the case that matters: there is one password box, and it is the password
  // box whether or not anybody gave it an id.
  const fieldType = String(element.type ?? '').toLowerCase();
  if (candidate.category === 'input' && DISTINCTIVE_INPUT_TYPES.has(fieldType)) {
    options.push({
      tier: 'field-type',
      strategy: { type: 'css', value: `input[type="${fieldType}"]` },
      key: `fieldType:${fieldType}`,
    });
  }

  const label = typeof element.labelText === 'string' ? element.labelText : '';
  if (label) {
    options.push({ tier: 'label', strategy: { type: 'label', value: label, exact: true }, key: `label:${label}` });
  }

  const placeholder = typeof element.placeholder === 'string' ? element.placeholder : '';
  if (placeholder) {
    options.push({
      tier: 'placeholder',
      strategy: { type: 'placeholder', value: placeholder },
      key: `placeholder:${placeholder}`,
    });
  }

  const visibleLabel = typeof element.label === 'string' ? element.label : '';
  if (visibleLabel && (candidate.category === 'button' || candidate.category === 'clickable')) {
    const role = candidate.category === 'button' ? 'button' : roleOf(element);
    if (role) {
      options.push({
        tier: 'role-name',
        strategy: { type: 'role', role, name: visibleLabel, exact: true },
        key: `role:${role}:${visibleLabel}`,
      });
    }
    options.push({
      tier: 'text',
      strategy: { type: 'text', value: visibleLabel, exact: true },
      key: `text:${visibleLabel}`,
    });
  }

  /**
   * A positional CSS path is deliberately not offered.
   *
   * `form > div:nth-of-type(2) > input` identifies an element by where it sits,
   * so it breaks the moment anything is inserted above it — and it was never
   * promotable anyway, so proposing one only produced a row in the review that
   * could never be used. The path is still recorded as evidence, where a person
   * can read it; it is not offered as a way to find the control again.
   */
  return options;
}

/** The ARIA role a legacy clickable can honestly claim, if any. */
function roleOf(element: Record<string, unknown>): string | null {
  const explicit = typeof element.role === 'string' ? element.role : (element.attrs as Record<string, string> | undefined)?.role;
  if (explicit) return explicit;
  const tag = String(element.tag ?? '').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  return null;
}

/** Builds the proposal set for the known controls from captured evidence. */
export function proposeSelectors(
  evidence: InterfaceEvidence,
  controls: ControlDefinition[],
  options: ProposalOptions = {},
): ProposalOutcome {
  const candidates = collectCandidates(evidence);

  /**
   * How many elements each strategy would match, counted per captured page.
   *
   * Per page, not across the whole evidence set. The same control appearing on
   * the dashboard and again on User Management is one control seen twice, not
   * two ambiguous ones, and counting globally made every element that survives
   * navigation look ambiguous — which is a control being *more* reliable, not
   * less.
   *
   * Within a page it stays strict: a strategy matching two elements, or
   * matching in two frames, identifies neither.
   */
  const keyCounts = new Map<string, Map<string, number>>();

  /**
   * Identities seen under a category other than `clickable`, per page.
   *
   * A <button> is reported twice — once as a button, once as a legacy
   * clickable, because Starter's toolbars are neither and the collector has to
   * look for both. Counting it twice would make every labelled button look
   * ambiguous. Counting by identity alone would go too far the other way and
   * merge two genuinely distinct elements that happen to be indistinguishable,
   * which is exactly the case that must stay ambiguous.
   *
   * So: a clickable is skipped only when the same element was already reported
   * under a more specific category on the same page.
   */
  const specificIdentities = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.category === 'clickable') continue;
    const perPage = specificIdentities.get(candidate.pageStep) ?? new Set<string>();
    perPage.add(candidate.identity);
    specificIdentities.set(candidate.pageStep, perPage);
  }

  for (const candidate of candidates) {
    if (
      candidate.category === 'clickable' &&
      specificIdentities.get(candidate.pageStep)?.has(candidate.identity)
    ) {
      continue;
    }

    for (const option of strategyOptions(candidate)) {
      const perPage = keyCounts.get(candidate.pageStep) ?? new Map<string, number>();
      perPage.set(option.key, (perPage.get(option.key) ?? 0) + 1);
      keyCounts.set(candidate.pageStep, perPage);
    }
  }

  const matchesOnItsPage = (candidate: Candidate, key: string): number =>
    keyCounts.get(candidate.pageStep)?.get(key) ?? 0;

  const proposals: ProposedSelector[] = [];
  const unproposed: Array<{ control: string; reason: string }> = [];
  const ambiguous: Array<{ control: string; reason: string }> = [];
  const unresolved: Array<{ control: string; reason: string }> = [];
  const withoutMatchers: Array<{ control: string; reason: string }> = [];
  const notObservable: Array<{ control: string; reason: string }> = [];

  for (const control of controls) {
    const skipped = options.skip?.[control.name];
    if (skipped) {
      notObservable.push({ control: control.name, reason: skipped });
      continue;
    }

    const matcher = CONTROL_MATCHERS.find((entry) => entry.control === control.name);
    if (!matcher) {
      const entry = {
        control: control.name,
        reason: 'No evidence matcher is defined for this control, so no run can resolve it.',
      };
      unproposed.push(entry);
      withoutMatchers.push(entry);
      continue;
    }

    const matching = candidates.filter((candidate) => matches(matcher, candidate));
    if (matching.length === 0) {
      const entry = {
        control: control.name,
        reason: 'No element in the captured interface matched this control.',
      };
      unproposed.push(entry);
      unresolved.push(entry);
      continue;
    }

    let best: ProposedSelector | null = null;
    let ambiguousOnly = true;

    for (const candidate of matching) {
      for (const option of strategyOptions(candidate, matcher)) {
        // The uniqueness rule: one element on the page it was seen on.
        if (matchesOnItsPage(candidate, option.key) !== 1) continue;
        ambiguousOnly = false;

        let confidence = TIER_SCORE[option.tier];
        if (GENERATED_LOOKING.test(option.key)) confidence -= 15;
        if (!candidate.element.visible) confidence -= 40;

        if (confidence < 0) confidence = 0;
        if (!best || confidence > best.confidence) {
          best = {
            control: control.name,
            strategy: option.strategy,
            tier: option.tier,
            confidence,
            pageStep: candidate.pageStep,
            rootName: candidate.rootName,
            rootUrl: candidate.rootUrl,
            evidence: {
              category: candidate.category,
              ordinal: candidate.element.ordinal,
              matchedOn: candidate.matchedOn,
              excerpt: candidate.haystack.slice(0, 120),
            },
            precondition: matcher.precondition,
            postcondition: matcher.postcondition,
          };
        }
      }
    }

    if (!best) {
      const entry = {
        control: control.name,
        reason: ambiguousOnly
          ? `Matched ${matching.length} element(s), but none could be identified uniquely.`
          : 'No usable strategy could be built from the evidence.',
      };
      unproposed.push(entry);
      (ambiguousOnly ? ambiguous : unresolved).push(entry);
      continue;
    }

    proposals.push(best);
  }

  proposals.sort((a, b) => b.confidence - a.confidence);
  return { proposals, unproposed, ambiguous, unresolved, withoutMatchers, notObservable };
}

/** Whether a proposal is strong enough to be promoted to an active selector. */
export function promotable(proposal: ProposedSelector): boolean {
  return proposal.confidence >= PROMOTION_THRESHOLD && proposal.tier !== 'css-path';
}
