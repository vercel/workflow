import {
  EntityConflictError,
  ERROR_SLUGS,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  HOOK_RESUME_DEDUP_VERSION,
  HOOK_RESUME_INPUT_VERSION,
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

/** Monotonic ULID factory for per-call resume idempotency keys. */
const generateResumeId = monotonicFactory();

/**
 * Upper bound on the serialized hook payload that the lazy path will inline
 * into the queue message's `hookInput`. Vercel Queues caps a single message at
 * ~256 KiB, and the message also carries the runId, hookId, token, resumeId,
 * digest, and trace carrier alongside CBOR framing overhead. Staying well under
 * that ceiling keeps the queue publish from rejecting an oversized message,
 * which on the lazy path would drop the resume entirely: the message is the
 * only copy of the payload. Above this size we fall back to the sequential
 * path, whose queue message carries only the run ID (the payload lives in the
 * event log).
 */
const MAX_INLINE_RESUME_PAYLOAD_BYTES = 128 * 1024;

/**
 * Hex SHA-256 of the serialized resume payload bytes. Computed once by the
 * producer and carried on the queue message's `hookInput`, so every delivery of
 * that message records an identical digest against the server's
 * `(runId, resumeId)` constraint and redeliveries converge on the one committed
 * `hook_received`. Hashing the already-serialized bytes (not the raw value)
 * keeps the digest stable across deliveries: the consumer forwards this string
 * without recomputing.
 */
async function computeResumePayloadDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const b of view) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

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
  const hookResumeInputVersion = run.executionContext?.hookResumeInputVersion;
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
    hookResumeInputVersion:
      typeof hookResumeInputVersion === 'number'
        ? hookResumeInputVersion
        : undefined,
  };
}

/**
 * Resolve resume context for a hook. Uses the stored `resumeContext` when
 * present (fast path, no run read); otherwise fetches the run and synthesizes
 * it. Does NOT resolve the encryption key; callers do that separately. Only
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
 * (`importKey`): the `encr` write fallback used when the run published no
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
  // default webhook (createWebhook() with no `respondWith`) stores no
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
 * The result of {@link resumeHook}: a {@link Hook} augmented with an optional
 * resilience signal.
 *
 * `resilientResume` is retained for source compatibility and is never set. It
 * signalled a resume whose direct `hook_received` write had failed while the
 * queue dispatch succeeded, back when the lazy path raced the two. The lazy
 * path no longer writes the event at all (the queue consumer materializes it
 * from `hookInput`), so there is no longer a distinction to report, and the
 * sequential path never set the flag either. Treat the result as a plain
 * {@link Hook}.
 */
export type ResumedHook = Hook & { resilientResume?: boolean };

/**
 * Resumes a workflow run by sending a payload to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * @param tokenOrHook - The unique token identifying the hook, or the hook object itself
 * @param payload - The data payload to send to the hook
 * @returns Promise resolving to the {@link ResumedHook}
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
): Promise<ResumedHook> {
  // Public entry point. It never attests hook freshness, so a Hook object
  // supplied here (which may carry a `resumeCapabilities` cached before a
  // server rollback or kill switch) is ignored by the dynamic-dedup gate and
  // fails closed to the sequential path. Only `resumeWebhook`, which fetches
  // the hook by token in-line during the same resume, reaches the internal
  // implementation with the fresh attestation set. Keeping the freshness flag
  // off the exported signature prevents a caller from passing a stale Hook plus
  // `true` and reactivating dynamic dedup against a rolled-back backend.
  //
  // T0 of the hook-resume TTR window is taken HERE, at the public entry point,
  // rather than inside the implementation; see the parameter's doc comment.
  return resumeHookImpl(
    tokenOrHook,
    payload,
    encryptionKeyOverride,
    false,
    Date.now(),
    false
  );
}

/**
 * {@link resumeHook} with the `hook_received` event written BEFORE this
 * resolves, for the one caller that needs the resume to be durable at that
 * instant rather than merely dispatched.
 *
 * The lazy path leaves the write to the queue consumer, so a normal
 * `resumeHook()` resolves while the event is still in flight. That is fine for
 * an external resume, whose caller has nothing racing it. It is NOT fine for a
 * resume the runtime itself issues as a barrier: a step that aborts a shared
 * `AbortController` resumes the hook that records the abort in the event log,
 * and that write has to land before the step completes, or the workflow
 * continuation `step_completed` enqueues can dispatch the next step with a
 * stale, non-aborted signal (see `reviveAbortController` in serialization.ts).
 *
 * Forcing the eager write costs the round trip the lazy path removes, which is
 * the right trade here: this is an internal ordering barrier, not the
 * latency-sensitive external resume the optimization targets. The resume span
 * reports `resume_fallback_reason: durable_required`.
 */
