import {
  EntityConflictError,
  HookConflictError,
  RUN_ERROR_CODES,
  WorkflowRuntimeError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import { parseDurationToDate } from '@workflow/utils';
import { workflowDisplayName } from '@workflow/utils/parse-name';
import type {
  RunCreationData,
  StartHook,
  WorkflowInvokePayload,
  WorkflowRunStatus,
  World,
} from '@workflow/world';
import {
  HOOK_RESUME_INPUT_VERSION,
  isLegacySpecVersion,
  PARENT_RUN_ID_ATTRIBUTE,
  ROOT_RUN_ID_ATTRIBUTE,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  workflowRunIdSchema,
} from '@workflow/world';
import type { StringValue } from 'ms';
import { monotonicFactory } from 'ulid';
import { normalizeAttributeChanges } from '../attribute-changes.js';
import { getRunCapabilities } from '../capabilities.js';
import { isRetryableWorldError } from '../classify-error.js';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import type { Serializable } from '../schemas.js';
import {
  bytesToBase64,
  decodeRunPublicKey,
  deriveRunKeyPair,
} from '../sealed-box.js';
import {
  dehydrateWorkflowArguments,
  type PayloadKey,
  SerializationFormat,
  sealTo,
} from '../serialization.js';
import { contextStorage } from '../step/context-storage.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace } from '../telemetry.js';
import { version as workflowCoreVersion } from '../version.js';
import { getWorldLazy } from './get-world-lazy.js';
import { getWorkflowQueueName, healthCheck } from './helpers.js';
import { Run } from './run.js';
import { getWorkflowVmFromEnv } from './vm-mode.js';
import { safeWaitUntil, waitedUntil } from './wait-until.js';
import { assertWorldSupportsRuntimeProtocol } from './world-compatibility.js';

/**
 * Timeout for the cross-deployment capability probe done before
 * dehydrating workflow arguments. Kept tight on purpose: the probe is
 * an optimization (it lets the caller emit the framed byte-stream wire
 * format when the target supports it), and the fallback on timeout is
 * the legacy raw format which always works. Long delays here would just
 * make `start({ deploymentId: ... })` slower for users whose target
 * deployments don't recognize the health check at all.
 */
const CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS = 2_000;

/** ULID generator for client-side runId generation */
const ulid = monotonicFactory();

/**
 * Cross-run lineage for a run being started from inside another run.
 *
 * The ambient step context carries the parent run id and the root of its
 * lineage; the runtime fills both from the run it already has loaded, so this
 * is a pure context read with no I/O. The new run records `$parentRunId` (the
 * edge) and inherits the parent's `$rootRunId` (the parent itself when it is a
 * root), so a daisy chain or fan-out of any depth groups under one root id.
 * Returns `undefined` for a top-level `start()`, which has no context, so
 * standalone runs carry no lineage.
 */
function resolveLineageAttributes(): Record<string, string> | undefined {
  const store = contextStorage.getStore();
  const parentRunId = store?.workflowMetadata?.workflowRunId;
  if (!parentRunId) return undefined;

  return {
    [ROOT_RUN_ID_ATTRIBUTE]: store.rootRunId ?? parentRunId,
    [PARENT_RUN_ID_ATTRIBUTE]: parentRunId,
  };
}

// `deploymentId: 'latest'` is a no-op in Worlds without atomic deployments.
// The warning that explains this only needs to fire once per process: a
// workflow that hardcodes 'latest' for its Vercel deployment would otherwise
// log it on every local/Postgres run, flooding tight dev loops.
let hasWarnedLatestNoOp = false;

/**
 * Reset the `deploymentId: 'latest'` no-op warn-once guard. Test-only —
 * exported so unit tests can exercise the warn path across `start()` calls.
 *
 * @internal
 */
export function _resetLatestNoOpWarnForTests(): void {
  hasWarnedLatestNoOp = false;
}

export interface StartHookOptions {
  /** Non-empty token reserved atomically while the workflow is admitted. */
  token: string;

  /**
   * **Experimental.** Keeps the token unavailable for at least this long.
   * Accepts the same duration string, millisecond number, or absolute `Date`
   * as `sleep()` and `createHook({ experimental_minRetention })`.
   *
   * The workflow remains the owner until it ends even if this time passes
   * first. A matching `createHook()` can extend, but cannot shorten, it.
   */
  experimental_minRetention?: StringValue | Date | number;
}

function normalizeStartHook(options: StartHookOptions): StartHook {
  if (options.token.length === 0) {
    throw new WorkflowRuntimeError('hook.token must be a non-empty string.');
  }
  if (options.experimental_minRetention === undefined) {
    return { token: options.token };
  }

  const tokenRetentionUntil = parseDurationToDate(
    options.experimental_minRetention
  );
  if (
    !Number.isFinite(tokenRetentionUntil.getTime()) ||
    tokenRetentionUntil.getTime() <= Date.now()
  ) {
    throw new WorkflowRuntimeError(
      'hook.experimental_minRetention must resolve to a future time.'
    );
  }
  return { token: options.token, tokenRetentionUntil };
}

function atomicStartContractError(message: string): WorkflowWorldError {
  return new WorkflowWorldError(message, {
    code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
  });
}

export interface StartOptionsBase {
  /**
   * Atomically reserves a Hook token while admitting the workflow run. If
   * another run owns the token, `start()` throws `HookConflictError` and the
   * duplicate candidate never becomes a run.
   */
  hook?: StartHookOptions;

  /**
   * The world to use for the workflow run creation,
   * by default the world is inferred from the environment variables.
   */
  world?: World;

  /**
   * The spec version to use for the workflow run. Defaults to the latest version.
   */
  specVersion?: number;

  /**
   * Optional region identifier for the new run. Currently consumed only
   * by `@workflow/world-vercel`, which embeds the region into the tagged
   * run ID and routes the initial workflow message to the matching
   * regional queue. When omitted, the world falls back to its own
   * default (for `world-vercel`: the `VERCEL_REGION` environment
   * variable, then the server-side default region `iad1` — a concrete,
   * routable region is always chosen).
   *
   * Worlds without a regional dimension ignore this field.
   */
  region?: string;

  /**
   * Plaintext attributes to seed on the run as it is created.
   *
   * Available for native-attributes runs (spec version 4 and later).
   */
  attributes?: Record<string, string>;

  /**
   * Permit reserved `$`-prefixed keys in `attributes`. The `$` namespace
   * is reserved for framework/library code built on top of the workflow
   * SDK (telemetry, agent metadata, platform-emitted tags, etc.); user
   * code MUST NOT write keys in it, and validation rejects them so
   * accidental collisions with tooling-owned keys can't slip through.
   *
   * Only flip this to `true` if your caller is itself a framework or
   * library that owns a `$`-prefixed sub-namespace and knows the
   * conventions of any other tools writing into it. Same semantics as
   * the `setAttributes` option of the same name.
   */
  allowReservedAttributes?: boolean;

  /**
   * The ID of an existing run this run is being replayed from, if any.
   *
   * Recorded on the new run's `executionContext` as `replayedFromRunId` so
   * tooling (e.g. the dashboard runs list) can show that a run originated as
   * a replay and link back to its source. Set automatically by
   * {@link recreateRunFromExisting}; there's usually no reason to pass it
   * directly.
   *
   * Must be a run ID: `wrun_` followed by a 26-char ULID. It's a foreign key
   * to the source run, so `start()` validates the exact shape and rejects
   * anything else rather than persist a lineage link that points at garbage.
   */
  replayedFromRunId?: string;
  /**
   * Queue namespace of the target deployment. Scopes the workflow queue
   * topic to `__{namespace}_wkf_workflow_*` (e.g. `'eve'`) instead of the
   * default `__wkf_workflow_*`, and is also used for the cross-deployment
   * capability probe. Falls back to `WORKFLOW_QUEUE_NAMESPACE` in the
   * calling process.
   *
   * Within a deployment the env fallback is correct. Cross-context callers
   * (e.g. the observability dashboard replaying a run) must pass the
   * TARGET deployment's namespace explicitly: the env fallback resolves in
   * the caller's process, and a run enqueued to a topic the target has no
   * consumer for is never picked up.
   */
  namespace?: string;
}

export interface StartOptionsWithDeploymentId extends StartOptionsBase {
  /**
   * The deployment ID to use for the workflow run.
   *
   * By default, this is automatically inferred from environment variables
   * when deploying to Vercel.
   *
   * Set to `'latest'` to automatically resolve the most recent deployment
   * for the current environment (same production target or git branch).
   * This is only meaningful in worlds with atomic, immutable deployments
   * (currently Vercel). In other worlds (local dev, Postgres) there is no
   * notion of multiple deployments to resolve between, so `'latest'` has no
   * effect — a warning is logged and the run targets the current deployment.
   *
   * **Note:** When `deploymentId` is provided, the argument and return types become `unknown`
   * since there is no guarantee the types will be consistent across deployments.
   */
  deploymentId: 'latest' | (string & {});
}

export interface StartOptionsWithoutDeploymentId extends StartOptionsBase {
  deploymentId?: undefined;
}

/**
 * Options for starting a workflow run.
 */
export type StartOptions =
  | StartOptionsWithDeploymentId
  | StartOptionsWithoutDeploymentId;

/**
 * Represents an imported workflow function.
 */
export type WorkflowFunction<TArgs extends unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult>;

/**
 * Represents the generated metadata of a workflow function.
 */
export type WorkflowMetadata = { workflowId: string };

/**
 * Starts a workflow run.
 *
 * @param workflow - The imported workflow function to start.
 * @param args - The arguments to pass to the workflow (optional).
 * @param options - The options for the workflow run (optional).
 * @returns The unique run ID for the newly started workflow invocation.
 */
// Overloads with deploymentId - args and return type become unknown
// Uses generics so typed workflows are assignable (avoids contravariance issues),
// but the return type and args are still unknown since the deployed version may differ.
export function start<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: unknown[],
  options: StartOptionsWithDeploymentId
): Promise<Run<unknown>>;

