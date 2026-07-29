import {
  EntityConflictError,
  ERROR_SLUGS,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  type Hook,
  type HookResumeContext,
  isLegacySpecVersion,
  isTerminalWorkflowRunStatus,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowInvokePayload,
  type WorkflowRun,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { getRunCapabilities } from '../capabilities.js';
import { isRetryableWorldError } from '../classify-error.js';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import { decodeRunPublicKey } from '../sealed-box.js';
import { deriveRunPayloadKeys } from '../serialization/encryption.js';
import {
  dehydrateStepReturnValue,
  hydrateStepArguments,
  type PayloadKey,
  SerializationFormat,
  sealTo,
} from '../serialization.js';
import { WEBHOOK_RESPONSE_WRITABLE } from '../symbols.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { linkToTraceCarrier, trace } from '../telemetry.js';
import { getWorldLazy } from './get-world-lazy.js';
import { getWorkflowQueueName } from './helpers.js';
import { safeWaitUntil, waitedUntil } from './wait-until.js';

/** ULID generator for client-side resumeId generation */
const ulid = monotonicFactory();

/**
 * The resume context for a hook plus where it came from. `run` is present only
 * on the fallback path (pre-`resumeContext` hooks), where it also carries the
 * run's mutable status for the terminal-run check. Key resolution is kept
 * separate so callers can gate it behind that check.
 */
interface HookResumeInfo {
  resumeContext: HookResumeContext;
  source: 'hook' | 'run_fallback';
  run?: WorkflowRun;
}

/** Derive a resume context from a full run (fallback for pre-`resumeContext` hooks). */
function resumeContextFromRun(run: WorkflowRun): HookResumeContext {
  const coreVersion = run.executionContext?.workflowCoreVersion;
  const traceCarrier = run.executionContext?.traceCarrier;
  return {
    deploymentId: run.deploymentId,
    workflowName: run.workflowName,
    runSpecVersion: run.specVersion,
    workflowCoreVersion:
      typeof coreVersion === 'string' ? coreVersion : undefined,
    traceCarrier:
      traceCarrier && typeof traceCarrier === 'object'
        ? (traceCarrier as HookResumeContext['traceCarrier'])
        : undefined,
    encryptionPublicKey: run.encryptionPublicKey,
  };
}

/**
 * Resolve resume context for a hook. Uses the stored `resumeContext` when
 * present (fast path — no run read); otherwise fetches the run and synthesizes
 * it. Does NOT resolve the encryption key — callers do that separately. Only
 * the fallback path can gate key work behind a local terminal-run check (it
 * has the fetched run); the fast path's stored context carries no status, so
 * seal/serialization work may run before the receiving side rejects
 * `hook_received` for an ended run.
 */
async function resolveHookResumeInfo(hook: Hook): Promise<HookResumeInfo> {
  if (hook.resumeContext) {
    return { resumeContext: hook.resumeContext, source: 'hook' };
  }
  const run = await (await getWorldLazy()).runs.get(hook.runId);
  return {
    resumeContext: resumeContextFromRun(run),
    source: 'run_fallback',
    run,
  };
}

/**
 * Resolve the run's symmetric key for a payload WRITE, as a bare `CryptoKey`
 * (`importKey`) — the `encr` write fallback used when the run published no
 * public key to seal to. Writing needs only the AES key, not the read-side
 * keypair. On the fast path this needs only `runId` + `deploymentId` (no run
 * entity); on the fallback path the already fetched run is reused.
 */
async function resolveHookEncryptionKey(
  hook: Hook,
  info: HookResumeInfo
): Promise<Awaited<ReturnType<typeof importKey>> | undefined> {
  const world = await getWorldLazy();
  const rawKey = info.run
    ? await world.getEncryptionKeyForRun?.(info.run)
    : await world.getEncryptionKeyForRun?.(hook.runId, {
        deploymentId: info.resumeContext.deploymentId,
      });
  return rawKey ? await importKey(rawKey) : undefined;
}

async function getHookByTokenWithKey(token: string): Promise<{
  hook: Hook;
  encryptionKey: PayloadKey | undefined;
}> {
  const world = await getWorldLazy();
  const hook = await world.hooks.getByToken(token);

  // Only a hook that actually carries metadata needs the run's key resolved
  // here: hydrating that metadata is a READ, so derive the full RunPayloadKeys
  // (which opens sealed `encp` metadata, not just symmetric `encr`). The common
  // default webhook — createWebhook() with no `respondWith` — stores no
  // metadata, so it skips this entirely: no ~350ms `run-key` API round trip,
  // and, crucially, no resolved key handed to `resumeHook`, leaving it free to
  // seal the payload to the run's published public key instead. Metadata-
  // bearing webhooks still legitimately pay one lookup to hydrate.
  let encryptionKey: PayloadKey | undefined;
  if (typeof hook.metadata !== 'undefined') {
    const info = await resolveHookResumeInfo(hook);
    // On the fast path this resolves the key by runId + deploymentId (no run
    // read); on the fallback path it reuses the already-fetched run.
    const rawKey = info.run
      ? await world.getEncryptionKeyForRun?.(info.run)
      : await world.getEncryptionKeyForRun?.(hook.runId, {
          deploymentId: info.resumeContext.deploymentId,
        });
    encryptionKey = rawKey ? await deriveRunPayloadKeys(rawKey) : undefined;
    hook.metadata = await hydrateStepArguments(
      hook.metadata as any,
      hook.runId,
      encryptionKey
    );
  }
  return { hook, encryptionKey };
}

/**
 * Get the hook by token to find the associated workflow run,
 * and hydrate the `metadata` property if it was set from within
 * the workflow run.
 *
 * A Hook kept by minimum retention remains available here after its run ends,
 * but cannot be resumed.
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
 * @throws {HookNotFoundError} If the Hook does not exist or its run has ended
 * @throws Error if the queue dispatch fails, or if there's a non-retryable
 *   error during event creation.
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
  encryptionKeyOverride?: PayloadKey
): Promise<ResumedHook> {
  return await waitedUntil(() => {
    return trace('hook.resume', async (span) => {
      const world = await getWorldLazy();

      try {
        const hook: Hook =
          typeof tokenOrHook === 'string'
            ? await world.hooks.getByToken(tokenOrHook)
            : tokenOrHook;

        const info = await resolveHookResumeInfo(hook);
        const { resumeContext } = info;

        span?.setAttributes({
          ...Attribute.HookToken(hook.token),
          ...Attribute.HookId(hook.hookId),
          ...Attribute.WorkflowRunId(hook.runId),
          'workflow.hook.resume_context_source': info.source,
        });

        // The stored `resumeContext` intentionally omits the run's mutable
        // status, so this early client-side rejection only runs on the
        // fallback path (which fetched the run). On the fast path the terminal
        // check happens server-side: `hook_received` against an ended run is
        // rejected, which the catch around `world.events.create` below re-keys
        // to HookNotFoundError — same public contract, no run pre-fetch.
        if (info.run && isTerminalWorkflowRunStatus(info.run.status)) {
          throw new HookNotFoundError(hook.token);
        }

        // Check the target run's capabilities to ensure we encode the
        // payload in a format the run's deployment can decode. For example,
        // runs created before encryption support was added cannot decode
        // the 'encr' serialization format, and runs created before
        // byte-stream framing support cannot decode framed byte streams.
        const capabilities = getRunCapabilities(
          resumeContext.workflowCoreVersion
        );

        // Resolve how to encrypt the payload for the target run (a WRITE).
        //
        // Preferred path: seal to the run's published X25519 public key, which
        // the stored `resumeContext` carries inline. On the fast path this is
        // the whole win — no run read AND no `getEncryptionKeyForRun`, whose
        // ~350ms `run-key` API round trip dominates cross-deployment hook
        // resumption latency. (On the fallback path the key is synthesized
        // from the fetched run, which also carries it.)
        //
        // Sealing also drops privilege: the resumer ends up able to write a
        // payload for the run without being able to read anything of the
        // run's, where fetching the symmetric key grants both.
        //
        // Deliberately NOT gated on `capabilities.supportedFormats` the way
        // the symmetric fallback below gates `encr`: presence of the public key
        // is itself the gate. A run only carries one if the runtime that
        // created it could also open a sealed payload, and runs are pinned to
        // their creating deployment, so presence is a more reliable attestation
        // than a version compare — and it stays correct even when package
        // versions drift.
        let payloadKey: PayloadKey | undefined;
        const runPublicKey = encryptionKeyOverride
          ? // The caller already holds a key (resumeWebhook resolved one to
            // hydrate hook metadata), so sealing would add an ECDH for no
            // saved round trip. Reuse what it resolved.
            undefined
          : decodeRunPublicKey(resumeContext.encryptionPublicKey);

        if (runPublicKey) {
          payloadKey = sealTo(runPublicKey);
        } else {
          // Symmetric `encr` write fallback: needs only the AES key
          // (a bare CryptoKey via `resolveHookEncryptionKey`), not the
          // read-side RunPayloadKeys.
          let encryptionKey =
            encryptionKeyOverride ??
            (await resolveHookEncryptionKey(hook, info));
          if (
            !capabilities.supportedFormats.has(SerializationFormat.ENCRYPTED)
          ) {
            encryptionKey = undefined;
          }
          payloadKey = encryptionKey;
        }

        // Compress only when the target run and its deployment support the
        // compression formats introduced with spec version 5.
        const compression =
          (resumeContext.runSpecVersion ?? 0) >=
            SPEC_VERSION_SUPPORTS_COMPRESSION &&
          capabilities.supportedFormats.has(SerializationFormat.GZIP);

        // Dehydrate the payload for storage
        const ops: Promise<any>[] = [];
        const v1Compat = isLegacySpecVersion(hook.specVersion);
        const dehydratedPayload = await dehydrateStepReturnValue(
          payload,
          hook.runId,
          payloadKey,
          ops,
          globalThis,
          v1Compat,
          capabilities.framedByteStreams,
          compression
        );
        // These payload-stream ops are flushed in the background; the
        // promise handed to waitUntil must never reject (an unconsumed
        // waitUntil rejection crashes the process as unhandledRejection),
        // so unexpected failures are logged instead.
        // NOTE: rejections with `undefined` are an expected artifact of the
        // webhook bundle and are ignored entirely.
        safeWaitUntil(Promise.all(ops), (err) => {
          if (err === undefined) return;
          runtimeLogger.warn('Background flush of hook payload ops failed', {
            workflowRunId: hook.runId,
            hookId: hook.hookId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        // Mint a client-side idempotency key. When the resilient path fires
        // (events.create fails but queue succeeds), both the direct write
        // and the runtime's queue-payload fallback use this key so the
        // runtime can dedup any hook_received event that already carries it.
        const resumeId = ulid();

        // Only carry `hookInput` on the queue payload when the target run's
        // deployment can actually use it:
        // - The run must support the CBOR queue transport. Older deployments
        //   use JSON-only transport which cannot carry binary payloads
        //   (Uint8Array).
        // - The run's recorded `@workflow/core` version must understand
        //   `hookInput` (`supportsQueueHookInput`). Skew protection keeps
        //   runs on the deployment they were created on, so the runtime
        //   parsing this queue message may be older than this SDK — older
        //   schemas silently strip unknown payload fields, which would lose
        //   the resume payload while reporting success to the caller.
        // For runs that fail either check, fall back to today's behavior:
        // propagate the event-write error so the caller can retry.
        const runSpecVersion =
          resumeContext.runSpecVersion ?? SPEC_VERSION_LEGACY;
        const canCarryHookInput =
          runSpecVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT &&
          capabilities.supportsQueueHookInput;

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
          // Re-key any "hook can no longer be received" rejection to
          // HookNotFoundError(hook.token) so `.token` matches the
          // pre-fast-path contract, where resumeHook threw
          // `HookNotFoundError(hook.token)` after its own terminal check.
          // The specific error depends on the World:
          //   - a genuinely missing hook maps to HookNotFoundError (keyed on
          //     the event correlationId / hook ID);
          //   - a terminal run on Vercel rejects hook_received with 404, which
          //     world-vercel maps to HookNotFoundError;
          //   - a terminal run on world-local / world-postgres rejects with
          //     RunExpiredError.
          // EntityConflictError (HTTP 409) is kept for compatibility with
          // older / conflict-shaped rejection behavior.
          // These are terminal rejections, never transient — so they are
          // checked before the retryable (resilient-resume) classification.
          if (
            HookNotFoundError.is(err) ||
            EntityConflictError.is(err) ||
            RunExpiredError.is(err)
          ) {
            throw new HookNotFoundError(hook.token);
          }
          if (!canCarryHookInput || !isRetryableWorldError(err)) {
            // Non-retryable, or a run whose deployment cannot consume
            // `hookInput` (no fallback available) — propagate so the
            // caller can retry.
            throw err;
          }
          eventWriteFailed = true;
          eventWriteError = err;
        }

        span?.setAttributes({
          ...Attribute.WorkflowName(resumeContext.workflowName),
        });

        // Link to the run-origin context from the stored trace carrier
        // (skipped when absent or invalid).
        const originLink = await linkToTraceCarrier(resumeContext.traceCarrier);
        if (originLink) {
          span?.addLink?.(originLink);
        }

        // Re-trigger the workflow. Attach `hookInput` only when the direct
        // event write failed — otherwise the runtime's fallback path has
        // nothing to materialize and we avoid the dedup race.
        await world.queue(
          getWorkflowQueueName(resumeContext.workflowName),
          {
            runId: hook.runId,
            // attach the trace carrier from the run's resume context
            traceCarrier: resumeContext.traceCarrier ?? undefined,
            ...(eventWriteFailed && canCarryHookInput
              ? {
                  hookInput: {
                    hookId: hook.hookId,
                    resumeId,
                    // Carried so the materialized hook_received event gets
                    // the same replay-divergence token guard as a directly
                    // written one.
                    token: hook.token,
                    payload: dehydratedPayload,
                  },
                }
              : {}),
          } satisfies WorkflowInvokePayload,
          {
            deploymentId: resumeContext.deploymentId,
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
