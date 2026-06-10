import { waitUntil } from '@vercel/functions';
import {
  ERROR_SLUGS,
  HookNotFoundError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  type Hook,
  isLegacySpecVersion,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  type WorkflowInvokePayload,
  type WorkflowRun,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { getRunCapabilities } from '../capabilities.js';
import { type CryptoKey, importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
  SerializationFormat,
} from '../serialization.js';
import { WEBHOOK_RESPONSE_WRITABLE } from '../symbols.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { getSpanContextForTraceCarrier, trace } from '../telemetry.js';
import { waitedUntil } from '../util.js';
import { getWorldLazy } from './get-world-lazy.js';
import { getWorkflowQueueName, isRetryableEventError } from './helpers.js';

/** ULID generator for client-side resumeId generation */
const ulid = monotonicFactory();

/**
 * Internal helper that returns the hook, the associated workflow run,
 * and the resolved encryption key.
 */
async function getHookByTokenWithKey(token: string): Promise<{
  hook: Hook;
  run: WorkflowRun;
  encryptionKey: CryptoKey | undefined;
}> {
  const world = await getWorldLazy();
  const hook = await world.hooks.getByToken(token);
  const run = await world.runs.get(hook.runId);
  const rawKey = await world.getEncryptionKeyForRun?.(run);
  const encryptionKey = rawKey ? await importKey(rawKey) : undefined;
  if (typeof hook.metadata !== 'undefined') {
    hook.metadata = await hydrateStepArguments(
      hook.metadata as any,
      hook.runId,
      encryptionKey
    );
  }
  return { hook, run, encryptionKey };
}

/**
 * Get the hook by token to find the associated workflow run,
 * and hydrate the `metadata` property if it was set from within
 * the workflow run.
 *
 * @param token - The unique token identifying the hook
 */
export async function getHookByToken(token: string): Promise<Hook> {
  const { hook } = await getHookByTokenWithKey(token);
  return hook;
}

/**
 * A hook returned by {@link resumeHook}. Extends the base {@link Hook} entity
 * with a transient flag indicating whether the resume took the resilient
 * fallback path.
 */
export type ResumedHook = Hook & {
  /**
   * When `true`, the direct `hook_received` event write failed with a
   * transient error (429/5xx) but the queue dispatch succeeded. The resume
   * will still land via the workflow runtime's queue-payload fallback path
   * (the runtime materializes the missing `hook_received` event from
   * `hookInput` on the queue message). Callers can treat this as "accepted,
   * will deliver eventually" — the same way `start()` returns a `Run` with
   * `resilientStart` set when `run_created` failed.
   *
   * When `false` or absent, both the direct event write and the queue
   * dispatch succeeded normally.
   */
  resilientResume?: boolean;
};

/**
 * Resumes a workflow run by sending a payload to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * ## Resilient resume
 *
 * `resumeHook()` writes the `hook_received` event first, then dispatches to
 * the workflow queue. If the event write fails with a retryable error
 * (429/5xx), it is skipped and the queue dispatch carries `hookInput` with
 * the dehydrated payload + a client-minted `resumeId`. The workflow runtime
 * then materializes the missing `hook_received` event from `hookInput`
 * during replay — the returned hook has `resilientResume: true` to signal
 * this fallback path was taken. This mirrors the resilient-start behavior
 * of {@link start}.
 *
 * The write order (event first, then queue) is deliberately sequential to
 * avoid a race where the queue handler processes the message and
 * materializes a duplicate `hook_received` before the direct write commits.
 * The `resumeId` doubles as an idempotency key the runtime uses to dedup
 * any `hook_received` event that already carries it.
 *
 * @param tokenOrHook - The unique token identifying the hook, or the hook object itself
 * @param payload - The data payload to send to the hook
 * @returns Promise resolving to the hook, with `resilientResume: true` when
 *   the resilient fallback path was taken.
 * @throws Error if the hook is not found, if the queue dispatch fails, or if
 *   there's a non-retryable error during event creation.
 *
 * @example
 *
 * ```ts
 * // In an API route
 * import { resumeHook } from '@workflow/core/runtime';
 *
 * export async function POST(request: Request) {
 *   const { token, data } = await request.json();
 *
 *   try {
 *     const hook = await resumeHook(token, data);
 *     return Response.json({ runId: hook.runId });
 *   } catch (error) {
 *     return new Response('Hook not found', { status: 404 });
 *   }
 * }
 * ```
 */
export async function resumeHook<T = any>(
  tokenOrHook: string | Hook,
  payload: T,
  encryptionKeyOverride?: CryptoKey
): Promise<ResumedHook> {
  return await waitedUntil(() => {
    return trace('hook.resume', async (span) => {
      const world = await getWorldLazy();

      try {
        let hook: Hook;
        let workflowRun: WorkflowRun;
        let encryptionKey: CryptoKey | undefined;
        if (typeof tokenOrHook === 'string') {
          const result = await getHookByTokenWithKey(tokenOrHook);
          hook = result.hook;
          workflowRun = result.run;
          encryptionKey = encryptionKeyOverride ?? result.encryptionKey;
        } else {
          hook = tokenOrHook;
          workflowRun = await world.runs.get(hook.runId);
          if (encryptionKeyOverride) {
            encryptionKey = encryptionKeyOverride;
          } else {
            const rawKey = await world.getEncryptionKeyForRun?.(workflowRun);
            encryptionKey = rawKey ? await importKey(rawKey) : undefined;
          }
        }

        span?.setAttributes({
          ...Attribute.HookToken(hook.token),
          ...Attribute.HookId(hook.hookId),
          ...Attribute.WorkflowRunId(hook.runId),
        });

        // Check the target run's capabilities to ensure we encode the
        // payload in a format the run's deployment can decode. For example,
        // runs created before encryption support was added cannot decode
        // the 'encr' serialization format.
        const rawVersion = workflowRun.executionContext?.workflowCoreVersion;
        const { supportedFormats } = getRunCapabilities(
          typeof rawVersion === 'string' ? rawVersion : undefined
        );
        if (!supportedFormats.has(SerializationFormat.ENCRYPTED)) {
          encryptionKey = undefined;
        }

        // Dehydrate the payload for storage
        const ops: Promise<any>[] = [];
        const v1Compat = isLegacySpecVersion(hook.specVersion);
        const dehydratedPayload = await dehydrateStepReturnValue(
          payload,
          hook.runId,
          encryptionKey,
          ops,
          globalThis,
          v1Compat
        );
        // NOTE: Workaround instead of injecting catching undefined unhandled rejections in webhook bundle
        waitUntil(
          Promise.all(ops).catch((err) => {
            if (err !== undefined) throw err;
          })
        );

        span?.setAttributes({
          ...Attribute.WorkflowName(workflowRun.workflowName),
        });

        const traceCarrier = workflowRun.executionContext?.traceCarrier;

        if (traceCarrier) {
          const context = await getSpanContextForTraceCarrier(traceCarrier);
          if (context) {
            span?.addLink?.({ context });
          }
        }

        // Mint a client-side idempotency key. When the resilient path fires
        // (events.create fails but queue succeeds), both the direct write
        // and the runtime's queue-payload fallback use this key so the
        // runtime can dedup any hook_received event that already carries it.
        const resumeId = ulid();

        // Only carry `hookInput` on the queue payload for runs whose
        // deployment supports the CBOR queue transport. Older deployments
        // use JSON-only transport which cannot carry binary payloads
        // (Uint8Array). For such deployments, fall back to today's behavior
        // where the runtime cannot materialize hook_received from the queue.
        const runSpecVersion = workflowRun.specVersion ?? SPEC_VERSION_LEGACY;
        const canCarryHookInput =
          runSpecVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;

        // First, attempt the direct hook_received event write. This is
        // sequential (not parallel with queue dispatch) to avoid a race
        // where the queue handler processes the message before the event
        // write has committed, which would otherwise cause the runtime
        // fallback to materialize a duplicate hook_received event.
        //
        // - If the write succeeds, we queue WITHOUT `hookInput` — the
        //   runtime has nothing to materialize and will just replay the run.
        // - If the write fails with a retryable error (429/5xx) on a
        //   CBOR-capable deployment, we queue WITH `hookInput` so the
        //   runtime can materialize the missing event (resilient resume).
        // - If the write fails with any other error, we propagate.
        let eventWriteFailed = false;
        let eventWriteError: unknown;
        try {
          await world.events.create(
            hook.runId,
            {
              eventType: 'hook_received',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: hook.hookId,
              eventData: {
                ...(v1Compat ? {} : { token: hook.token }),
                payload: dehydratedPayload,
                // Include the idempotency key so the runtime's fallback
                // path can dedup on re-delivery of the queue message.
                ...(canCarryHookInput ? { resumeId } : {}),
              },
            },
            { v1Compat }
          );
        } catch (err) {
          if (!canCarryHookInput || !isRetryableEventError(err)) {
            // Non-retryable, or legacy spec version (no fallback available).
            throw err;
          }
          eventWriteFailed = true;
          eventWriteError = err;
        }

        // Re-trigger the workflow. Attach `hookInput` only when the direct
        // event write failed — otherwise the runtime's fallback path has
        // nothing to materialize and we avoid the dedup race.
        await world.queue(
          getWorkflowQueueName(workflowRun.workflowName),
          {
            runId: hook.runId,
            // attach the trace carrier from the workflow run
            traceCarrier:
              workflowRun.executionContext?.traceCarrier ?? undefined,
            ...(eventWriteFailed && canCarryHookInput
              ? {
                  hookInput: {
                    hookId: hook.hookId,
                    resumeId,
                    payload: dehydratedPayload,
                  },
                }
              : {}),
          } satisfies WorkflowInvokePayload,
          {
            deploymentId: workflowRun.deploymentId,
            specVersion: runSpecVersion,
          }
        );

        if (eventWriteFailed) {
          runtimeLogger.warn(
            'hook_received event could not immediately be created, re-trying via queue.',
            {
              workflowRunId: hook.runId,
              hookId: hook.hookId,
              resumeId,
              error:
                eventWriteError instanceof Error
                  ? eventWriteError.message
                  : String(eventWriteError),
            }
          );
        }

        span?.setAttributes({
          ...Attribute.HookResilientResume(eventWriteFailed),
        });

        if (eventWriteFailed) {
          return { ...hook, resilientResume: true } satisfies ResumedHook;
        }
        return hook satisfies ResumedHook;
      } catch (err) {
        span?.setAttributes({
          ...Attribute.HookToken(
            typeof tokenOrHook === 'string' ? tokenOrHook : tokenOrHook.token
          ),
          ...Attribute.HookFound(false),
        });
        throw err;
      }
    });
  });
}

/**
 * Resumes a webhook by sending a {@link https://developer.mozilla.org/en-US/docs/Web/API/Request | Request}
 * object to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send a request to a webhook and resume the associated workflow run.
 *
 * @param token - The unique token identifying the hook
 * @param request - The request to send to the hook
 * @returns Promise resolving to the response
 * @throws Error if the hook is not found or if there's an error during the process
 *
 * @example
 *
 * ```ts
 * // In an API route
 * import { resumeWebhook } from '@workflow/core/runtime';
 *
 * export async function POST(request: Request) {
 *   const url = new URL(request.url);
 *   const token = url.searchParams.get('token');
 *
 *   if (!token) {
 *     return new Response('Missing token', { status: 400 });
 *   }
 *
 *   try {
 *     const response = await resumeWebhook(token, request);
 *     return response;
 *   } catch (error) {
 *     return new Response('Webhook not found', { status: 404 });
 *   }
 * }
 * ```
 */
export async function resumeWebhook(
  token: string,
  request: Request
): Promise<Response> {
  const { hook, encryptionKey } = await getHookByTokenWithKey(token);

  // Only webhooks can be resumed via the public endpoint.
  // If the hook was created via createHook() (isWebhook !== true),
  // throw the same "not found" error the world would throw for a missing
  // token. This prevents leaking that the token is valid.
  if (hook.isWebhook === false) {
    throw new HookNotFoundError(token);
  }

  let response: Response | undefined;
  let responseReadable: ReadableStream<Response> | undefined;
  if (
    hook.metadata &&
    typeof hook.metadata === 'object' &&
    'respondWith' in hook.metadata
  ) {
    if (hook.metadata.respondWith === 'manual') {
      const { readable, writable } = new TransformStream<Response, Response>();
      responseReadable = readable;

      // The request instance includes the writable stream which will be used
      // to write the response to the client from within the workflow run
      (request as any)[WEBHOOK_RESPONSE_WRITABLE] = writable;
    } else if (hook.metadata.respondWith instanceof Response) {
      response = hook.metadata.respondWith;
    } else {
      throw new WorkflowRuntimeError(
        `Invalid \`respondWith\` value: ${hook.metadata.respondWith}`,
        { slug: ERROR_SLUGS.WEBHOOK_INVALID_RESPOND_WITH_VALUE }
      );
    }
  } else {
    // No `respondWith` value implies the default behavior of returning a 202
    response = new Response(null, { status: 202 });
  }

  await resumeHook(hook, request, encryptionKey);

  if (responseReadable) {
    // Wait for the readable stream to emit one chunk,
    // which is the `Response` object
    const reader = responseReadable.getReader();
    const chunk = await reader.read();
    if (chunk.value) {
      response = chunk.value;
    }
    reader.cancel();
  }

  if (!response) {
    throw new WorkflowRuntimeError('Workflow run did not send a response', {
      slug: ERROR_SLUGS.WEBHOOK_RESPONSE_NOT_SENT,
    });
  }

  return response;
}
