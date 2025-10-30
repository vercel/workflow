import type { ZodType, output } from 'zod';
import type { Hook as HookEntity } from '@workflow/world';
import type { Hook, HookOptions } from './create-hook.js';
import { resumeHook } from './runtime/resume-hook.js';

type AnyZodType = ZodType<any, any, any>;
type ResumePayload<
  Schema extends AnyZodType | undefined,
  Payload,
> = Schema extends AnyZodType ? Schema['_input'] : Payload;

/**
 * Provides a typed hook interface with optional runtime validation.
 */
export interface DefinedHook<
  Payload,
  Schema extends AnyZodType | undefined = undefined,
> {
  /** Zod schema associated with the hook payload, if provided. */
  readonly schema: Schema;
  create(options?: HookOptions): Hook<Payload>;
  resume(
    token: string,
    payload: ResumePayload<Schema, Payload>
  ): Promise<HookEntity | null>;
}

/**
 * Defines a typed hook for type-safe hook creation and resumption.
 *
 * This helper provides type safety by allowing you to define the payload type once
 * and reuse it when creating hooks and resuming them.
 * Optionally, provide a Zod schema to enforce runtime validation of hook payloads.
 *
 * @returns An object with `create` and `resume` functions pre-typed with the payload type
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
     * When a schema is provided, the payload is validated before the hook is resumed.
     *
     * @param token - The unique token identifying the hook
     * @param payload - The payload to send (must match the defined type)
     * @returns Promise resolving to the hook entity, or null if the hook doesn't exist
     */
    resume(
      token: string,
      payload: ResumePayload<Schema, Payload>
    ): Promise<HookEntity | null> {
      if (schema) {
        const parsed = schema.parse(payload) as Payload;
        return resumeHook<Payload>(token, parsed);
      }
      return resumeHook<Payload>(token, payload as Payload);
    },
  };
}
