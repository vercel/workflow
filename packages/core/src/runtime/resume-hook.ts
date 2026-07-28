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
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  type WorkflowInvokePayload,
  type WorkflowRun,
} from '@workflow/world';
import { getRunCapabilities } from '../capabilities.js';
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
 * Resumes a workflow run by sending a payload to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * @param tokenOrHook - The unique token identifying the hook, or the hook object itself
 * @param payload - The data payload to send to the hook
 * @returns Promise resolving to the hook
 * @throws {HookNotFoundError} If the Hook does not exist or its run has ended
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
): Promise<Hook> {
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

        // Create a hook_received event with the payload
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
          if (
            HookNotFoundError.is(err) ||
            EntityConflictError.is(err) ||
            RunExpiredError.is(err)
          ) {
            throw new HookNotFoundError(hook.token);
          }
          throw err;
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

        // Re-trigger the workflow against the deployment ID associated
        // with the workflow run that the hook belongs to
        await world.queue(
          getWorkflowQueueName(resumeContext.workflowName),
          {
            runId: hook.runId,
            // attach the trace carrier from the run's resume context
            traceCarrier: resumeContext.traceCarrier ?? undefined,
          } satisfies WorkflowInvokePayload,
          {
            deploymentId: resumeContext.deploymentId,
            specVersion: resumeContext.runSpecVersion ?? SPEC_VERSION_LEGACY,
          }
        );

        return hook;
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