export function start<TResult>(
  workflow: WorkflowFunction<[], TResult> | WorkflowMetadata,
  options: StartOptionsWithDeploymentId
): Promise<Run<unknown>>;

// Overloads without deploymentId - preserve type inference
export function start<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  args: TArgs,
  options?: StartOptionsWithoutDeploymentId
): Promise<Run<TResult>>;

export function start<TResult>(
  workflow: WorkflowFunction<[], TResult> | WorkflowMetadata,
  options?: StartOptionsWithoutDeploymentId
): Promise<Run<TResult>>;

export async function start<TArgs extends unknown[], TResult>(
  workflow: WorkflowFunction<TArgs, TResult> | WorkflowMetadata,
  argsOrOptions?: TArgs | StartOptions,
  options?: StartOptions
) {
  'use step';
  // @ts-expect-error this field is added by our client transform
  const workflowName = workflow?.workflowId;
  if (!workflowName) {
    throw new WorkflowRuntimeError(
      `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`,
      { slug: 'start-invalid-workflow-function' }
    );
  }

  let args: Serializable[] = [];
  let opts: StartOptions = options ?? {};
  if (Array.isArray(argsOrOptions)) {
    args = argsOrOptions as Serializable[];
  } else if (typeof argsOrOptions === 'object') {
    opts = argsOrOptions;
  }
  const startHook = opts.hook && normalizeStartHook(opts.hook);
  const spanName = `workflow.start ${workflowDisplayName(workflowName)}`;

  return await waitedUntil(() => {
    return trace(spanName, async (span) => {
      span?.setAttributes({
        ...Attribute.WorkflowName(workflowName),
        ...Attribute.WorkflowOperation('start'),
        ...Attribute.WorkflowArgumentsCount(args.length),
      });

      const world = opts.world ?? (await getWorldLazy());
      assertWorldSupportsRuntimeProtocol(world);
      if (startHook !== undefined) {
        if (world.capabilities?.atomicStartHook?.active !== true) {
          throw atomicStartContractError(
            'The configured World does not support atomic start Hooks.'
          );
        }
        if (
          startHook.tokenRetentionUntil !== undefined &&
          world.capabilities?.hookRetention?.active !== true
        ) {
          throw atomicStartContractError(
            'The configured World does not support Hook retention.'
          );
        }
      }

      // Reject invalid input before deployment lookup or health-check I/O.
      const specVersion = opts.specVersion ?? world.specVersion;
      const v1Compat = isLegacySpecVersion(specVersion);
      if (
        startHook !== undefined &&
        specVersion < SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
      ) {
        throw atomicStartContractError(
          'Atomic start Hooks require a spec version with resilient run input.'
        );
      }

      const allowReservedAttributes = opts.allowReservedAttributes === true;
      let attributes: Record<string, string> | undefined;
      if (opts.attributes && Object.keys(opts.attributes).length > 0) {
        if (specVersion < SPEC_VERSION_SUPPORTS_ATTRIBUTES) {
          throw new WorkflowRuntimeError(
            'Initial workflow attributes require a World that supports spec version 4 or later.'
          );
        }
        // Creation cannot remove attributes, so reject non-string values.
        for (const [key, value] of Object.entries(opts.attributes)) {
          if (typeof value !== 'string') {
            throw new WorkflowRuntimeError(
              `Initial workflow attribute ${JSON.stringify(key)} must be a string value.`
            );
          }
        }
        const changes = normalizeAttributeChanges(opts.attributes, {
          allowReservedAttributes,
        });
        attributes = Object.fromEntries(
          changes.map(({ key, value }) => [key, value as string])
        );
      }

      // Child runs inherit the root and record their direct parent.
      const lineage =
        specVersion >= SPEC_VERSION_SUPPORTS_ATTRIBUTES
          ? resolveLineageAttributes()
          : undefined;
      const runAttributes = lineage
        ? { ...lineage, ...attributes }
        : attributes;
      const attributeSeed = runAttributes
        ? {
            attributes: runAttributes,
            ...(allowReservedAttributes || lineage
              ? { allowReservedAttributes: true as const }
              : {}),
          }
        : {};
      const startHookSeed = startHook ? { startHook } : {};

      // This is persisted as a foreign key to the source run.
      if (
        opts.replayedFromRunId !== undefined &&
        !workflowRunIdSchema.safeParse(opts.replayedFromRunId).success
      ) {
        throw new WorkflowRuntimeError(
          `replayedFromRunId must be a run ID (wrun_<ulid>); received ${JSON.stringify(
            String(opts.replayedFromRunId).slice(0, 64)
          )}.`
        );
      }
      // Pin the run to the VM engine selected when it starts.
      const workflowVm = getWorkflowVmFromEnv();

      const currentDeploymentId = await world.getDeploymentId();
      let deploymentId = opts.deploymentId ?? currentDeploymentId;

      // When 'latest' is requested, resolve the actual latest deployment ID
      // for the current deployment's environment (same production target or
      // same git branch for preview deployments).
      //
      // Resolving 'latest' only means something in worlds with atomic,
      // immutable deployments (e.g. Vercel), which implement
      // resolveLatestDeploymentId(). Worlds without that concept (local dev,
      // self-hosted Postgres) have nothing to resolve between, so rather than
      // fail a run that works fine on Vercel, we warn and fall back to the
      // current deployment — making 'latest' an effective no-op there.
      if (deploymentId === 'latest') {
        if (world.resolveLatestDeploymentId) {
          deploymentId = await world.resolveLatestDeploymentId();
        } else {
          // Warn once per process — see hasWarnedLatestNoOp above.
          if (!hasWarnedLatestNoOp) {
            hasWarnedLatestNoOp = true;
            runtimeLogger.warn(
              "deploymentId: 'latest' has no effect in this world and was ignored. " +
                'It is only supported by worlds with atomic deployments, such as Vercel. ' +
                'The run will target the current deployment.',
              { currentDeploymentId }
            );
          }
          deploymentId = currentDeploymentId;
        }
      }

      // Decide whether to write byte streams in the framed wire format.
      // For same-deployment starts (the common case) we know the target is
      // running this same SDK version, so framing is safe. For cross-
      // deployment starts (explicit deploymentId or 'latest' that resolves
      // to a different deployment) we probe the target via healthCheck to
      // learn its workflow-core version, then derive the capability. The
      // probe has a tight timeout — on miss/failure we fall back to the
      // legacy raw byte format, which is universally readable.
      //
      // Generate runId client-side so we have it before serialization
      // (required for future E2E encryption where runId is part of the
      // encryption context). When the World provides a `createRunId()`
      // implementation, use it so worlds can embed implementation-specific
      // metadata (e.g., region) into the ID, forwarding the full options
      // bag so worlds can read whichever fields they recognise; otherwise
      // fall back to a standard monotonic ULID.
      const runId = `wrun_${
        world.createRunId
          ? world.createRunId(opts as Readonly<Record<string, unknown>>)
          : ulid()
      }`;

      let framedByteStreams: boolean;
      let targetSupportsCompression: boolean;
      // The consumer's hook-resume protocol version, stamped onto the new run
      // so a later `resumeHook()` gates its parallel path on the deployment
      // that will actually consume the queue message. `undefined` means "could
      // not attest" and fails the gate closed.
      let targetHookResumeInputVersion: number | undefined;
      // Public key of the target run, when the capability probe was able to
      // supply one (cross-deployment only).
      let probedRunPublicKey: string | undefined;
      if (deploymentId === currentDeploymentId) {
        framedByteStreams = true;
        targetSupportsCompression = true;
        // Same deployment: this process is the consumer, so its own constant
        // is authoritative.
        targetHookResumeInputVersion = HOOK_RESUME_INPUT_VERSION;
      } else {
        // Ask for this run's public key while we're here. The probe already
        // blocks `start()` on every cross-deployment call, and the responder
        // executes inside the target deployment where the key material is
        // local — so the key comes back for free on a response we are
        // already awaiting, and we can skip the key-lookup API request
        // entirely. Best-effort: on timeout or an older target, no key comes
        // back and we fall through to the regular lookup below.
        const probe = await healthCheck(world, {
          deploymentId,
          runId,
          timeout: CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS,
          namespace: opts.namespace,
        }).catch(() => undefined);
        if (
          startHook &&
          probe?.capabilities?.atomicStartHook?.active !== true
        ) {
          throw atomicStartContractError(
            'The target deployment does not support atomic start Hooks.'
          );
        }
        if (
          startHook?.tokenRetentionUntil !== undefined &&
          probe?.capabilities?.hookRetention?.active !== true
        ) {
          throw atomicStartContractError(
            'The target deployment does not support Hook retention.'
          );
        }
        probedRunPublicKey = probe?.encryptionPublicKey;
        const capabilities = getRunCapabilities(probe?.workflowCoreVersion);
        framedByteStreams = capabilities.framedByteStreams;
        targetSupportsCompression = capabilities.supportedFormats.has(
          SerializationFormat.GZIP
        );
        // The responder runs inside the target deployment, so its
        // `hookResumeInputVersion` reflects the consumer. Undefined on an
        // older target or a probe timeout — leaving the marker off.
        targetHookResumeInputVersion = probe?.hookResumeInputVersion;
      }

      const ops: Promise<void>[] = [];

      // Serialize current trace context to propagate across queue boundary
      const traceCarrier = await serializeTraceCarrier();

      // Resolve encryption key for the new run. The runId has already been
      // generated above (client-generated ULID) and will be used for both
      // key derivation and the run_created event. The World implementation
      // uses the runId for per-run HKDF key derivation. We pass the resolved
      // deploymentId (not just the raw opts) so the World can use it for
      // key resolution even when deploymentId was inferred from the environment
      // rather than explicitly provided in opts (e.g., in e2e test runners).
      // Resolve how to encrypt the workflow arguments.
      //
      // Preferred: the capability probe already told us this run's public
      // key, so seal to it. That skips `getEncryptionKeyForRun`, which for a
      // cross-deployment start is a `run-key` API request — the last one left
      // on this path. It is also a privilege reduction: the caller ends up
      // able to write the arguments but not read them back, whereas fetching
      // the symmetric key grants full read access to a run it merely
      // launched.
      const probedPublicKey = decodeRunPublicKey(probedRunPublicKey);

      let encryptionKey: PayloadKey | undefined;
      let encryptionPublicKey: string | undefined;

      if (probedPublicKey) {
        encryptionKey = sealTo(probedPublicKey);
        encryptionPublicKey = probedRunPublicKey;
      } else {
        const rawKey = await world.getEncryptionKeyForRun?.(runId, {
          ...opts,
          deploymentId,
        });
        encryptionKey = rawKey ? await importKey(rawKey) : undefined;

        // Publish the run's X25519 public key so that cross-run writers (a
        // hook resumption from another deployment, a sibling writing into a
        // forwarded stream) can seal payloads *to* this run without holding
        // its symmetric key.
        //
        // Presence of this field is the writer-side gate for sealed
        // envelopes, so it must only be stamped when this runtime could
        // itself open one. That holds by construction here: derivation and
        // `encp` dispatch live in the same package, so any core that can
        // stamp can also open. Runs are pinned to their creating deployment,
        // so the capability this attests to is still accurate at resume time.
        encryptionPublicKey = rawKey
          ? bytesToBase64((await deriveRunKeyPair(rawKey)).publicKey)
          : undefined;
      }

      // Create run via run_created event (event-sourced architecture)
      // Pass client-generated runId - server will accept and use it
      // Compress workflow arguments only when the run itself is marked as
      // possibly containing compressed payloads (specVersion >= 5) AND the
      // target deployment can decode them (same-deployment, or probed
      // capability for cross-deployment starts).
      const compression =
        targetSupportsCompression &&
        specVersion >= SPEC_VERSION_SUPPORTS_COMPRESSION;
      const workflowArguments = await dehydrateWorkflowArguments(
        args,
        runId,
        encryptionKey,
        ops,
        globalThis,
        v1Compat,
        framedByteStreams,
        compression
      );
      // Admission can deliver the queue message before start() returns.
      safeWaitUntil(Promise.all(ops), (err) => {
        runtimeLogger.warn(
          'Background flush of workflow argument streams failed',
          {
            workflowRunId: runId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      });

      // The environment this caller's own `run_created` write is attributed
      // to. Stamped into the queue message's `runInput` (NOT into
      // `run_created`, whose tenant the backend already knows) so the
      // deployment that consumes the message can tell whether the run it is
      // being asked to resiliently create was created against a different
      // environment than its own.
      //
      // The two writes below go to different places by different routes:
      // `events.create` is attributed to THIS client's tenant, while the queue
      // message is pinned to a deploymentId. When those disagree — a
      // production-credentialed client pinning a preview deployment — the
      // preview consumer can't find the run in its own tenant, falls back to
      // resilient start, and re-creates it: one client-minted run id, two
      // environments, the production copy pending forever and the preview copy
      // executing. Worlds with a single tenant return undefined and the field
      // is simply absent.
      const creatorEnvironment = world.getEnvironment?.();

      const executionContext = {
        traceCarrier,
        workflowCoreVersion,
        features: { encryption: !!encryptionKey },
        // Attest that the *consumer* deployment's runtime re-ensures a
        // `hook_received` event from a queue message's `hookInput` on replay.
        // A resume of this run reads the marker (mirrored onto the hook's
        // resumeContext by the server) to decide whether the parallel fast
        // path is safe. For a cross-deployment start the consumer is the
        // target deployment, so we stamp the *target's* value carried back on
        // the health-check probe — never the caller's. Omitted when we could
        // not attest the target (older target, timeout, or no probe channel),
        // which fails the resume gate closed to the sequential path.
        ...(targetHookResumeInputVersion !== undefined
          ? { hookResumeInputVersion: targetHookResumeInputVersion }
          : {}),
        ...(workflowVm ? { workflowVm } : {}),
        ...(opts.replayedFromRunId
          ? { replayedFromRunId: opts.replayedFromRunId }
          : {}),
      };

      const runCreationData = {
        deploymentId,
        workflowName,
        input: workflowArguments,
        executionContext,
        ...(encryptionPublicKey ? { encryptionPublicKey } : {}),
        ...attributeSeed,
        ...startHookSeed,
      } satisfies RunCreationData;

      const runCreatedEvent = {
        eventType: 'run_created' as const,
        specVersion,
        eventData: runCreationData,
      };
      const queuePayload = {
        runId,
        traceCarrier,
        ...(specVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
          ? {
              runInput: {
                ...runCreationData,
                specVersion,
                ...(creatorEnvironment !== undefined
                  ? { environment: creatorEnvironment }
                  : {}),
              },
            }
          : {}),
      } satisfies WorkflowInvokePayload;
      const createRun = () =>
        world.events.create(runId, runCreatedEvent, { v1Compat });
      const enqueueRun = () =>
        world.queue(
          getWorkflowQueueName(workflowName, opts.namespace),
          queuePayload,
          {
            deploymentId,
            specVersion,
            ...(opts.region !== undefined ? { region: opts.region } : {}),
          }
        );

      let resilientStart = false;
      let createdRunStatus: WorkflowRunStatus | undefined;
      if (startHook) {
        try {
          await enqueueRun();
        } catch (error) {
          if (
            (error instanceof WorkflowWorldError ||
              WorkflowWorldError.is(error)) &&
            !isRetryableWorldError(error)
          ) {
            throw error;
          }
          throw new WorkflowStartError(runId, 'queue', error);
        }

        try {
          const result = await createRun();
          if (result.run.runId !== runId) {
            throw atomicStartContractError(
              `World admitted run "${result.run.runId}" for candidate "${runId}".`
            );
          }
          createdRunStatus = result.run.status;
        } catch (error) {
          if (HookConflictError.is(error)) {
            if (error.conflictingRunId === undefined) {
              throw atomicStartContractError(
                'Atomic start Hook conflicts must include conflictingRunId.'
              );
            }
            throw error;
          }
          if (EntityConflictError.is(error)) {
            throw atomicStartContractError(
              'Atomic start admission must replay the candidate decision instead of returning EntityConflictError.'
            );
          }
          if (
            (error instanceof WorkflowWorldError ||
              WorkflowWorldError.is(error)) &&
            !isRetryableWorldError(error)
          ) {
            throw error;
          }
          throw new WorkflowStartError(runId, 'admission', error);
        }
      } else {
        // Ordinary starts keep the existing parallel, resilient admission
        // behavior. Only atomic Hook starts require queue-first ordering.
        const [runCreatedResult, queueResult] = await Promise.allSettled([
          createRun(),
          enqueueRun(),
        ]);
        if (queueResult.status === 'rejected') {
          throw queueResult.reason;
        }
        if (runCreatedResult.status === 'rejected') {
          const err = runCreatedResult.reason;
          if (EntityConflictError.is(err)) {
            // The queued resilient start created this candidate first.
          } else if (isRetryableWorldError(err)) {
            resilientStart = true;
            runtimeLogger.warn(
              'Run creation event failed, but the run was accepted via the queue. ' +
                'The run_created event will be re-tried async by the runtime.',
              { workflowRunId: runId, error: err.message }
            );
          } else {
            throw err;
          }
        } else {
          const result = runCreatedResult.value;
          if (!v1Compat && result.run.runId !== runId) {
            throw new WorkflowRuntimeError(
              `Server returned different runId than requested: expected ${runId}, got ${result.run.runId}`
            );
          }
          createdRunStatus = result.run.status;
        }
      }

      span?.setAttributes({
        ...Attribute.WorkflowRunId(runId),
        ...Attribute.DeploymentId(deploymentId),
        ...(createdRunStatus
          ? Attribute.WorkflowRunStatus(createdRunStatus)
          : {}),
      });

      return new Run<TResult>(runId, { resilientStart });
    });
  });
}
