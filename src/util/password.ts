import { randomInt } from 'node:crypto';
import { registerSecret } from '../security/redact.js';

/**
 * Temporary password generation.
 *
 * Generated values are registered with the redaction layer the moment they
 * exist, so even an accidental log call cannot print one. They are held in
 * memory only, delivered through an ephemeral Discord reply, and then dropped.
 */

// Ambiguous characters are left out so a password can be read aloud or copied
// from a screen without confusion between O/0 and l/1/I.
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';
const ALL = LOWER + UPPER + DIGITS + SYMBOLS;

export const DEFAULT_PASSWORD_LENGTH = 16;
export const MIN_PASSWORD_LENGTH = 12;

function pick(alphabet: string): string {
  return alphabet[randomInt(alphabet.length)] as string;
}

/** Fisher-Yates using a CSPRNG. */
function shuffle(characters: string[]): string[] {
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapWith = randomInt(index + 1);
    const temporary = characters[index] as string;
    characters[index] = characters[swapWith] as string;
    characters[swapWith] = temporary;
  }
  return characters;
}

/**
 * A cryptographically random password guaranteed to contain at least one
 * character from each class.
 */
export function generateTemporaryPassword(length = DEFAULT_PASSWORD_LENGTH): string {
  const size = Math.max(MIN_PASSWORD_LENGTH, length);
  const characters = [pick(LOWER), pick(UPPER), pick(DIGITS), pick(SYMBOLS)];
  while (characters.length < size) characters.push(pick(ALL));

  const password = shuffle(characters).join('');
  registerSecret(password);
  return password;
}

export interface PasswordStrengthResult {
  ok: boolean;
  problems: string[];
}

/**
 * Validate a password an administrator supplied by hand. Deliberately modest:
 * Readymode enforces its own policy, and this only catches obviously weak
 * values before we spend a browser session on them.
 */
export function checkPasswordStrength(password: string): PasswordStrengthResult {
  const problems: string[] = [];

  if (password.length < MIN_PASSWORD_LENGTH) {
    problems.push(`must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('must contain an uppercase letter');
  if (!/[0-9]/.test(password)) problems.push('must contain a digit');
  if (/^\s|\s$/.test(password)) problems.push('must not start or end with a space');

  return { ok: problems.length === 0, problems };
}
