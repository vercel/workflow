import { throwNotInWorkflowContext } from '../context-errors.js';
import type {
  Hook,
  HookOptions,
  RequestWithResponse,
  Webhook,
  WebhookOptions,
} from '../create-hook.js';
import { Run } from '../runtime/run.js';
import { WORKFLOW_CREATE_HOOK, WORKFLOW_RUN_CLASS } from '../symbols.js';
import { getWorkflowMetadata } from './get-workflow-metadata.js';

// Expose this bundle's `Run` class to the host-side hook event consumer.
// In workflow mode this module is compiled into the workflow bundle and
// executes inside the VM, so `Run` here is the plugin-compiled variant
// whose methods are durable step proxies. The host-side consumer uses it
// to construct the conflicting run resolved by `hook.getConflict()`.
//
// Guarded on the workflow runtime being present (the VM installs
// WORKFLOW_CREATE_HOOK on its globalThis before evaluating the bundle):
// outside the VM this module can still be imported — where `createHook()`
// just throws — and registering the host-side `Run` there would both
// mutate the host global and expose a class whose methods are NOT step
// proxies.
if ((globalThis as any)[WORKFLOW_CREATE_HOOK]) {
  (globalThis as any)[WORKFLOW_RUN_CLASS] ??= Run;
}

export function createHook<T = any>(options?: HookOptions): Hook<T> {
  // Inside the workflow VM, the hook function is stored in the globalThis object behind a symbol
  const createHookFn = (globalThis as any)[
    WORKFLOW_CREATE_HOOK
  ] as typeof createHook<T>;
  if (!createHookFn) {
    throwNotInWorkflowContext(
      'createHook()',
      'https://workflow-sdk.dev/docs/api-reference/workflow/create-hook',
      createHook
    );
  }
  return createHookFn(options);
}

export function createWebhook(
  options: WebhookOptions & { respondWith: 'manual' }
): Webhook<RequestWithResponse>;
export function createWebhook(options?: WebhookOptions): Webhook<Request>;
export function createWebhook(
  options?: WebhookOptions
): Webhook<Request> | Webhook<RequestWithResponse> {
  const { respondWith, token, ...rest } = (options ?? {}) as WebhookOptions & {
    token?: string;
  };

  if (token !== undefined) {
    throw new Error(
      '`createWebhook()` does not accept a `token` option. Webhook tokens are always randomly generated. Use `createHook()` with `resumeHook()` for deterministic token patterns.'
    );
  }

  let metadata: Pick<WebhookOptions, 'respondWith'> | undefined;
  if (typeof respondWith !== 'undefined') {
    metadata = { respondWith };
  }

  const hook = createHook({ ...rest, metadata, isWebhook: true }) as
    | Webhook<Request>
    | Webhook<RequestWithResponse>;

  const { url } = getWorkflowMetadata();
  hook.url = `${url}/.well-known/workflow/v1/webhook/${encodeURIComponent(hook.token)}`;

  return hook;
}
