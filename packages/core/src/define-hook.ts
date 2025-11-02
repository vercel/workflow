import type { Hook as HookEntity } from '@workflow/world';
import type { ZodType } from 'zod';
import type { Hook, HookOptions } from './create-hook.js';
import { resumeHook } from './runtime/resume-hook.js';

/**
 * Defines a typed hook for type-safe hook creation and resumption.
 *
 * This helper provides type safety by allowing you to define the payload type once
 * and reuse it when creating hooks and resuming them.
 *
 * @param options - Optional configuration for the hook definition
 * @param options.schema - Schema used to validate and transform the payload before resuming
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
 *   const result = await hook; // Fully typed as { approved: boolean; comment: string }
 * }
 *
 * // In an API route
 * export async function POST(request: Request) {
 *   const { token, approved, comment } = await request.json();
 *   await approvalHook.resume(token, { approved, comment });
 *   return Response.json({ success: true });
 * }
 * ```
 */
export function defineHook<T>({ schema }: { schema?: ZodType<T> } = {}) {
  return {
    /**
     * Creates a new hook with the defined payload type.
     *
     * Note: This method is not available in runtime bundles. Use it from workflow contexts only.
     *
     * @param _options - Optional hook configuration
     * @returns A Hook that resolves to the defined payload type
     */
    // @ts-expect-error `options` is here for types/docs
    create(options?: HookOptions): Hook<T> {
      throw new Error(
        '`defineHook().create()` can only be called inside a workflow function.'
      );
    },

    /**
     * Resumes a hook by sending a payload with the defined type.
     * This is a type-safe wrapper around the `resumeHook` runtime function.
     *
     * @param token - The unique token identifying the hook
     * @param payload - The payload to send; if a `schema` is configured it is validated/transformed before resuming
     * @returns Promise resolving to the hook entity, or null if the hook doesn't exist
     */
    resume(token: string, payload: T): Promise<HookEntity | null> {
      return resumeHook<T>(token, schema ? schema.parse(payload) : payload);
    },
  };
}
