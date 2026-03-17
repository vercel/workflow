import { createLimitsNotImplementedError, type Limits } from '@workflow/world';

export function createLimits(dataDir: string, tag?: string): Limits {
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
