import type { ZodType, output } from 'zod';
import type { Hook as HookEntity } from '@workflow/world';
import type { Hook, HookOptions } from '../create-hook.js';
import type { DefinedHook } from '../define-hook.js';
import { createHook } from './create-hook.js';

type AnyZodType = ZodType<any, any, any>;

/**
 * Defines a hook for workflow execution, optionally validating payloads with a Zod schema.
 *
 * NOTE: This is the implementation of `defineHook()` that is used in workflow contexts.
 */
export function defineHook<T>(): DefinedHook<T, undefined>;
export function defineHook<Schema extends AnyZodType>(
  schema: Schema
): DefinedHook<output<Schema>, Schema>;
export function defineHook<
  Payload,
  Schema extends AnyZodType | undefined = undefined,
>(schema?: Schema): DefinedHook<Payload, Schema> {
  return {
    schema: schema as Schema,
    /**
     * Creates a hook instance scoped to the current workflow execution context.
     */
    create(options?: HookOptions): Hook<Payload> {
      const hookOptions =
        typeof schema === 'undefined'
          ? options
          : ({ ...(options ?? {}), schema } as HookOptions);
      return createHook<Payload>(hookOptions);
    },

    /**
     * Resuming hooks from within a workflow is not supported; use external contexts instead.
     */
    resume(
      _token: string,
      _payload: Schema extends AnyZodType ? Schema['_input'] : Payload
    ): Promise<HookEntity | null> {
      throw new Error(
        '`defineHook().resume()` can only be called from external contexts (e.g. API routes).'
      );
    },
  };
}
