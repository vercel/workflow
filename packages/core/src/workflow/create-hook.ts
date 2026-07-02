import { createWorkflowUrl } from '@workflow/utils';
import {
  aliasSerializationClass,
  RUN_CLASS_ID,
} from '../class-serialization.js';
import { throwNotInWorkflowContext } from '../context-errors.js';
import type {
  Hook,
  HookOptions,
  RequestWithResponse,
  Webhook,
  WebhookOptions,
} from '../create-hook.js';
import { Run } from '../runtime/run.js';
import { WORKFLOW_CREATE_HOOK } from '../symbols.js';
import { getWorkflowMetadata } from './get-workflow-metadata.js';

// Alias this bundle's `Run` class in the serialization class registry
// under the stable id, so the host-side hook event consumer can construct
// the conflicting run resolved by `hook.getConflict()` via the same
// registry that revives serialized `Run` instances (the SWC plugin
// already auto-registers `Run` here, but under a path-derived id the
// host cannot know statically).
//
// In workflow mode this module is compiled into the workflow bundle and
// executes inside the VM, so `Run` here is the plugin-compiled variant
// whose methods are durable step proxies. No environment guard is
// needed: the registry is keyed per-global, so a stray host-side import
// of this module registers the host's `Run` on the host's registry —
// which is the correct class for that context.
//
// The value import of `Run` also guarantees `runtime/run.js` is included
// in any bundle that uses hooks, so the registry entry exists whenever
// `getConflict()` can resolve.
aliasSerializationClass(RUN_CLASS_ID, Run);

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
  hook.url = createWorkflowUrl(url, { type: 'webhook', token: hook.token });

  return hook;
}
