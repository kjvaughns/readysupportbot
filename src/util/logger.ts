import pino, { type Logger } from 'pino';
import { env } from '../config/env.js';
import { sanitize, scrubSecretValues } from '../security/redact.js';

/**
 * Structured logging.
 *
 * Everything passes through the redaction layer on the way out. A caller that
 * forgets to strip a password still cannot leak one into the log stream.
 */

let root: Logger | undefined;

function build(): Logger {
  const config = env();
  const pretty = config.NODE_ENV === 'development';

  return pino({
    level: config.LOG_LEVEL,
    base: { service: 'readysupport' },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        const rewritten = args.map((arg) =>
          typeof arg === 'string' ? scrubSecretValues(arg) : sanitize(arg),
        );
        method.apply(this, rewritten as Parameters<typeof method>);
      },
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
}

export function logger(): Logger {
  root ??= build();
  return root;
}

/** A child logger tagged with a module name, e.g. `queue` or `readymode`. */
export function moduleLogger(name: string): Logger {
  return logger().child({ module: name });
}

/** Test helper — swap in a logger that captures instead of printing. */
export function setLogger(replacement: Logger): void {
  root = replacement;
}
