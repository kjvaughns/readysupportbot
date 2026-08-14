import { scrubSecretValues } from '../security/redact.js';
import { stripControlChars, stripInvisible } from '../util/text.js';

/**
 * Defences applied to a natural-language message before it is sent anywhere.
 *
 * Two separate concerns, both handled here:
 *
 *  - Nothing sensitive reaches OpenAI. Registered secrets are scrubbed, and
 *    anything that looks like someone typing a password into a chat channel is
 *    removed rather than forwarded.
 *  - Nothing in the message can escape its delimiters or read as an
 *    instruction to the model.
 *
 * None of this is the primary defence against prompt injection. The primary
 * defence is structural: the model can only choose among seven actions, its
 * output is re-validated against a schema, permissions are checked afterwards
 * against the database, and a human confirms the exact values before anything
 * runs. This layer just removes the easy attempts.
 */

export const MAX_REQUEST_LENGTH = 1_000;

/** Phrases that are only ever an attempt to talk to the model. */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?|prompts?)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions?|rules?)/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /\bsystem\s*(prompt|message)\s*[:=]/i,
  /\b(new|updated)\s+(instructions?|rules?)\s*[:=]/i,
  /\bact\s+as\s+(if\s+)?(you|an?)\b.*\b(admin|owner|approved)/i,
  /\b(mark|treat|consider)\s+(this|it)\s+as\s+(approved|confirmed|authorized)/i,
  /\bskip\s+(the\s+)?(approval|confirmation|verification|permission)/i,
  /\bno\s+(approval|confirmation)\s+(is\s+)?(needed|required)/i,
  /<\|.*?\|>/,
  /\bassistant\s*[:=]\s*/i,
  /\bdeveloper\s+mode\b/i,
];

/** Text that looks like someone pasting a credential into chat. */
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(password|passwd|pwd|passphrase)\s*(is|:|=)\s*\S+/i,
  /\b(api[-_ ]?key|secret|token|bearer)\s*(is|:|=)\s*\S+/i,
  /\bsession[-_ ]?(id|cookie)\s*(is|:|=)\s*\S+/i,
  /\bcookie\s*:\s*\S+/i,
];

export interface SanitizedRequest {
  /** Safe to send to the model. */
  text: string;
  /** True when the message was rejected outright. */
  blocked: boolean;
  /** Sentence to show the user when blocked. */
  blockReason?: string;
  /** True when credential-looking content was removed before sending. */
  credentialsRemoved: boolean;
  /** True when injection-style phrasing was found. */
  injectionDetected: boolean;
}

/**
 * Clean a message for interpretation.
 *
 * Injection phrasing blocks the message rather than being stripped. Silently
 * removing it and carrying on would mean acting on a request somebody
 * deliberately tampered with, and the person on the other end deserves to be
 * told it was refused.
 */
export function sanitizeRequestText(raw: string): SanitizedRequest {
  const flattened = stripInvisible(stripControlChars(raw)).trim();

  if (flattened.length === 0) {
    return {
      text: '',
      blocked: true,
      blockReason: 'There was nothing in that message for me to work with.',
      credentialsRemoved: false,
      injectionDetected: false,
    };
  }

  if (flattened.length > MAX_REQUEST_LENGTH) {
    return {
      text: '',
      blocked: true,
      blockReason: `That request is longer than I can work with. Keep it under ${MAX_REQUEST_LENGTH} characters, or use a slash command.`,
      credentialsRemoved: false,
      injectionDetected: false,
    };
  }

  const injectionDetected = INJECTION_PATTERNS.some((pattern) => pattern.test(flattened));
  if (injectionDetected) {
    return {
      text: '',
      blocked: true,
      blockReason:
        'That message contains text that looks like it is trying to change how I work, so I did not process it. ' +
        'Rephrase it as a plain request, or use a slash command.',
      credentialsRemoved: false,
      injectionDetected: true,
    };
  }

  // Strip anything credential-shaped, then scrub known secret values. Neither
  // ever leaves this process.
  let text = flattened;
  let credentialsRemoved = false;
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) {
      credentialsRemoved = true;
      text = text.replace(pattern, '[removed]');
    }
  }
  text = scrubSecretValues(text);

  // Neutralise the delimiter used to fence the request in the prompt, so the
  // content cannot close its own block.
  text = text.replaceAll('<<<REQUEST', '<<<').replaceAll('REQUEST>>>', '>>>');

  return { text, blocked: false, credentialsRemoved, injectionDetected: false };
}

/**
 * Applied to text read out of Readymode — agent names, campaign names, status
 * banners. It is displayed to humans and written to the audit log, but it is
 * never sent to the model and never treated as an instruction.
 */
export function sanitizeObservedText(raw: string, maxLength = 200): string {
  // Whitespace is collapsed before control characters are stripped. The other
  // order deletes the newline outright and welds the surrounding words
  // together, which changes the text rather than just flattening it.
  const cleaned = stripInvisible(stripControlChars(raw.replace(/\s+/g, ' '))).trim();
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 3)}...` : cleaned;
}
