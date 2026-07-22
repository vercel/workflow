import type { StringValue } from 'ms';
import { throwNotInWorkflowContext } from './context-errors.js';
import type { Run } from './runtime/run.js';
import type { Serializable } from './schemas.js';

/**
 * An object that can be awaited to receive a value.
 */
interface Thenable<T> {
  then: Promise<T>['then'];
}

/**
 * A `Request` that can be responded to within a workflow
 * step function by calling the `respondWith()` method.
 */
export interface RequestWithResponse extends Request {
  respondWith: (response: Response) => Promise<void>;
}

/**
 * A hook that can be awaited and/or iterated over to receive
 * a value within a workflow from an external system.
 *
 * Hooks implement the TC39 Explicit Resource Management proposal,
 * allowing them to be used with the `using` keyword for automatic disposal.
 */
export interface Hook<T = any> extends AsyncIterable<T>, Thenable<T> {
  /**
   * The token used to identify this hook.
   */
  token: string;

  /**
   * Returns the {@link Run} already using this token, or `null` when this Hook
   * registers successfully.
   *
   * Calling `createHook()` alone does not register the hook — registration
   * only happens when the workflow suspends. Awaiting `getConflict()`
   * suspends the workflow to commit the hook registration without waiting for
   * payload data.
   *
   * If it returns a run, this Hook was not created. Awaiting the Hook instead
   * rejects with `HookConflictError`.
   *
   * @example
   * ```ts
   * using hook = createHook({ token: `order:${orderId}` });
   * const conflict = await hook.getConflict();
   * if (conflict) {
   *   // another run already owns this token
   *   return { status: 'duplicate', runId: conflict.runId };
   * }
   * // this Hook registered without waiting for payload data
   * ```
   */
  getConflict(): Promise<Run<unknown> | null>;

  /**
   * Disposes the hook, releasing its token for reuse by other workflows.
   *
   * After calling `dispose()`, the hook will no longer receive any events.
   * This is useful when you want to explicitly release a hook token before
   * the workflow completes, allowing another workflow to register a hook
   * with the same token.
   *
   * @example
   * ```ts
   * const hook = createHook<{ message: string }>({ token: 'my-token' });
   *
   * for await (const payload of hook) {
   *   if (payload.message === 'done') {
   *     hook.dispose(); // Release the token early
   *     break;
   *   }
   * }
   * ```
   */
  dispose(): void;

  /**
   * Implements the TC39 Explicit Resource Management proposal.
   * Called automatically when using the `using` keyword.
   *
   * @example
   * ```ts
   * {
   *   using hook = createHook<{ message: string }>({ token: 'my-token' });
   *   const payload = await hook;
   *   // hook is automatically disposed when the block exits
   * }
   * ```
   */
  [Symbol.dispose](): void;
}

/**
 * A webhook that can be used to suspend and resume the workflow run
 * upon receiving an HTTP request to the specified URL.
 *
 * @see {@link createWebhook}
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Request
 */
export interface Webhook<T extends Request> extends Hook<T> {
  /**
   * The URL that external systems can call to send data to the workflow.
   */
  url: string;
}

export interface HookOptions {
  /**
   * Unique token that is used to associate with the hook.
   *
   * When specifying an explicit token, the token should be constructed
   * with information that the dispatching side can reliably reconstruct
   * the token with the information it has available.
   *
   * Deterministic tokens are intended for use with `createHook()` and
   * server-side `resumeHook()` only. For webhooks (`createWebhook()`),
   * tokens are always randomly generated to prevent unauthorized access
   * to the public webhook endpoint.
   *
   * If provided, the token must be a non-empty string; passing an empty
   * string throws. If not provided (or `undefined`), a randomly generated
   * token will be assigned.
   *
   * @example
   *
   * ```ts
   * // Explicit token for a Slack bot (one workflow run per channel)
   * const hook = createHook<SlackMessage>({
   *   token: `slack_webhook:${channelId}`,
   * });
   * ```
   */
  token?: string;

