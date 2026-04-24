import type { Hook as HookEntity } from '@workflow/world';
import { throwUnavailableInWorkflowContext } from '../context-errors.js';
import type { Hook, HookOptions } from '../create-hook.js';
import { createHook } from './create-hook.js';

/**
 * NOTE: This is the implementation of `defineHook()` that is used in workflow contexts.
 */
export function defineHook<TInput, TOutput = TInput>() {
  function resume(
    _token: string,
    _payload: TInput
  ): Promise<HookEntity | null> {
    // Referenced by name (not `this.resume`) so the stack strip works even
    // if the caller destructured the hook.
    throwUnavailableInWorkflowContext(
      'defineHook().resume()',
      'https://workflow-sdk.dev/docs/api-reference/workflow-api/resume-hook',
      resume
    );
  }

  return {
    create(options?: HookOptions): Hook<TOutput> {
      return createHook<TOutput>(options);
    },
    resume,
  };
}
