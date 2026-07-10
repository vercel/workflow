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
   * Returns a promise that resolves with the conflicting {@link Run} if
   * another hook or retained claim already owns this hook's token, or `null`
   * once the hook has been registered and is ready to receive payloads.
   *
   * Calling `createHook()` alone does not register the hook — registration
   * only happens when the workflow suspends. Awaiting `getConflict()`
   * suspends the workflow to commit the hook registration, so it can be
   * used to claim the token (and detect token conflicts early) without
   * waiting for payload data.
   *
   * When a conflict is detected, the resolved `Run` is the run that
   * owns the token. The owner may still be running or may have reached a
   * terminal state while retaining its claim. The workflow can decide how to
   * handle the duplicate in code: return or log `conflict.runId`, inspect
   * `await conflict.status`, await `conflict.returnValue`, or cancel the
   * owner with `await conflict.cancel()` and continue in the current run.
   *
   * Note that awaiting the hook's payload (`await hook`) when the token is
   * already owned by another hook or retained claim still rejects with
   * `HookConflictError`. In the rare case where the conflicting run cannot
   * be identified (a `hook_conflict` event persisted by an old world that
   * did not record the owning run's ID), `getConflict()` also rejects with
   * `HookConflictError` rather than resolving with an incomplete value.
   *
   * @example
   * ```ts
   * using hook = createHook({ token: `order:${orderId}` });
   * const conflict = await hook.getConflict();
   * if (conflict) {
   *   // another run already owns this token
   *   return { dedupedTo: conflict.runId };
   * }
   * // token is now claimed, without waiting for payload data
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

interface HookBaseOptions {
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
}

export type HookOptions = HookBaseOptions &
  (
    | {
        /**
         * **Experimental.** Keeps this hook's token claimed after its workflow
         * run reaches a terminal state, until the configured deadline passes.
         *
         * Accepts the same values as `sleep()`: a duration string, a number of
         * milliseconds, or an absolute `Date`. Relative durations are evaluated
         * when `createHook()` runs and persisted as an absolute deadline.
         *
         * The live hook is not retained and cannot be resumed after the run ends.
         * Only the token claim is retained, so another hook using the same token
         * receives a conflict during the retention window. Calling `dispose()`
         * (including through `using`) always releases the token immediately.
         *
         * World implementations may ignore this experimental option if they do
         * not support retained hook-token claims.
         *
         * @example
         *
         * ```ts
         * const hook = createHook({
         *   token: `order:${orderId}`,
         *   experimental_retention: '30d',
         * });
         * ```
         */
        experimental_retention: StringValue | Date | number;

        /**
         * Whether this hook can be resumed via the public webhook endpoint.
         *
         * The default `false` restricts the hook to server-side `resumeHook()`.
         * `createWebhook()` sets this internal option to `true`.
         *
         * @default false
         */
        isWebhook?: false;
      }
    | { experimental_retention?: never; isWebhook?: boolean }
  );

export interface WebhookOptions extends Omit<HookBaseOptions, 'token'> {
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
