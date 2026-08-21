/**
 * Prompt-injection defence.
 *
 * Discord messages and Readymode page content are untrusted. Account names,
 * campaign names, custom fields and web page text can all contain text that
 * looks like an instruction. Nothing read from those sources is ever treated as
 * a directive: it is neutralized here before it reaches the model, and the
 * model's output is separately validated against a closed action schema.
 */

// Matching control characters is the point: they are what hides injected text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const INVISIBLE_CHARS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const INJECTION_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  {
    pattern: /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+instructions?/gi,
    label: 'override-instructions',
  },
  {
    pattern: /disregard\s+(?:all\s+|any\s+)?(?:previous|prior|above|earlier)\s+\w+/gi,
    label: 'override-instructions',
  },
  {
    pattern: /forget\s+(?:everything|all\s+previous|your\s+instructions)/gi,
    label: 'override-instructions',
  },
  { pattern: /you\s+are\s+now\s+(?:a|an|the)\s+\w+/gi, label: 'role-reassignment' },
  { pattern: /\b(?:system|developer)\s*(?:prompt|message|role)\s*[:=]/gi, label: 'role-injection' },
  { pattern: /<\/?(?:system|assistant|user|tool|function)>/gi, label: 'role-tag' },
  { pattern: /\bBEGIN\s+(?:SYSTEM|ADMIN)\b/gi, label: 'role-tag' },
  { pattern: /\bnew\s+instructions?\s*[:=]/gi, label: 'override-instructions' },
  {
    pattern:
      /\b(?:reveal|print|show|output|repeat)\s+(?:your\s+)?(?:system\s+prompt|instructions|api\s+key|token|password|secret)/gi,
    label: 'exfiltration',
  },
  {
    pattern: /\bdo\s+not\s+(?:ask|require|request)\s+(?:for\s+)?(?:confirmation|approval)/gi,
    label: 'approval-bypass',
  },
  {
    pattern:
      /\b(?:skip|bypass|disable)\s+(?:the\s+)?(?:confirmation|approval|permission|verification)/gi,
    label: 'approval-bypass',
  },
  { pattern: /\bwithout\s+(?:asking|approval|confirmation)\b/gi, label: 'approval-bypass' },
];

export interface SanitizedText {
  /** Text safe to embed in a model prompt. */
  text: string;
  /** Labels of the injection attempts that were neutralized. */
  flags: string[];
  /** True when the input was altered. */
  modified: boolean;
}

const MAX_LENGTH = 4000;

/**
 * Neutralizes instruction-like content and control characters. The text stays
 * readable so the model can still extract the user's actual intent.
 */
export function sanitizeUntrustedText(input: string, maxLength = MAX_LENGTH): SanitizedText {
  const flags = new Set<string>();
  const original = String(input ?? '');
  let text = original;

  if (text.length > maxLength) {
    text = `${text.slice(0, maxLength)}...`;
    flags.add('truncated');
  }

  // Control characters and zero-width / bidi characters are used to smuggle
  // hidden instructions past a human reader.
  text = text.replace(CONTROL_CHARS, ' ').replace(INVISIBLE_CHARS, '');

  // Fenced blocks and HTML comments are common carriers for injected text.
  text = text.replace(/`{3,}/g, "'''");
  text = text.replace(/<!--/g, '(').replace(/-->/g, ')');

  for (const { pattern, label } of INJECTION_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      flags.add(label);
      pattern.lastIndex = 0;
      text = text.replace(pattern, '[removed]');
    }
    pattern.lastIndex = 0;
  }

  text = text.replace(/[ \t]{3,}/g, '  ').trim();

  return { text, flags: [...flags], modified: text !== original };
}

/**
 * Wraps untrusted content in an explicit, clearly labelled boundary for the
 * model. Delimiters present in the content are removed so the boundary cannot
 * be closed early.
 */
export function wrapUntrusted(label: string, content: string): string {
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '') || 'untrusted';
  const body = sanitizeUntrustedText(content).text.replace(
    new RegExp(`</?${safeLabel}>`, 'gi'),
    '',
  );
  return `<${safeLabel}>\n${body}\n</${safeLabel}>`;
}

/**
 * Text read from Readymode pages (agent names, campaign names, custom fields).
 * Used for display and matching only — never as an instruction.
 */
export function sanitizePageValue(value: string, maxLength = 200): string {
  return String(value ?? '')
    .replace(CONTROL_CHARS, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Neutralizes mentions without touching formatting.
 *
 * For text ReadySupport composed itself out of documentation: the markdown is
 * deliberate — headings, numbered steps, links — and escaping it would turn a
 * readable answer into a wall of backslashes. Mentions still cannot survive,
 * because an article that happened to contain "@everyone" must never ping a
 * server.
 */
export function neutralizeMentions(value: string): string {
  return String(value ?? '')
    .replace(/@(everyone|here)/gi, '@\u200B$1')
    .replace(/<@[!&]?\d+>/g, '@user');
}

/** Neutralizes Discord mentions and markdown so bot replies cannot be weaponized. */
export function escapeDiscord(value: string): string {
  return String(value ?? '')
    .replace(/@(everyone|here)/gi, '@\u200B$1')
    .replace(/<@[!&]?\d+>/g, '@user')
    .replace(/([*_~`|\\])/g, '\\$1')
    .slice(0, 1800);
}
