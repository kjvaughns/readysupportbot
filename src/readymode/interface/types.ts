import type { SelectorStrategy } from '../selectors';

/**
 * The interface registry: what ReadySupport knows about Readymode's screens.
 *
 * This is deliberately separate from the Help Center knowledge base. Knowledge
 * explains what a feature is for and is quoted to people; the registry says
 * which element to click and is acted on by a browser. Mixing them would let a
 * sentence from a support article turn into a click, so they do not share a
 * directory, a table, or a type.
 */

/**
 * How much is actually known about a control, from weakest to strongest.
 *
 * `documented` means an official article or an operator described it. That is
 * not evidence that it exists on this account's screen, so it is never enough
 * to automate — which is the whole point of keeping the two apart.
 */
export type EvidenceStatus =
  | 'documented'
  | 'discovered'
  | 'implemented'
  | 'dry_run_tested'
  | 'live_tested'
  | 'blocked'
  | 'unsupported';

export const EVIDENCE_STATUSES: EvidenceStatus[] = [
  'documented',
  'discovered',
  'implemented',
  'dry_run_tested',
  'live_tested',
  'blocked',
  'unsupported',
];

/**
 * The only statuses that may be proposed for automation.
 *
 * `implemented` is absent on purpose: it describes ReadySupport's own code, not
 * the interface, and code existing has never been evidence that a selector is
 * right.
 */
export const AUTOMATABLE_STATUSES: EvidenceStatus[] = [
  'discovered',
  'dry_run_tested',
  'live_tested',
];

export function isAutomatable(status: EvidenceStatus): boolean {
  return AUTOMATABLE_STATUSES.includes(status);
}

/** What a control does, which decides what approval it needs. */
export type SafetyClass =
  /** Reads only. */
  | 'read_only'
  /** Moves between screens, changes nothing. */
  | 'navigation'
  /** Writes to Readymode. */
  | 'modifies_data'
  /** Ends somebody's session. */
  | 'terminates_session'
  /** Removes data, or cannot be undone. */
  | 'destructive'
  /** A person has to do this themselves — passwords, credentials, uploads. */
  | 'human_only';

export const MODIFYING_SAFETY_CLASSES: SafetyClass[] = [
  'modifies_data',
  'terminates_session',
  'destructive',
];

export function isModifying(safety: SafetyClass): boolean {
  return MODIFYING_SAFETY_CLASSES.includes(safety);
}

export type InterfaceVersion = 'starter' | 'iq' | 'unknown';

/**
 * One control, with everything needed to decide whether it may be used.
 *
 * Every field is required — including the ones that are usually null. A control
 * with no known postcondition has to say so explicitly rather than leave the
 * field off, because "we do not know how to verify this worked" is exactly the
 * fact that must not go unnoticed.
 */
export interface InterfaceControl {
  /** Stable identity, e.g. `licenses.sign_out_user`. */
  key: string;
  /** The page or workflow this control belongs to. */
  page: string;
  /** How to find it. */
  strategy: SelectorStrategy;
  /** The label a person sees, when it has one. Icons often do not. */
  expectedLabel: string | null;
  /** `button`, `input`, `link`, `select`, `table`, `tab`, `checkbox`, `file`. */
  expectedElement: string;
  /** Frame name or selector; null means the main document. */
  expectedFrame: string | null;
  /** Route relative to the organization's base URL; null when there is none. */
  expectedRoute: string | null;
  /** What must be true before this control may be used. */
  preconditions: string[];
  /** What must become true afterwards, checked before reporting success. */
  postconditions: string[];
  evidenceStatus: EvidenceStatus;
  interfaceVersion: InterfaceVersion;
  /** ISO date of the inspection that produced this, or null if never verified. */
  lastVerified: string | null;
  safety: SafetyClass;
  /**
   * True when the control legitimately appears once per table row. The row is
   * chosen by matching the record it belongs to, never by position.
   */
  perRow?: boolean;
  /** Why a control is blocked or unsupported, in a sentence. */
  notes?: string;
}

/** A screen, identified by its route and by the heading that proves it opened. */
export interface InterfacePage {
  key: string;
  /** Relative to the organization's base URL. */
  route: string | null;
  /** Route with an id in it, e.g. `+Communication/Queue={queue_id}`. */
  routePattern?: string;
  /** The heading that confirms this screen is open. */
  heading: string;
  headingPattern?: string;
  /** Column headings observed on this screen's tables. Never row contents. */
  tables?: Array<{ name: string; headers: string[] }>;
  frames?: Array<{ name: string; purpose: string }>;
  evidenceStatus: EvidenceStatus;
  interfaceVersion: InterfaceVersion;
}

/** An area that was looked at and could not be resolved. Recorded, not hidden. */
export interface BlockedArea {
  area: string;
  reason: string;
}
