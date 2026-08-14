import pino from 'pino';
import { env } from '../config';
import { redact } from './redaction';

/**
 * Every log line is passed through the redactor before it is serialized, so a
 * password or API key cannot reach stdout even if it is nested inside an
 * arbitrary object.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'readysupport' },
  redact: {
    paths: [
      'password',
      'newPassword',
      'credentials.password',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      '*.password',
      '*.token',
      '*.apiKey',
      '*.secret',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
    log: (object) => redact(object) as Record<string, unknown>,
  },
});

export type Logger = typeof logger;

export function childLogger(bindings: Record<string, unknown>): Logger {
  return logger.child(redact(bindings) as Record<string, unknown>) as Logger;
}