export async function resumeHookDurable<T = any>(
  tokenOrHook: string | Hook,
  payload: T,
  encryptionKeyOverride?: PayloadKey
): Promise<ResumedHook> {
  return resumeHookImpl(
    tokenOrHook,
    payload,
    encryptionKeyOverride,
    false,
    Date.now(),
    true
  );
}

/**
 * Internal implementation of {@link resumeHook}. NOT exported: the
 * `hookFreshlyLookedUp` attestation must never be reachable by public callers
 * (see the wrapper above).
 *
 * @param hookFreshlyLookedUp - Attests that a supplied Hook object was fetched
 *   by token during THIS resume, so its response-only `resumeCapabilities`
 *   reflects the live backend and may be trusted for the dynamic-dedup gate.
 *   A token string is always fetched fresh here, so it is implicitly fresh.
 * @param resumeRequestedAtMs - T0 of the hook-resume TTR window (see
 *   runtime/resume-latency.ts), stamped by the PUBLIC entry point the caller
 *   used. It is a parameter rather than a local because `resumeWebhook` does
 *   real work before it gets here (the by-token lookup, the run-key
 *   resolution that hydrates hook metadata, and the `respondWith` setup) and
 *   stamping locally would silently exclude all of it, so the two entry points
 *   would report the same metric over different windows.
 * @param requireDurableWrite - Force the sequential path so `hook_received` is
 *   committed before this resolves. See {@link resumeHookDurable}.
 */
