import { env } from '../config/env.js';
import { moduleLogger } from '../util/logger.js';
import { LiveReadymodeService } from './live/liveReadymodeService.js';
import { MockReadymodeService } from './mock/mockReadymodeService.js';
import type { ReadymodeService } from './port.js';

/**
 * Choosing the Readymode driver.
 *
 * `live` drives a real browser and is the production default. `mock` uses the
 * in-memory directory and exists for local development and tests, where using
 * the live driver would mean real credentials and real accounts.
 */

const log = moduleLogger('readymode');

export function createReadymodeService(): ReadymodeService {
  const driver = env().READYMODE_DRIVER;

  if (driver === 'mock') {
    log.warn(
      'Using the in-memory Readymode mock. No real Readymode account will be touched. ' +
        'Set READYMODE_DRIVER=live for real work.',
    );
    return new MockReadymodeService();
  }

  return new LiveReadymodeService();
}

export { LiveReadymodeService, MockReadymodeService };
export type { ReadymodeService };
