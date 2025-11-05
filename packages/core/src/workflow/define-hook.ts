import type { Hook as HookEntity } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import { createHook } from './create-hook.js';

/**
 * NOTE: This is the implementation of `defineHook()` that is used in workflow contexts.
 */
export function defineHook<TInput, TOutput = TInput>() {
  return {
    create(options?: HookOptions): Hook<TOutput> {
      return createHook<TOutput>(options);
    },

    resume(_token: string, _payload: TInput): Promise<HookEntity | null> {
      throw new Error(
        '`defineHook().resume()` can only be called from external contexts (e.g. API routes).'
      );
    },
  };
}
