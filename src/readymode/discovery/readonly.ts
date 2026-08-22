import { sanitizePageValue } from '../../security/sanitize';

/**
 * The read-only guard every click in discovery passes through.
 *
 * `isSafeToClick` already exists and is the looser judgement applied to labels
 * the walk merely encountered. This is narrower and louder: it names the
 * state-changing controls by the verbs they use, and it *throws* rather than
 * returning false, so a click that should never have been attempted cannot be
 * swallowed by a `.catch(() => undefined)` on the call site and go unnoticed.
 *
 * Discovery reads. Nothing here is a policy decision the caller may override.
 */

/** State-changing verbs, as they appear on Readymode's own controls. */
export const ADMINISTRATIVE_LABEL =
  /\b(create|save|update|edit|delete|remove|reset(\s+password)?|clear(\s+licen[cs]e)?|deactivate|activate|disable|enable|suspend|unsuspend|assign|unassign|reassign|release|revoke|grant|add|new|submit|apply|confirm|approve|purge|archive|restore|import|upload|send|dial|start|stop|terminate|log\s?out|logout|sign\s?out)\b/i;

export class AdministrativeActionBlocked extends Error {
  readonly label: string;

  constructor(label: string) {
    super(
      `Discovery refused to click "${label}": it reads as a state-changing control, ` +
        'and discovery never changes anything.',
    );
    this.name = 'AdministrativeActionBlocked';
    this.label = label;
  }
}

/** True when this label reads as an administrative action. */
export function isAdministrativeLabel(label: string): boolean {
  return ADMINISTRATIVE_LABEL.test(sanitizePageValue(label, 80));
}

/**
 * Throws when the label reads as an administrative action.
 *
 * Called immediately before every click discovery makes, including clicks on
 * labels that already passed the exact panel allowlist. Two independent checks
 * on the same click is the point: the allowlist can be extended by someone who
 * has not read this file.
 */
export function assertNotAdministrative(label: string): void {
  if (isAdministrativeLabel(label)) throw new AdministrativeActionBlocked(sanitizePageValue(label, 80));
}
