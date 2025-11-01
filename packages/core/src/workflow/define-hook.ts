import type { Hook as HookEntity } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import { createHook } from './create-hook.js';

/**
 * NOTE: This is the implementation of `defineHook()` that is used in workflow contexts.
 */
export function defineHook<T>() {
  return {
    create(options?: HookOptions): Hook<T> {
      return createHook<T>(options);
    },

    resume(_token: string, _payload: T): Promise<HookEntity | null> {
      throw new Error(
        '`defineHook().resume()` can only be called from external contexts (e.g. API routes).'
      );
    },
  };
}
