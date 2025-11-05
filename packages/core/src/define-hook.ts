import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Hook as HookEntity } from '@workflow/world';
import type { Hook, HookOptions } from './create-hook.js';
import { resumeHook } from './runtime/resume-hook.js';

/**
 * Defines a typed hook for type-safe hook creation and resumption.
 *
 * This helper provides type safety by allowing you to define the input and output types
 * for the hook's payload, with optional validation and transformation via a schema.
 *
 * @param schema - Schema used to validate and transform the input payload before resuming
 * @returns An object with `create` and `resume` functions pre-typed with the input and output types
 *
 * @example
 *
 * ```ts
 * // Define a hook with a specific payload type
 * const approvalHook = defineHook<{ approved: boolean; comment: string }>();
 *
 * // In a workflow
 * export async function workflowWithApproval() {
 *   "use workflow";
 *
 *   const hook = approvalHook.create();
 *   const result = await hook; // Fully typed as { approved: boolean; comment: string; }
 * }
 *
 * // In an API route
 * export async function POST(request: Request) {
 *   const { token, approved, comment } = await request.json();
 *   await approvalHook.resume(token, { approved, comment }); // Input type
 *   return Response.json({ success: true });
 * }
 * ```
 */
export function defineHook<TInput, TOutput = TInput>({
  schema,
}: {
  schema?: StandardSchemaV1<TInput, TOutput>;
} = {}) {
  return {
    /**
     * Creates a new hook with the defined output type.
     *
     * Note: This method is not available in runtime bundles. Use it from workflow contexts only.
     *
     * @param _options - Optional hook configuration
     * @returns A Hook that resolves to the defined output type
     */
    create(_options?: HookOptions): Hook<TOutput> {
      throw new Error(
        '`defineHook().create()` can only be called inside a workflow function.'
      );
    },

    /**
     * Resumes a hook by sending a payload with the defined input type.
     * This is a type-safe wrapper around the `resumeHook` runtime function.
     *
     * @param token - The unique token identifying the hook
     * @param payload - The payload to send; if a `schema` is configured it is validated/transformed before resuming
     * @returns Promise resolving to the hook entity, or null if the hook doesn't exist
     */
    async resume(token: string, payload: TInput): Promise<HookEntity | null> {
      if (!schema?.['~standard']) {
        return await resumeHook(token, payload);
      }

      let result = schema['~standard'].validate(payload);
      if (result instanceof Promise) {
        result = await result;
      }

      // if the `issues` field exists, the validation failed
      if (result.issues) {
        throw new Error(JSON.stringify(result.issues, null, 2));
      }

      return await resumeHook<TOutput>(token, result.value);
    },
  };
}
