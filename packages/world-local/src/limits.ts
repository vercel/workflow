import { createLimitsNotImplementedError, type Limits } from '@workflow/world';

export function createLimits(_dataDir: string, _tag?: string): Limits {
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
