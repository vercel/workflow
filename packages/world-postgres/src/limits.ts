import { createLimitsNotImplementedError, type Limits } from '@workflow/world';
import type { PostgresWorldConfig } from './config.js';
import type { Drizzle } from './drizzle/index.js';

export function createLimits(
  config: PostgresWorldConfig,
  drizzle: Drizzle
): Limits {
  return {
    async acquire() {
      throw createLimitsNotImplementedError();
    },
    async release() {
      throw createLimitsNotImplementedError();
    },
    async heartbeat() {
      throw createLimitsNotImplementedError();
    },
  };
}