async function resumeHookImpl<T = any>(
  tokenOrHook: string | Hook,
  payload: T,
  encryptionKeyOverride: PayloadKey | undefined,
  hookFreshlyLookedUp: boolean,
  resumeRequestedAtMs: number,
  requireDurableWrite: boolean
): Promise<ResumedHook> {
  return await waitedUntil(() => {
    return trace('hook.resume', async (span) => {
      const world = await getWorldLazy();

      try {
        const suppliedToken = typeof tokenOrHook === 'string';
        const hook: Hook = suppliedToken
          ? await world.hooks.getByToken(tokenOrHook)
          : tokenOrHook;
        // The dynamic, response-only `resumeCapabilities` may only be trusted
        // when it came from a by-token lookup performed during this resume.
        const hookResumeCapabilitiesAreFresh =
          suppliedToken || hookFreshlyLookedUp;

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
        // to HookNotFoundError: same public contract, no run pre-fetch.
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
        // the whole win: no run read AND no `getEncryptionKeyForRun`, whose
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
        // than a version compare, and it stays correct even when package
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

        span?.setAttributes({
          ...Attribute.WorkflowName(resumeContext.workflowName),
        });

        // Link to the run-origin context from the stored trace carrier
        // (skipped when absent or invalid). Resolved before dispatch so both
        // the sequential and lazy paths attach it.
        const originLink = await linkToTraceCarrier(resumeContext.traceCarrier);
        if (originLink) {
          span?.addLink?.(originLink);
        }

        const queueName = getWorkflowQueueName(resumeContext.workflowName);
        const queueOptions = {
          deploymentId: resumeContext.deploymentId,
          specVersion: resumeContext.runSpecVersion ?? SPEC_VERSION_LEGACY,
        };

        // Decide whether the `hook_received` event is written lazily by the
        // queue consumer (from the message's `hookInput`) or eagerly here,
        // before the publish. The lazy path is only safe when EVERY
        // precondition holds; the first that fails names the fallback reason
        // (emitted as a span attribute for observability, and to make "why did
        // this run sequential" answerable in production). All conditions:
        //
        //  - kill switch: `WORKFLOW_DISABLE_LAZY_HOOK_RESUME` forces sequential
        //    if the lazy path ever misbehaves. It is an SDK-deployment env var,
        //    so changing it generally requires redeploying the workflow
        //    deployment. (The backend can independently drop new resumes to the
        //    sequential path fleet-wide by ceasing to attest dedup support on
        //    the by-token lookup; see the backend-dedup condition below.)
        //  - backend dedup: the live backend must enforce the
        //    `(runId, resumeId)` constraint, or a queue redelivery would commit
        //    a second `hook_received`. Fail closed. Attested by EITHER a fresh,
        //    response-only `hook.resumeCapabilities.hookResumeDedupVersion` from
        //    the by-token lookup (world-vercel: recomputed every read, so a
        //    server rollback or kill switch drops to sequential immediately) OR
        //    the static `world.capabilities.hookResumeDedup` (world-local, whose
        //    adapter and backend ship together). The response-only capability is
        //    trusted ONLY when the hook was looked up by token during this
        //    resume (`hookResumeCapabilitiesAreFresh`); a Hook object handed in
        //    by a public caller may carry a capability cached before a rollback,
        //    so it is ignored and the path falls back to sequential.
        //  - consumer support: the target run's deployment must materialize the
        //    event from `hookInput` on replay. Attested by the run's explicit
        //    `hookResumeInputVersion` execution-context marker (mirrored onto
        //    resumeContext), NOT a version-compare against a predicted release
        //    cutoff. Absent → nothing would ever write the event, so the resume
        //    would be lost outright.
        //  - not legacy: v1Compat runs omit `token` from the eagerly written
        //    event body but the consumer always includes it, so a legacy run
        //    would get a different event depending on which path ran. Legacy
        //    stays sequential.
        //  - CBOR transport: the run must use CBOR queue transport so the binary
        //    payload survives the queue message.
        //  - raw bytes: the dehydrated payload must be a `Uint8Array` (the
        //    content digest that keys the dedup constraint is over these bytes).
        //  - size: on the lazy path the queue message carries the only copy of
        //    the payload, so a payload above the message ceiling would fail the
        //    publish and lose the resume. Oversized payloads stay sequential
        //    (their queue message carries only the run ID; the payload lives in
        //    the event log).
        const lazyResumeDisabled =
          process.env.WORKFLOW_DISABLE_LAZY_HOOK_RESUME === '1';
        // Backend dedup is supported when EITHER the live server attests it
        // fresh on this by-token hook (world-vercel: response-only, recomputed
        // every read, so rollback/kill-switch take effect immediately) OR the
        // static world capability is set (world-local: adapter + backend ship
        // together). Both are re-evaluated per resume, so every rollout and
        // rollback direction degrades safely to the sequential path.
        const backendDedupSupported =
          (hookResumeCapabilitiesAreFresh
            ? (hook.resumeCapabilities?.hookResumeDedupVersion ?? 0)
            : 0) >= HOOK_RESUME_DEDUP_VERSION ||
          world.capabilities?.hookResumeDedup === true;
        const fallbackReason: string | null = requireDurableWrite
          ? // An internal caller needs the event committed before this
            // resolves (an ordering barrier), which only the eager write
            // provides. Checked first so the span names the real reason
            // rather than whichever gate happens to fail alongside it.
            'durable_required'
          : lazyResumeDisabled
            ? 'disabled'
            : !backendDedupSupported
              ? 'backend_unsupported'
              : (resumeContext.hookResumeInputVersion ?? 0) <
                  HOOK_RESUME_INPUT_VERSION
                ? 'consumer_unsupported'
                : v1Compat
                  ? 'legacy'
                  : (resumeContext.runSpecVersion ?? 0) <
                      SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
                    ? 'non_cbor_transport'
                    : !(dehydratedPayload instanceof Uint8Array)
                      ? 'non_bytes'
                      : dehydratedPayload.byteLength >
                          MAX_INLINE_RESUME_PAYLOAD_BYTES
                        ? 'oversized'
                        : null;
        const useLazyResume = fallbackReason === null;

        span?.setAttributes({
          'workflow.hook.resume_strategy': useLazyResume
            ? 'lazy'
            : 'sequential',
          ...(fallbackReason
            ? { 'workflow.hook.resume_fallback_reason': fallbackReason }
            : {}),
        });

        if (!useLazyResume) {
          // Sequential path: create a hook_received event, then re-trigger.
          //
          // Re-key any "hook can no longer be received" rejection to
          // HookNotFoundError(hook.token) so `.token` matches the historical
          // contract, where resumeHook threw `HookNotFoundError(hook.token)`
          // after its own terminal check. The specific error depends on the
          // World:
          //   - a genuinely missing hook maps to HookNotFoundError (keyed on
          //     the event correlationId / hook ID);
          //   - a terminal run on Vercel rejects hook_received with 404, which
          //     world-vercel maps to HookNotFoundError;
          //   - a terminal run on world-local / world-postgres rejects with
          //     RunExpiredError.
          //
          // An EntityConflictError (HTTP 409) is also treated as "hook gone"
          // here for historical / conflict-shaped-rejection compatibility:
          // this path holds no queue message in flight, so a conflict has no
          // consumer to converge on.
          //
          // The lazy path performs no write, so it raises none of these: see
          // the note on its terminal-run behavior below.
          const isHookGoneError = (err: unknown): boolean =>
            HookNotFoundError.is(err) ||
            EntityConflictError.is(err) ||
            RunExpiredError.is(err);
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
            if (isHookGoneError(err)) {
              throw new HookNotFoundError(hook.token);
            }
            throw err;
          }

          // T1 of the TTR window. Stamped immediately before the publish so
          // `producer_prep` covers exactly the work above it (hook lookup,
          // key resolution, serialization, and, on this path, the awaited
          // `hook_received` write, which is genuinely serial here).
          const queuePublishRequestedAtMs = Date.now();
          await world.queue(
            queueName,
            {
              runId: hook.runId,
              traceCarrier: resumeContext.traceCarrier ?? undefined,
              hookResumeTiming: {
                resumeRequestedAtMs,
                queuePublishRequestedAtMs,
                strategy: 'sequential',
              },
            } satisfies WorkflowInvokePayload,
            queueOptions
          );

          return hook;
        }

        // Lazy path: publish the queue message and let the consumer write the
        // `hook_received` event from `hookInput` before it replays. The
        // producer writes nothing, so the resume costs exactly one round trip
        // (the publish) instead of two, and the event is created once, by the
        // side that is about to replay it.
        //
        // `resumeId` is the idempotency key the consumer sends with that write;
        // `payloadDigest` lets the server detect key reuse across
        // byte-different payloads. Both ride the message, so every redelivery
        // of it converges on the one committed event via the backend's
        // `(runId, resumeId)` constraint (the precondition gated above).
        //
        // Two things a caller could previously infer from a resolved resume,
        // and can no longer:
        //
        //  - Visibility. This returns once the publish is accepted, not once
        //    `hook_received` exists, so a caller that reads the run back
        //    immediately can see a log without it. Delivery is unaffected: the
        //    payload is on the message.
        //  - The run still being live. The hook lookup above still validates
        //    that a hook holds the token (and which run it belongs to), but
        //    `resumeContext` is an immutable slice and carries no status, and
        //    with no write there is no server rejection to observe. A resume
        //    against an ended run therefore resolves rather than throwing
        //    HookNotFoundError. It is reachable only while the hook outlives
        //    its run (minimum retention, or before the token is released);
        //    otherwise the lookup itself fails. Nothing resumes either way:
        //    the consumer's write is rejected the same way and the delivery is
        //    consumed. The paths that do observe the status are unchanged: the
        //    `run_fallback` terminal pre-check above, and the sequential
        //    path's own write.
        const resumeId = generateResumeId();
        const payloadDigest = await computeResumePayloadDigest(
          dehydratedPayload as Uint8Array
        );
        span?.setAttributes({ 'workflow.hook.resume_id': resumeId });

        // T1 of the TTR window, stamped at the instant the publish is
        // requested: `producer_prep` covers exactly the work above it (hook
        // lookup, key resolution, serialization) and nothing else, since no
        // event write remains on this path.
        const queuePublishRequestedAtMs = Date.now();
        await world.queue(
          queueName,
          {
            runId: hook.runId,
            traceCarrier: resumeContext.traceCarrier ?? undefined,
            hookInput: {
              resumeId,
              hookId: hook.hookId,
              token: hook.token,
              payload: dehydratedPayload,
              payloadDigest,
              // Deployment affinity for the consumer's cheap pre-write
              // check: lets a misrouted delivery re-route before its
              // hoisted hook_received write instead of after.
              deploymentId: resumeContext.deploymentId,
            },
            hookResumeTiming: {
              resumeRequestedAtMs,
              queuePublishRequestedAtMs,
              strategy: 'lazy',
            },
          } satisfies WorkflowInvokePayload,
          queueOptions
        );

        // A rejected publish propagates: the message is the only carrier of
        // both the trigger and the payload, so a failed publish is a failed
        // resume, with nothing persisted for a later delivery to pick up.
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
  // T0 of the hook-resume TTR window. Everything below (the by-token lookup,
  // the run-key resolution it may trigger, and the `respondWith` setup) is
  // real producer-side latency on this path, so the window has to open here
  // and not inside `resumeHookImpl`; otherwise webhook resumes would report a
  // systematically shorter total than `resumeHook` ones into the same metric.
  const resumeRequestedAtMs = Date.now();
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

  // `hook` was just fetched via `getHookByTokenWithKey` (a fresh by-token
  // lookup) above, so its response-only `resumeCapabilities` reflects the live
  // backend. Call the internal implementation with the fresh attestation so
  // the lazy path stays available without a second GET. (The public
  // `resumeHook` never sets this, so a caller cannot forge it.)
  await resumeHookImpl(
    hook,
    request,
    encryptionKey,
    true,
    resumeRequestedAtMs,
    false
  );

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
