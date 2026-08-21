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
}

export interface ProposalOutcome {
  proposals: ProposedSelector[];
  /** Controls the evidence covered but could not identify uniquely. */
  unproposed: Array<{ control: string; reason: string }>;
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
  },
  { control: 'login.password', categories: ['input'], inputTypes: ['password'], signals: [/.*/] },
  {
    control: 'login.submit',
    categories: ['button'],
    signals: [/log\s?in|sign\s?in|submit|enter|go\b/i],
    antiSignals: [/forgot|reset|cancel|register/i],
  },
  {
    control: 'agents.search',
    categories: ['input'],
    inputTypes: ['text', 'search'],
    signals: [/search|find|filter|lookup/i],
    antiSignals: [/password|lead|phone/i],
  },
  {
    control: 'agents.rows',
    categories: ['table'],
    signals: [/user|agent|login|name|licen[cs]e|status/i],
  },
  {
    control: 'agents.create',
    categories: ['button'],
    signals: [/add\s+(?:a\s+)?(?:new\s+)?(?:user|agent|account)|create\s+(?:user|agent|account)|new\s+(?:user|agent|account)/i],
    antiSignals: [/lead|campaign|queue|playlist|delete/i],
  },
  {
    control: 'agents.clear_license',
    categories: ['button'],
    signals: [/clear\s+licen[cs]e|release\s+licen[cs]e|free\s+licen[cs]e|force\s?log\s?out|sign\s?out\s+user/i],
    antiSignals: [/delete|remove\s+user|purge/i],
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
  },
  {
    control: 'agents.deactivate',
    categories: ['button'],
    signals: [/deactivate|disable\s+(?:user|account|agent)|suspend/i],
    antiSignals: [/delete|remove|purge|erase|terminate/i],
  },
  {
    control: 'agents.save',
    categories: ['button'],
    signals: [/^\s*(?:save|update|apply|save\s+changes)\s*$/i],
    antiSignals: [/delete|remove|cancel|purge/i],
  },
  {
    control: 'states.section',
    categories: ['select', 'checkbox'],
    signals: [/state|territor|region/i],
    antiSignals: [/estate|statement|status/i],
  },
  {
    control: 'states.multiselect',
    categories: ['select'],
    requireMultiple: true,
    signals: [/state|territor|region/i],
    antiSignals: [/estate|statement|status/i],
  },
  {
    control: 'states.checkboxes',
    categories: ['checkbox'],
    signals: [/state|territor|region/i],
    antiSignals: [/estate|statement|status/i],
  },
  {
    // Observed as a tab inside Lead Management, not a form section.
    control: 'campaigns.section',
    categories: ['clickable', 'button', 'select', 'checkbox'],
    exactLabels: ['Campaigns'],
    panels: ['Lead Management', 'Campaign Settings'],
    signals: [/.*/],
  },
  {
    control: 'campaigns.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close'],
    // Only from inside Campaign Settings. A "Save" seen anywhere else is a
    // different button, and using it would save the wrong screen.
    panels: ['Campaign Settings'],
    signals: [/.*/],
  },
  {
    control: 'queues.section',
    categories: ['clickable', 'button', 'select', 'checkbox'],
    exactLabels: ['Queues'],
    panels: ['Lead Management', 'Edit Queue'],
    signals: [/.*/],
  },
  {
    control: 'queues.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close'],
    panels: ['Edit Queue'],
    signals: [/.*/],
  },
  {
    // Queue membership is organized into playlists, each offering "Add a queue
    // member". That phrase is the section's own name for itself.
    control: 'playlists.section',
    categories: ['clickable', 'button', 'select', 'checkbox'],
    panels: ['Edit Queue', 'Lead Playlist Editor'],
    signals: [/add\s+a\s+queue\s+member|playlist/i],
  },
  {
    control: 'playlists.save',
    categories: ['button', 'clickable'],
    exactLabels: ['Save', 'Save and Close'],
    panels: ['Lead Playlist Editor'],
    signals: [/.*/],
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
  },
];
interface Candidate {
  category: Category;
  element: ElementRef & Record<string, unknown>;
  pageStep: string;
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

  if (element.cssPath) {
    options.push({
      tier: 'css-path',
      strategy: { type: 'css', value: String(element.cssPath) },
      key: `css:${element.cssPath}`,
    });
  }

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

  // How many elements anywhere in the evidence each strategy key would match.
  const keyCounts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const option of strategyOptions(candidate)) {
      keyCounts.set(option.key, (keyCounts.get(option.key) ?? 0) + 1);
    }
  }

  const proposals: ProposedSelector[] = [];
  const unproposed: Array<{ control: string; reason: string }> = [];
  const notObservable: Array<{ control: string; reason: string }> = [];

  for (const control of controls) {
    const skipped = options.skip?.[control.name];
    if (skipped) {
      notObservable.push({ control: control.name, reason: skipped });
      continue;
    }

    const matcher = CONTROL_MATCHERS.find((entry) => entry.control === control.name);
    if (!matcher) {
      unproposed.push({ control: control.name, reason: 'No evidence matcher is defined for this control.' });
      continue;
    }

    const matching = candidates.filter((candidate) => matches(matcher, candidate));
    if (matching.length === 0) {
      unproposed.push({
        control: control.name,
        reason: 'No element in the captured interface matched this control.',
      });
      continue;
    }

    let best: ProposedSelector | null = null;
    let ambiguousOnly = true;

    for (const candidate of matching) {
      for (const option of strategyOptions(candidate)) {
        // The uniqueness rule: one element, anywhere in the evidence.
        if ((keyCounts.get(option.key) ?? 0) !== 1) continue;
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
          };
        }
      }
    }

    if (!best) {
      unproposed.push({
        control: control.name,
        reason: ambiguousOnly
          ? `Matched ${matching.length} element(s), but none could be identified uniquely.`
          : 'No usable strategy could be built from the evidence.',
      });
      continue;
    }

    proposals.push(best);
  }

  proposals.sort((a, b) => b.confidence - a.confidence);
  return { proposals, unproposed, notObservable };
}

/** Whether a proposal is strong enough to be promoted to an active selector. */
export function promotable(proposal: ProposedSelector): boolean {
  return proposal.confidence >= PROMOTION_THRESHOLD && proposal.tier !== 'css-path';
}
