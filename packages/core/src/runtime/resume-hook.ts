import {
  ERROR_SLUGS,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRuntimeError,
} from '@workflow/errors';
import {
  HOOK_RESUME_DEDUP_VERSION,
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
 * Hex SHA-256 of the serialized resume payload bytes. Computed once by the
 * producer and sent with its durable `hook_received` write so transport and
 * slot retries converge through the server's `(runId, resumeId)` constraint.
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

const HOOK_WAKE_RETRY_DELAYS_MS = [25, 100] as const;

/**
 * A wake failure worth retrying is transport-shaped (network error, 5xx,
 * throttle). A definitive rejection will not change on a 25ms retry, so
 * spending the budget on it only delays the caller's error.
 *
 * `@vercel/queue` errors carry no `status` field — they are bare `Error`
 * subclasses distinguished by `name` — so classification checks the World's
 * deployment-unavailable hook first (a deployment the queue cannot discover
 * will not come back within this function's ~125ms budget), then a numeric
 * status when one exists (non-Vercel queue implementations), then the queue
 * client's definitive-4xx error names.
 */
function isRetryableWakeError(
  error: unknown,
  isDeploymentUnavailableError?: (error: unknown) => boolean
): boolean {
  if (isDeploymentUnavailableError?.(error)) return false;
  const status = (error as { status?: unknown; statusCode?: unknown }) ?? {};
  const code = status.status ?? status.statusCode;
  if (typeof code === 'number') {
    return code >= 500 || code === 408 || code === 429;
  }
  const name = (error as Error | null)?.name;
  return (
    name !== 'BadRequestError' &&
    name !== 'UnauthorizedError' &&
    name !== 'ForbiddenError'
  );
}

// A publish may succeed even when its response is lost, so a retry can
// enqueue a duplicate wake. That is harmless: the event is already durable,
// and deterministic replay makes a second delivery of the same run a no-op.
async function publishHookWakeWithRetry(
  publish: () => Promise<unknown>,
  isDeploymentUnavailableError?: (error: unknown) => boolean
): Promise<void> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt <= HOOK_WAKE_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    try {
      await publish();
      return;
    } catch (error) {
      lastError = error;
      if (!isRetryableWakeError(error, isDeploymentUnavailableError)) break;
      const delayMs = HOOK_WAKE_RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // The wake only runs after the hook_received write committed, so a wake
  // failure here is necessarily "durable but not yet dispatched": the event
  // survives, and any later wake of the run delivers it. Do not let a queue
  // implementation reuse HookNotFoundError and accidentally imply that no
  // hook_received exists.
  if (HookNotFoundError.is(lastError)) {
    throw new WorkflowRuntimeError(
      'The hook resume was committed, but its workflow wake could not be published',
      { cause: lastError }
    );
  }
  throw lastError;
}

/**
 * A hook record with its serialized `metadata` omitted: everything a resume
 * actually reads. Resuming never looks at metadata, so the resume path accepts
 * both a raw {@link Hook} straight out of a World and a
 * {@link HookWithLazyMetadata} whose `metadata` is a Promise.
 */
type ResumableHook = Omit<Hook, 'metadata'>;

/**
 * A {@link Hook} whose user-defined `metadata` is hydrated lazily.
 *
 * `metadata` is a getter that returns a Promise — the same shape as
 * `Run.returnValue` — so looking a hook up by token costs exactly one read.
 * Hydrating metadata is a decrypting READ that needs the owning run's payload
 * keys, and resolving those can cost a run fetch plus a `run-key` API round
 * trip (~350ms). Deferring that to first access keeps the lookup fast for the
 * many callers that only need `runId`/`token` — most importantly hook
 * resumption, which never reads metadata at all.
 *
 * The promise is memoized: hydration (and the key resolution behind it) runs at
 * most once per hook object. Awaiting it on a hook that stored no metadata
 * resolves `undefined` and performs no I/O.
 *
 * Like `Run.returnValue`, the accessor is non-enumerable, so it is absent from
 * `{ ...hook }` and `JSON.stringify(hook)` — read it explicitly and include the
 * awaited value if you need to forward it.
 *
 * @example
 *
 * ```ts
 * const hook = await getHookByToken(token);
 * console.log(hook.runId); // no metadata work
 * const metadata = (await hook.metadata) as { allowedUserId?: string } | undefined;
 * ```
 */
export interface HookWithLazyMetadata extends ResumableHook {
  /**
   * The hook's user-defined metadata, hydrated on first access and memoized.
   * Resolves `undefined` when the hook carries no metadata.
   */
  readonly metadata: Promise<unknown>;
}

/**
 * A by-token hook lookup: the hook itself plus access to the payload keys that
 * hydrating its `metadata` resolved, if anything ever awaited it.
 */
interface HookLookup {
  hook: HookWithLazyMetadata;
  /**
   * The read-side payload keys resolved while hydrating `metadata`, or
   * `undefined` when `metadata` was never awaited, the hook stored none, or the
   * run has no key (encryption disabled). Lets `resumeWebhook` — the one caller
   * that must read metadata — reuse that key for the payload WRITE instead of
   * paying a second `run-key` round trip. Only meaningful after awaiting
   * `hook.metadata`.
   */
  metadataEncryptionKey(): PayloadKey | undefined;
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
async function resolveHookResumeInfo(
  hook: ResumableHook
): Promise<HookResumeInfo> {
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
  hook: ResumableHook,
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

/** Whether `metadata` on this record is already the lazy Promise accessor. */
function hasLazyMetadata(hook: ResumableHook): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(hook, 'metadata');
  return descriptor !== undefined && typeof descriptor.get === 'function';
}

/**
 * Wraps a raw hook record from a World in a {@link HookWithLazyMetadata},
 * replacing its serialized `metadata` with a memoized Promise getter that
 * hydrates on first access.
 *
 * Nothing here touches the network: the wrap is a property definition. All of
 * the cost — resolving the run's payload keys and decrypting — moves inside the
 * getter, so a lookup that never reads metadata pays for exactly one
 * `hooks.getByToken`.
 *
 * The original record is left untouched; the returned object is a shallow copy
 * carrying the accessor.
 */
function withLazyMetadata(raw: Hook): HookLookup {
  const serialized = raw.metadata;
  let hydrated: Promise<unknown> | undefined;
  let encryptionKey: PayloadKey | undefined;

  // Hydrating metadata is a decrypting READ, so it derives the full
  // RunPayloadKeys (which open sealed `encp` metadata, not just symmetric
  // `encr`) rather than the bare write key the resume path uses.
  const hydrate = async (): Promise<unknown> => {
    const world = await getWorldLazy();
    const info = await resolveHookResumeInfo(raw);
    // On the fast path this resolves the key by runId + deploymentId (no run
    // read); on the fallback path it reuses the already-fetched run.
    const rawKey = info.run
      ? await world.getEncryptionKeyForRun?.(info.run)
      : await world.getEncryptionKeyForRun?.(raw.runId, {
          deploymentId: info.resumeContext.deploymentId,
        });
    encryptionKey = rawKey ? await deriveRunPayloadKeys(rawKey) : undefined;
    return await hydrateStepArguments(
      serialized as any,
      raw.runId,
      encryptionKey
    );
  };

  const hook = Object.create(
    Object.getPrototypeOf(raw),
    Object.getOwnPropertyDescriptors(raw)
  ) as HookWithLazyMetadata;
  Object.defineProperty(hook, 'metadata', {
    // A hook with no metadata resolves `undefined` without any I/O, so callers
    // can await unconditionally. Memoized either way: metadata is fixed at
    // hook-creation time, so hydration runs at most once per hook object.
    get: () =>
      (hydrated ??=
        typeof serialized === 'undefined'
          ? Promise.resolve(undefined)
          : hydrate()),
    // Non-enumerable, matching `Run.returnValue` (a prototype getter, so it is
    // absent from an instance's own keys). Spreading or `JSON.stringify`-ing a
    // hook therefore cannot trigger hydration nobody asked for — which would
    // otherwise leave a floating rejection when the run key is unreachable, and
    // an unconsumed rejected Promise crashes Node as an unhandledRejection.
    enumerable: false,
    configurable: true,
  });

  return { hook, metadataEncryptionKey: () => encryptionKey };
}

/**
 * Normalizes any hook record the resume path accepted into a
 * {@link HookWithLazyMetadata} to return to the caller. Idempotent: a hook that
 * already carries the lazy accessor (one that came from `getHookByToken`) is
 * returned as-is rather than double-wrapped, which would hand
 * `hydrateStepArguments` a Promise.
 */
function asLazyMetadataHook(hook: ResumableHook): HookWithLazyMetadata {
  return hasLazyMetadata(hook)
    ? (hook as HookWithLazyMetadata)
    : withLazyMetadata(hook as Hook).hook;
}

/**
 * Get the hook by token to find the associated workflow run.
 *
 * This is a single read. The returned hook's `metadata` is a getter that
 * resolves a Promise (see {@link HookWithLazyMetadata}), so the run fetch and
 * `run-key` round trip that hydrating it can require are only paid by callers
 * that actually await it:
 *
 * ```ts
 * const hook = await getHookByToken(token);
 * const metadata = await hook.metadata;
 * ```
 *
 * A Hook kept by minimum retention remains available here after its run ends,
 * but cannot be resumed.
 *
 * @param token - The unique token identifying the hook
 */
export async function getHookByToken(
  token: string
): Promise<HookWithLazyMetadata> {
  const world = await getWorldLazy();
  return withLazyMetadata(await world.hooks.getByToken(token)).hook;
}

/**
 * The result of {@link resumeHook}: a {@link HookWithLazyMetadata} augmented
 * with an optional resilience signal.
 *
 * `resilientResume` is retained for source compatibility and is never set.
 * `resumeHook()` now requires the durable `hook_received` write and workflow
 * wake to both succeed before it resolves. Treat the result as a plain
 * {@link HookWithLazyMetadata}.
 */
export type ResumedHook = HookWithLazyMetadata & {
  resilientResume?: boolean;
};

/**
 * Resumes a workflow run by sending a payload to a hook identified by its token.
 *
 * This function is called externally (e.g., from an API route or server action)
 * to send data to a hook and resume the associated workflow run.
 *
 * Resolving means BOTH that the `hook_received` event is durably recorded in
 * the run's event log and that the workflow wake was accepted by the queue, in
 * that order. A {@link HookNotFoundError} means this invocation committed no
 * event. Any other error after the write is ambiguous only in dispatch, never
 * in durability: the event may already be committed, and a later wake of the
 * run (from any source) will deliver it.
 *
 * Prefer passing the token string over a cached {@link Hook} object. A token
 * is looked up fresh, so the live backend can attest its atomic resume claim
 * and the durable write becomes idempotent-on-retry (transport retries of the
 * same write converge on one event). A supplied Hook object may carry a stale
 * attestation, so it is deliberately ignored and the write is claim-less —
 * meaning a lost response cannot be retried safely: retrying at the
 * application level mints a fresh claim and can commit a second
 * `hook_received`.
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
  tokenOrHook: string | ResumableHook,
  payload: T,
  encryptionKeyOverride?: PayloadKey
): Promise<ResumedHook> {
  // Public entry point. It never attests hook freshness, so a Hook object
  // supplied here (which may carry a `resumeCapabilities` cached before a
  // server rollback or kill switch) is ignored by the dynamic-dedup gate and
  // fails closed to a plain, claim-less write. Only `resumeWebhook`, which
  // fetches the hook by token in-line during the same resume, reaches the
  // internal implementation with the fresh attestation set. Keeping the
  // freshness flag off the exported signature prevents a caller from passing a
  // stale Hook plus `true` and reactivating dynamic dedup against a
  // rolled-back backend.
  //
  // T0 of the hook-resume TTR window is taken HERE, at the public entry point,
  // rather than inside the implementation; see the parameter's doc comment.
  return resumeHookImpl(
    tokenOrHook,
    payload,
    encryptionKeyOverride,
    false,
    Date.now()
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
 */
async function resumeHookImpl<T = any>(
  tokenOrHook: string | ResumableHook,
  payload: T,
  encryptionKeyOverride: PayloadKey | undefined,
  hookFreshlyLookedUp: boolean,
  resumeRequestedAtMs: number
): Promise<ResumedHook> {
  return await waitedUntil(() => {
    return trace('hook.resume', async (span) => {
      const world = await getWorldLazy();

      try {
        const suppliedToken = typeof tokenOrHook === 'string';
        const hook: ResumableHook = suppliedToken
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
        const readbackOps: Promise<any>[] = [];
        const v1Compat = isLegacySpecVersion(hook.specVersion);
        const dehydratedPayload = await dehydrateStepReturnValue(
          payload,
          hook.runId,
          payloadKey,
          ops,
          globalThis,
          v1Compat,
          capabilities.framedByteStreams,
          compression,
          undefined,
          readbackOps
        );
        // A hook_received event is not durable while its payload still points
        // at stream uploads in flight. Finish those before committing the
        // event — but ONLY the producer-push ops in `ops`. A dehydrated
        // WritableStream lands in `readbackOps` instead: it is a server-stream
        // READER that resolves only once the woken workflow writes into it (a
        // manual webhook's `responseWritable` is the canonical case), so
        // awaiting it here would deadlock the resume against its own wake.
        //
        // A rejection with `undefined` is an expected artifact of the webhook
        // bundle and was historically ignored by the background flush. Keep
        // that tolerance now that the flush is awaited inline.
        await Promise.all(
          ops.map((op) =>
            op.catch((error) => {
              if (error !== undefined) throw error;
            })
          )
        );
        // Readback pipes (notably a manual webhook response writable) can only
        // finish after the workflow wakes and writes to them. Keep them alive,
        // but never place them in the durability barrier above.
        safeWaitUntil(Promise.all(readbackOps), (err) => {
          if (err === undefined) return;
          runtimeLogger.warn('Background readback of hook payload failed', {
            workflowRunId: hook.runId,
            hookId: hook.hookId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

        span?.setAttributes({
          ...Attribute.WorkflowName(resumeContext.workflowName),
        });

        // Link to the run-origin context from the stored trace carrier
        // (skipped when absent or invalid). Resolved before dispatch so the
        // write and the wake both sit under a span that carries it.
        const originLink = await linkToTraceCarrier(resumeContext.traceCarrier);
        if (originLink) {
          span?.addLink?.(originLink);
        }

        const queueName = getWorkflowQueueName(resumeContext.workflowName);
        const queueOptions = {
          deploymentId: resumeContext.deploymentId,
          specVersion: resumeContext.runSpecVersion ?? SPEC_VERSION_LEGACY,
        };

        // The dispatch is strictly serial: the hook_received event is made
        // durable FIRST, and the workflow wake is published only after the
        // write is acknowledged. This is what lets `resumeHook()` resolving
        // mean "the resume survives anything that happens next" — a disposal
        // or run completion racing the queue delivery cannot erase a committed
        // event, and the wake itself carries no payload, so nothing rides on
        // the message but the trigger.
        //
        // Backend dedup is attested when EITHER the live server attests it
        // fresh on this by-token hook (world-vercel: response-only, recomputed
        // every read, so rollback/kill-switch take effect immediately) OR the
        // static world capability is set (world-local: adapter + backend ship
        // together). When attested, the write carries a per-call resumeId +
        // payload digest so transport-level retries of the SAME write converge
        // on exactly one committed event via the backend's (runId, resumeId)
        // constraint. Without it the write is a plain single-shot create,
        // exactly as before dedup existed.
        const backendDedupSupported =
          (hookResumeCapabilitiesAreFresh
            ? (hook.resumeCapabilities?.hookResumeDedupVersion ?? 0)
            : 0) >= HOOK_RESUME_DEDUP_VERSION ||
          world.capabilities?.hookResumeDedup === true;
        const canClaimResume =
          backendDedupSupported &&
          !v1Compat &&
          dehydratedPayload instanceof Uint8Array;

        span?.setAttributes({
          'workflow.hook.resume_strategy': 'sequential',
        });

        const resumeId = canClaimResume ? generateResumeId() : undefined;
        const payloadDigest = canClaimResume
          ? await computeResumePayloadDigest(dehydratedPayload)
          : undefined;
        if (resumeId) {
          span?.setAttributes({ 'workflow.hook.resume_id': resumeId });
        }

        // Re-key any "hook can no longer be received" rejection to
        // HookNotFoundError(hook.token) so `.token` matches the historical
        // contract. The specific error depends on the World:
        //   - a genuinely missing hook maps to HookNotFoundError (keyed on
        //     the event correlationId / hook ID);
        //   - a terminal run on Vercel rejects hook_received with 404, which
        //     world-vercel maps to HookNotFoundError;
        //   - a terminal run on world-local / world-postgres rejects with
        //     RunExpiredError.
        //
        // An EntityConflictError (HTTP 409) is deliberately NOT re-keyed,
        // breaking with the historical mapping: every 409 the backend emits
        // on this write today is TRANSIENT — a slot conflict that escaped the
        // server's own retry budget under contention, or a resume-claim race
        // mid-resolution — and its transaction committed nothing. Re-keying
        // it to HookNotFoundError told the caller (and a webhook sender, via
        // 404) that a retryable failure was permanent, silently dropping the
        // resume. It now surfaces as-is: retryable, with nothing committed.
        // (A 422 resumeId-reuse error likewise passes through unmapped — it
        // means the caller replayed a resumeId with a different payload, and
        // hiding that behind "not found" would mask the bug.)
        const isHookGoneError = (err: unknown): boolean =>
          HookNotFoundError.is(err) || RunExpiredError.is(err);
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
            {
              v1Compat,
              ...(resumeId && payloadDigest
                ? { resumeId, resumePayloadDigest: payloadDigest }
                : {}),
            }
          );
        } catch (err) {
          if (isHookGoneError(err)) {
            throw new HookNotFoundError(hook.token);
          }
          throw err;
        }
        // Stamped AFTER the write resolves (entry-time attributes cannot tell
        // an attempted resume from a committed one): together with
        // HookWakePublished below, this is what makes a stranded resume — a
        // committed event whose wake never went out or was never delivered —
        // queryable from traces. See the alerting note on HookWakePublished.
        span?.setAttributes(Attribute.HookResumeCommitted(true));

        // T1 of the TTR window. Stamped immediately before the publish so
        // `producer_prep` covers exactly the work above it (hook lookup, key
        // resolution, serialization, and the awaited hook_received write,
        // which is genuinely serial here).
        const queuePublishRequestedAtMs = Date.now();
        await publishHookWakeWithRetry(
          () =>
            world.queue(
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
              {
                ...queueOptions,
                // Dedup retried publishes whose response was lost: a
                // duplicate wake is harmless for correctness (deterministic
                // replay) but costs a full replay of the run, and the queue
                // accepts a repeated idempotency key by delivering only one
                // of the messages. Claim-less writes have no resumeId and
                // keep the previous behavior.
                ...(resumeId ? { idempotencyKey: `hook-${resumeId}` } : {}),
              }
            ),
          world.isDeploymentUnavailableError?.bind(world)
        );
        span?.setAttributes(Attribute.HookWakePublished(true));

        return asLazyMetadataHook(hook) satisfies ResumedHook;
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
  const world = await getWorldLazy();
  const { hook, metadataEncryptionKey } = withLazyMetadata(
    await world.hooks.getByToken(token)
  );

  // Only webhooks can be resumed via the public endpoint.
  // If the hook was created via createHook() (isWebhook !== true),
  // throw the same "not found" error the world would throw for a missing
  // token. This prevents leaking that the token is valid.
  if (hook.isWebhook === false) {
    throw new HookNotFoundError(token);
  }

  // `respondWith` lives in the hook's metadata, so this is the one resume path
  // that has to read it. Only a webhook that actually stored metadata pays for
  // the hydration: the common default webhook — createWebhook() with no
  // `respondWith` — stores none, so this resolves `undefined` with no ~350ms
  // `run-key` API round trip, and hands `resumeHook` no key, leaving it free to
  // seal the payload to the run's published public key instead.
  const metadata = await hook.metadata;

  let response: Response | undefined;
  let responseReadable: ReadableStream<Response> | undefined;
  if (metadata && typeof metadata === 'object' && 'respondWith' in metadata) {
    if (metadata.respondWith === 'manual') {
      const { readable, writable } = new TransformStream<Response, Response>();
      responseReadable = readable;

      // The request instance includes the writable stream which will be used
      // to write the response to the client from within the workflow run
      (request as any)[WEBHOOK_RESPONSE_WRITABLE] = writable;
    } else if (metadata.respondWith instanceof Response) {
      response = metadata.respondWith;
    } else {
      throw new WorkflowRuntimeError(
        `Invalid \`respondWith\` value: ${metadata.respondWith}`,
        { slug: ERROR_SLUGS.WEBHOOK_INVALID_RESPOND_WITH_VALUE }
      );
    }
  } else {
    // No `respondWith` value implies the default behavior of returning a 202
    response = new Response(null, { status: 202 });
  }

  // `hook` was just fetched by token above, so its response-only
  // `resumeCapabilities` reflects the live backend. Call the internal
  // implementation with the fresh attestation so the write's idempotency claim
  // stays available without a second GET. (The public `resumeHook` never sets
  // this, so a caller cannot forge it.)
  //
  // Reuse whatever key the metadata hydration above resolved (`undefined` when
  // it resolved none) so a metadata-bearing webhook resolves the run key
  // exactly once end to end.
  await resumeHookImpl(
    hook,
    request,
    metadataEncryptionKey(),
    true,
    resumeRequestedAtMs
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
