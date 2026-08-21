import { ControlDefinition, SelectorStrategy } from '../selectors';
import {
  ButtonEvidence,
  CheckboxEvidence,
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
  | 'label'
  | 'placeholder'
  | 'text'
  | 'css-path';

const TIER_SCORE: Record<ProposalTier, number> = {
  'stable-attribute': 100,
  id: 92,
  name: 88,
  'role-name': 76,
  label: 70,
  placeholder: 60,
  text: 48,
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
  unproposed: Array<{ control: string; reason: string }>;
}

type Category = 'input' | 'button' | 'select' | 'checkbox' | 'table';

interface ControlMatcher {
  control: string;
  categories: Category[];
  inputTypes?: string[];
  requireMultiple?: boolean;
  signals: RegExp[];
  antiSignals?: RegExp[];
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
    control: 'agents.reset_password',
    categories: ['button'],
    signals: [/reset\s+password|change\s+password|new\s+password|send\s+password/i],
    antiSignals: [/delete|purge/i],
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
    control: 'campaigns.section',
    categories: ['select', 'checkbox'],
    signals: [/campaign/i],
  },
  {
    control: 'queues.section',
    categories: ['select', 'checkbox'],
    signals: [/queue|playlist/i],
  },
  {
    control: 'licenses.table',
    categories: ['table'],
    signals: [/licen[cs]e|seat|in\s+use/i],
  },
];

interface Candidate {
  category: Category;
  element: ElementRef & Record<string, unknown>;
  pageStep: string;
  rootName: string;
  rootUrl: string;
  /** Text fields searched by the matcher signals. */
  haystack: string;
  matchedOn: string[];
}

function textOf(element: Record<string, unknown>, keys: string[]): string {
  return keys
    .map((key) => (typeof element[key] === 'string' ? (element[key] as string) : ''))
    .filter(Boolean)
    .join(' ');
}

function collectCandidates(evidence: InterfaceEvidence): Candidate[] {
  const candidates: Candidate[] = [];

  for (const page of evidence.pages) {
    for (const root of page.roots) {
      const push = (category: Category, list: ElementRef[], keys: string[]) => {
        for (const element of list) {
          const record = element as ElementRef & Record<string, unknown>;
          candidates.push({
            category,
            element: record,
            pageStep: page.step,
            rootName: root.rootName,
            rootUrl: root.rootUrl,
            haystack: [
              textOf(record, keys),
              record.id ?? '',
              record.name ?? '',
              Object.values(record.attrs ?? {}).join(' '),
            ].join(' '),
            matchedOn: keys,
          });
        }
      };

      push('input', root.inputs as InputEvidence[], ['labelText', 'ariaLabel', 'placeholder']);
      push('button', root.buttons as ButtonEvidence[], ['label']);
      push('select', root.selects as SelectEvidence[], ['labelText', 'ariaLabel']);
      push('checkbox', root.checkboxes as CheckboxEvidence[], ['labelText', 'ariaLabel', 'nearbyText']);
      push('table', root.tables as TableEvidence[], []);

      // Table headings are the only searchable text a table has.
      for (const candidate of candidates.filter((entry) => entry.category === 'table')) {
        const headings = (candidate.element.headings as string[]) ?? [];
        candidate.haystack = `${candidate.haystack} ${headings.join(' ')}`;
      }
    }
  }

  return candidates;
}

function matches(matcher: ControlMatcher, candidate: Candidate): boolean {
  if (!matcher.categories.includes(candidate.category)) return false;

  if (matcher.inputTypes) {
    const type = String(candidate.element.type ?? '').toLowerCase();
    if (!matcher.inputTypes.includes(type)) return false;
  }
  if (matcher.requireMultiple && candidate.element.multiple !== true) return false;

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

function strategyOptions(candidate: Candidate): StrategyOption[] {
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

  const buttonLabel = typeof element.label === 'string' ? element.label : '';
  if (buttonLabel && candidate.category === 'button') {
    options.push({
      tier: 'role-name',
      strategy: { type: 'role', role: 'button', name: buttonLabel, exact: true },
      key: `role:button:${buttonLabel}`,
    });
    options.push({
      tier: 'text',
      strategy: { type: 'text', value: buttonLabel, exact: true },
      key: `text:${buttonLabel}`,
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

/** Builds the proposal set for the known controls from captured evidence. */
export function proposeSelectors(
  evidence: InterfaceEvidence,
  controls: ControlDefinition[],
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

  for (const control of controls) {
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
  return { proposals, unproposed };
}

/** Whether a proposal is strong enough to be promoted to an active selector. */
export function promotable(proposal: ProposedSelector): boolean {
  return proposal.confidence >= PROMOTION_THRESHOLD && proposal.tier !== 'css-path';
}
