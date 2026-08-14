/**
 * Text hygiene helpers shared by validation, logging and Discord rendering.
 *
 * These are written with explicit character-code checks rather than regular
 * expressions containing literal control characters, so the source stays
 * readable and copy-safe.
 */

const DEL = 0x7f;
const SPACE = 0x20;

/** True when the value contains a C0 control character or DEL. */
export function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < SPACE || code === DEL) return true;
  }
  return false;
}

/** Drop control characters, keeping everything printable. */
export function stripControlChars(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= SPACE && code !== DEL) out += value[index];
  }
  return out;
}

/** Zero-width, bidi-override and other invisible code points. */
const INVISIBLE_CODE_POINTS = new Set([
  0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e,
  0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff,
]);

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * Remove invisible characters that could hide content or visually reorder it.
 * Anything read out of Readymode or typed in Discord goes through this before
 * it is shown back to a human.
 */
export function stripInvisible(value: string): string {
  let out = '';
  for (const char of value) {
    if (!INVISIBLE_CODE_POINTS.has(char.codePointAt(0) ?? 0)) out += char;
  }
  return out;
}

/**
 * Collapse a string to a single printable line. Used when text read out of
 * Readymode (agent names, campaign names, error banners) is put into a log
 * line or an embed field, so it cannot forge additional lines.
 */
export function toSingleLine(value: string, maxLength = 300): string {
  const flattened = stripInvisible(stripControlChars(value.replace(/\s+/g, ' '))).trim();
  return flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}...` : flattened;
}

/**
 * Neutralise untrusted text before it is displayed in Discord. Escapes
 * markdown so a crafted agent name cannot render as a link, a heading or a
 * fake bot message, and defuses mass mentions.
 */
export function escapeForDiscord(value: string, maxLength = 300): string {
  return toSingleLine(value, maxLength)
    .replace(/([\\`*_~|>[\]()#-])/g, '\\$1')
    .replace(/@(everyone|here)/gi, `@${ZERO_WIDTH_SPACE}$1`);
}

/** Truncate for embed fields, which Discord caps at 1024 characters. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

/** Case- and whitespace-insensitive form used for account matching. */
export function normalizeForComparison(value: string): string {
  return stripInvisible(stripControlChars(value)).trim().replace(/\s+/g, ' ').toLowerCase();
}
