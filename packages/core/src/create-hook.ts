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
 */
export interface Hook<T = any> extends AsyncIterable<T>, Thenable<T> {
  /**
   * The token used to identify this hook.
   */
  token: string;
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
   * If not provided, a randomly generated token will be assigned.
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

export interface WebhookOptions extends HookOptions {
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
  throw new Error(
    '`createHook()` can only be called inside a workflow function'
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
  throw new Error(
    '`createWebhook()` can only be called inside a workflow function'
  );
}