  /**
   * **Experimental.** Keeps this Hook's token unavailable for at least the
   * configured time after `createHook()` runs.
   *
   * Accepts the same values as `sleep()`: a duration string, a number of
   * milliseconds, or an absolute `Date`. Relative durations start when
   * `createHook()` runs, not when the workflow ends.
   *
   * The Hook remains active until the workflow ends, even if the configured
   * time passes first. Another Hook can use the token only after both the run
   * has ended and the configured time has passed.
   * After the run ends, the Hook can still be found with `getHookByToken()`
   * until retention ends, but it cannot be resumed.
   *
   * Calling `dispose()` (including through `using`) releases the token
   * immediately.
   *
   * `createHook()` throws if the configured World does not support this
   * experimental option.
   *
   * @example
   *
   * ```ts
   * const hook = createHook({
   *   token: `order:${orderId}`,
   *   experimental_minRetention: '30d',
   * });
   * ```
   */
  experimental_minRetention?: StringValue | Date | number;

  /**
   * Additional user-defined data to include with the hook payload.
   *
   * @example
   *
   * ```ts
   * const hook = createHook<{ name: string }>({
   *   metadata: {
   *     type: "cat",
   *     color: "orange",
   *   },
   * });
   * ```
   */
  metadata?: Serializable;

  /**
   * Whether this hook can be resumed via the public webhook endpoint.
   *
   * When `true`, the hook can be triggered by sending an HTTP request to the
   * public workflow webhook URL. This is automatically set when using
   * `createWebhook()`.
   *
   * When `false` (the default), the hook can only be resumed server-side
   * via `resumeHook()`.
   *
   * @default false
   */
  isWebhook?: boolean;
}

export interface WebhookOptions
  extends Omit<
    HookOptions,
    'token' | 'isWebhook' | 'experimental_minRetention'
  > {
  /**
   * If set to a `Response` object, the webhook will automatically
   * respond with the specified response.
   *
   * If set to `"manual"`, each individual request will need to
   * be responded to manually from within the workflow by calling the
   * `respondWith()` method.
   *
   * If not set then the webhook will automatically respond with
   * a `202 Accepted` response.
   */
  respondWith?: Response | 'manual';
}

/**
 * Creates a {@link Hook} that can be used to suspend and resume the workflow run with a payload.
 *
 * Hooks allow external systems to send arbitrary serializable data into a workflow.
 *
 * @param options - Configuration options for the hook.
 * @returns A `Hook` that can be awaited to receive one or more payloads.
 *
 * @example
 *
 * ```ts
 * export async function workflowWithHook() {
 *   "use workflow";
 *
 *   const hook = createHook<{ message: string }>();
 *   console.log('Hook token:', hook.token);
 *
 *   const payload = await hook;
 *   console.log('Received:', payload.message);
 * }
 * ```
 */
// @ts-expect-error `options` is here for types/docs
export function createHook<T = any>(options?: HookOptions): Hook<T> {
  throwNotInWorkflowContext(
    'createHook()',
    'https://workflow-sdk.dev/docs/api-reference/workflow/create-hook',
    createHook
  );
}

/**
 * Creates a {@link Webhook} that can be used to suspend and resume the workflow
 * run upon receiving an HTTP request to the specified URL.
 *
 * Webhooks will result in a {@link https://developer.mozilla.org/en-US/docs/Web/API/Request | Request} object
 * that can be interacted with in workflow functions.
 */
export function createWebhook(
  options: WebhookOptions & { respondWith: 'manual' }
): Webhook<RequestWithResponse>;
export function createWebhook(options?: WebhookOptions): Webhook<Request>;
export function createWebhook(
  // @ts-expect-error `options` is here for types/docs
  options?: WebhookOptions
): Webhook<Request> | Webhook<RequestWithResponse> {
  throwNotInWorkflowContext(
    'createWebhook()',
    'https://workflow-sdk.dev/docs/api-reference/workflow/create-webhook',
    createWebhook
  );
}
