import { createLimitsNotImplementedError, type Limits } from '@workflow/world';

export function createLimits(): Limits {
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
