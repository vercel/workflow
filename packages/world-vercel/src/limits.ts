import { createLimitsNotImplementedError, type Limits } from '@workflow/world';
import type { APIConfig } from './utils.js';

export function createLimits(config?: APIConfig): Limits {
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
