import { EntityConflictError, WorkflowRuntimeError } from '@workflow/errors';
import { globalSingleton } from '@workflow/utils';
import { workflowDisplayName } from '@workflow/utils/parse-name';
import type {
  RunRetention,
  WorkflowInvokePayload,
  World,
} from '@workflow/world';
import {
  HOOK_RESUME_INPUT_VERSION,
  isLegacySpecVersion,
  PARENT_RUN_ID_ATTRIBUTE,
  RETENTION_ATTRIBUTE,
  ROOT_RUN_ID_ATTRIBUTE,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
  workflowRunIdSchema,
} from '@workflow/world';
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
import {
  getWorkflowQueueName,
  type HealthCheckResult,
  healthCheck,
} from './helpers.js';
import { Run } from './run.js';
import { getWorkflowVmFromEnv } from './vm-mode.js';
import { safeWaitUntil, waitedUntil } from './wait-until.js';
import { assertWorldSupportsRuntimeProtocol } from './world-compatibility.js';

/**
 * Timeout for the first cross-deployment capability probe to a deployment.
 * `healthCheck()` returns as soon as the target answers, so this budget is
 * only spent in full on a miss. It is generous because the probe is no
 * longer just an optimization: it carries the target's spec version, which
 * the run is stamped with (see `resolveCrossDeploymentSpecVersion`), and a
 * healthy target that is merely cold must not fall through to a guess.
 * Matches the budget `wf inspect` replay uses for the same probe.
 *
 * Only the first start to a deployment can pay it (see
 * `crossDeploymentProbeCache`): an answer is reused, and after a miss later
 * probes to that deployment get `CROSS_DEPLOYMENT_PROBE_RETRY_TIMEOUT_MS`.
 */
const CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS = 10_000;

/**
 * Probe budget for a deployment that already missed a probe in this process.
 * A target that predates the health check never answers, so without this
 * every start to it would wait the full first-probe budget.
 */
const CROSS_DEPLOYMENT_PROBE_RETRY_TIMEOUT_MS = 2_000;

/**
 * How long a probe result is reused for. A Vercel deployment is immutable
 * (its code, and the env that decides the spec version it mints), so an
 * answer cannot go stale there; the bound is for Worlds whose deployment ids
 * can be reused by a restarted process with different code.
 */
const CROSS_DEPLOYMENT_PROBE_CACHE_TTL_MS = 10 * 60_000;

/** Upper bound on cached deployments, oldest evicted first. */
const CROSS_DEPLOYMENT_PROBE_CACHE_MAX_ENTRIES = 256;

/**
 * Wire encoding of `retention: 0`. Attribute values are strings, and the
 * `$retention` value is a duration written as a decimal integer — so zero
 * travels as `'0'`, not as the name of a mode.
 */
const RETENTION_ZERO_ATTRIBUTE_VALUE = '0';

/**
 * Where a run's stamped spec version came from, recorded on the `start()`
 * span so "why is this run on spec N?" is answerable without reading code.
 */
export type SpecVersionSource =
  | 'same-deployment'
  | 'explicit'
  | 'probe'
  | 'probe-unversioned'
  | 'probe-malformed'
  | 'probe-miss'
  | 'no-probe-channel';

/**
 * The spec version to stamp on a run that another deployment will execute.
 *
 * A run's spec version is a promise about the runtime that reads and writes
 * its event log, and for a cross-deployment start that is the target, not
 * this caller. The capability probe runs inside the target and reports the
 * version the target itself mints (which already honours the target's own
 * `WORKFLOW_SEALED_LOG` switch), so that is the answer, capped at what this
 * caller's World mints: the caller writes `run_created` and the arguments,
 * and must never stamp a version it could not have written itself.
 *
 * When the target does not report a usable version:
 *
 * - a plain-text reply predates the versioned JSON health response, which
 *   arrived with spec 3 (CBOR queue transport), so it is stamped as
 *   event-sourced: such a target cannot read a CBOR `runInput`.
 * - a JSON reply without a usable `specVersion` still proves the target is
 *   at spec 3 or later, so it is stamped with CBOR queue transport rather
 *   than losing it (and resilient start with it) to a malformed field.
 * - a probe that times out, or no probe channel at all, is a guess.
 *   `SPEC_VERSION_SUPPORTS_SLOT_IDENTITY` is the lowest version a v5 runtime
 *   can execute on the Vercel World (it requires slot event ids), so it is
 *   the only floor that keeps same-major targets working. It is NOT safe for
 *   an older-major target such as `stable` (spec 3): that target rejects the
 *   run when it picks it up. No single floor serves both, which is why the
 *   probe budget is generous; the miss is logged and recorded on the span.
 *
 * Once executors attest their version on `run_started` and the backend
 * raises a run to it (vercel/workflow#4366, vercel/workflow-server#1044), a
 * v5 target heals an under-stamped run, and this miss floor can drop to
 * `SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT` with a short budget. Tracked
 * in vercel/workflow#4401.
 *
 * Exported for tests.
 */
export function resolveCrossDeploymentSpecVersion(
  probe:
    | Pick<HealthCheckResult, 'healthy' | 'specVersion' | 'format'>
    | undefined,
  callerSpecVersion: number
): { specVersion: number; source: SpecVersionSource } {
  let target: number;
  let source: SpecVersionSource;
  if (
    typeof probe?.specVersion === 'number' &&
    Number.isInteger(probe.specVersion) &&
    probe.specVersion >= 1
  ) {
    target = probe.specVersion;
    source = 'probe';
  } else if (probe?.format === 'json') {
    target = SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT;
    source = 'probe-malformed';
  } else if (probe?.healthy) {
    target = SPEC_VERSION_SUPPORTS_EVENT_SOURCING;
    source = 'probe-unversioned';
  } else {
    target = SPEC_VERSION_SUPPORTS_SLOT_IDENTITY;
    source = probe ? 'probe-miss' : 'no-probe-channel';
  }
  return { specVersion: Math.min(target, callerSpecVersion), source };
}

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
// On `globalThis` (see `globalSingleton`) so "once per process" is not once
// per bundler layer.
const latestNoOpWarning = globalSingleton(
  '@workflow/core//latestNoOpWarning',
  1,
  () => ({ warned: false })
);

/**
 * Reset the `deploymentId: 'latest'` no-op warn-once guard. Test-only,
 * exported so unit tests can exercise the warn path across `start()` calls.
 *
 * @internal
 */
export function _resetLatestNoOpWarnForTests(): void {
  latestNoOpWarning.warned = false;
}

// A missed cross-deployment probe stamps the run with a guessed spec version
// for its whole life, so say so, but once per process: a target that never
// answers (e.g. one predating the health check) would otherwise log on
// every `start()`. The span attributes record every occurrence.
const probeMissWarning = globalSingleton(
  '@workflow/core//crossDeploymentProbeMissWarning',
  1,
  () => ({ warned: false })
);

/**
 * Reset the cross-deployment probe-miss warn-once guard. Test-only.
 *
 * @internal
 */
export function _resetProbeMissWarnForTests(): void {
  probeMissWarning.warned = false;
}

type CrossDeploymentProbeCacheEntry = {
  at: number;
  /** The last answer from the deployment, or undefined after a miss. */
  probe: HealthCheckResult | undefined;
};

/**
 * Per-process record of what each target deployment answered, so only the
 * first cross-deployment start to a deployment waits on its probe. What the
 * probe reports (spec version, core version, hook-resume version) is fixed
 * for a deployment, so an answer is reused outright. That skips the probe,
 * and the run's public key it would have carried is fetched by the regular
 * key lookup instead. A miss is remembered too, so later probes to that
 * deployment get the short retry budget.
 *
 * Keyed by World (a World instance scopes the deployments it can see), then
 * by deployment and queue namespace.
 */
const crossDeploymentProbeCache = globalSingleton(
  '@workflow/core//crossDeploymentProbeCache',
  1,
  () => new WeakMap<World, Map<string, CrossDeploymentProbeCacheEntry>>()
);

async function probeCrossDeployment(
  world: World,
  options: { deploymentId: string; runId: string; namespace?: string }
): Promise<{ probe: HealthCheckResult | undefined; cached: boolean }> {
  let byDeployment = crossDeploymentProbeCache.get(world);
  if (!byDeployment) {
    byDeployment = new Map();
    crossDeploymentProbeCache.set(world, byDeployment);
  }
  const key = `${options.namespace ?? ''}\0${options.deploymentId}`;
  const now = Date.now();
  const entry = byDeployment.get(key);
  const fresh =
    entry !== undefined && now - entry.at < CROSS_DEPLOYMENT_PROBE_CACHE_TTL_MS;
  if (fresh && entry.probe) {
    return { probe: entry.probe, cached: true };
  }

  const probe = await healthCheck(world, {
    deploymentId: options.deploymentId,
    runId: options.runId,
    timeout: fresh
      ? CROSS_DEPLOYMENT_PROBE_RETRY_TIMEOUT_MS
      : CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS,
    namespace: options.namespace,
  }).catch(() => undefined);

  const answered = probe?.format !== undefined;
  byDeployment.delete(key);
  byDeployment.set(key, {
    at: Date.now(),
    // The run public key is per run, so it is never reused.
    probe: answered ? { ...probe, encryptionPublicKey: undefined } : undefined,
  });
  if (byDeployment.size > CROSS_DEPLOYMENT_PROBE_CACHE_MAX_ENTRIES) {
    const oldest = byDeployment.keys().next().value;
    if (oldest !== undefined) byDeployment.delete(oldest);
  }
  return { probe, cached: false };
}

export interface StartOptionsBase {
  /**
   * The world to use for the workflow run creation,
   * by default the world is inferred from the environment variables.
   */
  world?: World;

  /**
   * The spec version to use for the workflow run. Defaults to the spec
   * version of the deployment that will execute the run: the configured
   * World's for a same-deployment start, and for a cross-deployment start
   * (`deploymentId` naming another deployment) the version the target
   * reports on its capability probe, capped at the configured World's.
   */
  specVersion?: number;

  /**
   * Optional region identifier for the new run. Currently consumed only
   * by `@workflow/world-vercel`, which embeds the region into the tagged
   * run ID and routes the initial workflow message to the matching
   * regional queue. When omitted, the world falls back to its own
   * default (for `world-vercel`: the `VERCEL_REGION` environment
   * variable, then the server-side default region `iad1`; a concrete,
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
   * Set a preference for data retention after run completion.
   *
   * **Experimental.** Both the unit and the set of accepted values are expected
   * to change.
   *
   * Worlds control the retention of user data (event payloads and stream
   * chunks), the event log, and any analytics data. Options are:
   * - `'default'`: same as omission, the World will decide. On Vercel, this
   *   is based on your team's plan.
   * - `0`: data is deleted as soon as your run completes or fails. On
   *   Vercel, user data is deleted, but metadata may persist for your plan's
   *   default retention period.
   *
   * The value is a duration, with zero being the only valid option currently.
   *
   * **Known limitation at `0`.** The purge races your own read of the run's
   * result and generally wins, so `await run.returnValue` on a
   * `experimental_retention: 0` run usually throws `RunExpiredError` rather
   * than resolving. If you need the result, return it through a channel you
   * control, e.g. a step that writes it to external storage.
   *
   * Recorded on the run as the reserved `$retention` attribute, so it
   * requires a World implementing spec version 4 or later. `'default'` is
   * not written at all, keeping it exactly equivalent to omitting the
   * option. Retention is enforced by the World: the first-party Worlds
   * (Vercel, Local, Postgres) implement it, and a World that does not
   * recognize the value keeps the data.
   */
  experimental_retention?: RunRetention;

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
   * effect: a warning is logged and the run targets the current deployment.
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
  return await waitedUntil(() => {
    // @ts-expect-error this field is added by our client transform
    const workflowName = workflow?.workflowId;

    if (!workflowName) {
      throw new WorkflowRuntimeError(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`,
        { slug: 'start-invalid-workflow-function' }
      );
    }

    const spanName = `workflow.start ${workflowDisplayName(workflowName)}`;
    return trace(spanName, async (span) => {
      span?.setAttributes({
        ...Attribute.WorkflowName(workflowName),
        ...Attribute.WorkflowOperation('start'),
      });

      let args: Serializable[] = [];
      let opts: StartOptions = options ?? {};
      if (Array.isArray(argsOrOptions)) {
        args = argsOrOptions as Serializable[];
      } else if (typeof argsOrOptions === 'object') {
        opts = argsOrOptions;
      }

      span?.setAttributes({
        ...Attribute.WorkflowArgumentsCount(args.length),
      });

      const world = opts.world ?? (await getWorldLazy());
      assertWorldSupportsRuntimeProtocol(world);
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
      // current deployment, making 'latest' an effective no-op there.
      if (deploymentId === 'latest') {
        if (world.resolveLatestDeploymentId) {
          deploymentId = await world.resolveLatestDeploymentId();
        } else {
          // Warn once per process; see latestNoOpWarning.warned above.
          if (!latestNoOpWarning.warned) {
            latestNoOpWarning.warned = true;
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
      // probe has a tight timeout: on miss/failure we fall back to the
      // legacy raw byte format, which is universally readable.
      //
      // Worlds that don't expose the `streams` API (e.g. minimal test
      // mocks) can't service health checks, so we skip the probe for them.
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
      // The consumer's hook-resume protocol version, stamped onto the new
      // run. Current producers write the hook_received event durably before
      // publishing the wake and never read it; OLDER producers gate their
      // lazy (hookInput-carrying) path on the deployment that will actually
      // consume the queue message. `undefined` means "could not attest" and
      // fails that gate closed.
      let targetHookResumeInputVersion: number | undefined;
      // Public key of the target run, when the capability probe was able to
      // supply one (cross-deployment only).
      let probedRunPublicKey: string | undefined;
      // The spec version of the runtime that will execute this run: this
      // process for a same-deployment start, the target (as reported by the
      // probe) otherwise. See `resolveCrossDeploymentSpecVersion`.
      let targetSpecVersion: number;
      let specVersionSource: SpecVersionSource;
      const crossDeployment = deploymentId !== currentDeploymentId;
      if (!crossDeployment) {
        framedByteStreams = true;
        targetSupportsCompression = true;
        // Same deployment: this process is the consumer, so its own constant
        // is authoritative.
        targetHookResumeInputVersion = HOOK_RESUME_INPUT_VERSION;
        targetSpecVersion = world.specVersion;
        specVersionSource = 'same-deployment';
      } else if (typeof world.streams?.get !== 'function') {
        framedByteStreams = false;
        targetSupportsCompression = false;
        // No probe channel to the target, so we cannot attest the consumer
        // honors `hookInput`; leave the marker off (older producers fail
        // closed to their sequential path).
        targetHookResumeInputVersion = undefined;
        // Nor its spec version: no probe result to resolve from.
        ({ specVersion: targetSpecVersion, source: specVersionSource } =
          resolveCrossDeploymentSpecVersion(undefined, world.specVersion));
      } else {
        // Ask for this run's public key while we're here. The probe already
        // blocks `start()` on every cross-deployment call, and the responder
        // executes inside the target deployment where the key material is
        // local, so the key comes back for free on a response we are
        // already awaiting, and we can skip the key-lookup API request
        // entirely. Best-effort: on timeout or an older target, no key comes
        // back and we fall through to the regular lookup below.
        const { probe, cached } = await probeCrossDeployment(world, {
          deploymentId,
          runId,
          namespace: opts.namespace,
        });
        probedRunPublicKey = probe?.encryptionPublicKey;
        const capabilities = getRunCapabilities(probe?.workflowCoreVersion);
        framedByteStreams = capabilities.framedByteStreams;
        targetSupportsCompression = capabilities.supportedFormats.has(
          SerializationFormat.GZIP
        );
        // The responder runs inside the target deployment, so its
        // `hookResumeInputVersion` reflects the consumer. Undefined on an
        // older target or a probe timeout, leaving the marker off.
        targetHookResumeInputVersion = probe?.hookResumeInputVersion;
        ({ specVersion: targetSpecVersion, source: specVersionSource } =
          resolveCrossDeploymentSpecVersion(probe, world.specVersion));
        span?.setAttributes({
          ...Attribute.WorkflowCapabilityProbeCached(cached),
          ...(!cached && probe?.latencyMs !== undefined
            ? Attribute.WorkflowCapabilityProbeLatencyMs(probe.latencyMs)
            : {}),
          ...(!cached && probe?.error
            ? Attribute.WorkflowCapabilityProbeError(probe.error)
            : {}),
        });
        if (
          specVersionSource === 'probe-miss' &&
          opts.specVersion === undefined &&
          !probeMissWarning.warned
        ) {
          probeMissWarning.warned = true;
          runtimeLogger.warn(
            'The target deployment did not answer the capability probe, so ' +
              'the run was stamped with a fallback spec version instead of ' +
              "the target's own. A target on an older major version may not " +
              'be able to execute it.',
            {
              deploymentId,
              specVersion: targetSpecVersion,
              error: probe?.error,
            }
          );
        }
      }

      const ops: Promise<void>[] = [];

      // Serialize current trace context to propagate across queue boundary
      const traceCarrier = await serializeTraceCarrier();

      // Default new runs to the spec version of the deployment that will
      // execute them: the configured world's for a same-deployment start
      // (the world itself has already been checked against this runtime's
      // spec version), the probed target's for a cross-deployment one. An
      // explicit `specVersion` still wins.
      const specVersion = opts.specVersion ?? targetSpecVersion;
      if (opts.specVersion !== undefined) specVersionSource = 'explicit';
      span?.setAttributes({
        ...Attribute.WorkflowRunSpecVersion(specVersion),
        ...Attribute.WorkflowRunSpecVersionSource(specVersionSource),
      });
      // Once a probe can lower the version, a failed gate below is about the
      // target deployment, not this caller's World: say so.
      const specGateError = (featureRequires: string) =>
        new WorkflowRuntimeError(
          crossDeployment && opts.specVersion === undefined
            ? `${featureRequires} spec version ${SPEC_VERSION_SUPPORTS_ATTRIBUTES} or later, but the target deployment (${deploymentId}) runs spec version ${specVersion}.`
            : `${featureRequires} a World that supports spec version ${SPEC_VERSION_SUPPORTS_ATTRIBUTES} or later.`
        );
      const v1Compat = isLegacySpecVersion(specVersion);
      const allowReservedAttributes = opts.allowReservedAttributes === true;
      let attributes: Record<string, string> | undefined;
      if (opts.attributes && Object.keys(opts.attributes).length > 0) {
        if (specVersion < SPEC_VERSION_SUPPORTS_ATTRIBUTES) {
          throw specGateError('Initial workflow attributes require');
        }
        // `normalizeAttributeChanges` treats `undefined` as "remove this
        // key", which is meaningless at creation time. Reject it up front
        // so JS callers get a clear error instead of a downstream schema
        // failure (the types already forbid non-string values).
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

      // `retention` is the typed spelling of the reserved `$retention`
      // attribute, whose value is a duration written as a decimal integer.
      // `'default'` means "let the World decide", which is already what an
      // absent attribute means, so it is not written: that keeps
      // `'default'` exactly equivalent to omitting the option and spends
      // none of the per-run attribute budget.
      let retentionAttribute: Record<string, string> | undefined;
      if (
        opts.experimental_retention !== undefined &&
        opts.experimental_retention !== 'default'
      ) {
        // The types allow only `0`, but an untyped JS caller can still get
        // here with some other duration — and there is no unit to interpret
        // it in yet, so no World can honor it. Reject it rather than seed a
        // value that would silently resolve to the World's default.
        if (opts.experimental_retention !== 0) {
          throw new WorkflowRuntimeError(
            `start({ experimental_retention }) must be 0 or 'default'; received ${JSON.stringify(
              opts.experimental_retention
            )}.`
          );
        }
        if (specVersion < SPEC_VERSION_SUPPORTS_ATTRIBUTES) {
          throw specGateError('start({ experimental_retention }) requires');
        }
        retentionAttribute = {
          [RETENTION_ATTRIBUTE]: RETENTION_ZERO_ATTRIBUTE_VALUE,
        };
      }

      // Cross-run lineage: the reserved keys ride on the run's existing
      // attributes, so they add no extra write. Caller attributes are spread
      // last, so a caller with allowReservedAttributes can deliberately
      // re-parent. `retention` is spread after those: it is the supported
      // spelling, so it wins over a hand-written `$retention` attribute.
      const lineage =
        specVersion >= SPEC_VERSION_SUPPORTS_ATTRIBUTES
          ? resolveLineageAttributes()
          : undefined;
      const runAttributes =
        lineage || retentionAttribute
          ? { ...lineage, ...attributes, ...retentionAttribute }
          : attributes;

      // Shared by the run_created event and the resilient-start queue input.
      const attributeSeed = runAttributes
        ? {
            attributes: runAttributes,
            ...(allowReservedAttributes ||
            lineage != null ||
            retentionAttribute != null
              ? { allowReservedAttributes: true as const }
              : {}),
          }
        : {};

      // `replayedFromRunId` is a foreign key to the source run; reject anything
      // that isn't a real run ID so the lineage link can't point at garbage.
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
      // cross-deployment start is a `run-key` API request, the last one left
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

      // The environment this caller's own `run_created` write is attributed
      // to. Stamped into the queue message's `runInput` (NOT into
      // `run_created`, whose tenant the backend already knows) so the
      // deployment that consumes the message can tell whether the run it is
      // being asked to resiliently create was created against a different
      // environment than its own.
      //
      // The two writes below go to different places by different routes:
      // `events.create` is attributed to THIS client's tenant, while the queue
      // message is pinned to a deploymentId. When those disagree (a
      // production-credentialed client pinning a preview deployment) the
      // preview consumer can't find the run in its own tenant, falls back to
      // resilient start, and re-creates it: one client-minted run id, two
      // environments, the production copy pending forever and the preview copy
      // executing. Worlds with a single tenant return undefined and the field
      // is absent.
      const creatorEnvironment = world.getEnvironment?.();

      // If WORKFLOW_VM is set on the client starting the run, stamp the
      // engine choice into the run's executionContext so the run keeps
      // executing on the engine it started on (the same deployment can
      // serve both VM engines). Unknown values throw; see
      // getWorkflowVmFromEnv().
      const workflowVm = getWorkflowVmFromEnv();

      const executionContext = {
        traceCarrier,
        workflowCoreVersion,
        features: { encryption: !!encryptionKey },
        // Attest that the *consumer* deployment's runtime re-ensures a
        // `hook_received` event from a queue message's `hookInput` on replay.
        // An OLDER producer resuming this run reads the marker (mirrored onto
        // the hook's resumeContext by the server) to decide whether its lazy
        // fast path is safe. For a cross-deployment start the consumer is the
        // target deployment, so we stamp the *target's* value carried back on
        // the health-check probe, never the caller's. Omitted when we could
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

      // Call events.create (run_created) and queue in parallel.
      // If events.create fails with 429/5xx, the run was still accepted
      // via the queue and creation will be re-tried async by the runtime.
      const [runCreatedResult, queueResult] = await Promise.allSettled([
        world.events.create(
          runId,
          {
            eventType: 'run_created',
            specVersion,
            eventData: {
              deploymentId: deploymentId,
              workflowName: workflowName,
              input: workflowArguments,
              executionContext,
              ...(encryptionPublicKey ? { encryptionPublicKey } : {}),
              ...attributeSeed,
            },
          },
          { v1Compat }
        ),
        world.queue(
          getWorkflowQueueName(workflowName, opts.namespace),
          {
            runId,
            traceCarrier,
            ...(specVersion >= SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
              ? {
                  runInput: {
                    input: workflowArguments,
                    deploymentId,
                    workflowName,
                    specVersion,
                    executionContext,
                    ...(encryptionPublicKey ? { encryptionPublicKey } : {}),
                    ...(creatorEnvironment !== undefined
                      ? { environment: creatorEnvironment }
                      : {}),
                    ...attributeSeed,
                  },
                }
              : {}),
          } satisfies WorkflowInvokePayload,
          {
            deploymentId,
            specVersion,
            // Forward any caller-supplied region hint so worlds with
            // per-region queue routing (e.g. world-vercel) can target the
            // matching queue. Worlds without a regional dimension ignore
            // this field.
            ...(opts.region !== undefined ? { region: opts.region } : {}),
          }
        ),
      ]);

      // Queue failure is always fatal: the run was not enqueued
      if (queueResult.status === 'rejected') {
        throw queueResult.reason;
      }

      // Handle events.create result
      let resilientStart = false;
      if (runCreatedResult.status === 'rejected') {
        const err = runCreatedResult.reason;
        if (EntityConflictError.is(err)) {
          // 409: The run already exists. This can happen in extreme cases where
          // the run creation call gets a cold start or other slowdown, and the queue
          // + run_started call completes faster. We expect this to be <=1% of cases.
          // In this case, we can safely return.
        } else if (isRetryableWorldError(err)) {
          // 429 (ThrottleError), 5xx, and transient transport failures
          // (TRANSPORT/TIMEOUT) are retryable: the run was accepted via the
          // queue and creation will be re-tried by the runtime when it calls
          // run_started.
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
        // Verify server accepted our runId
        if (!v1Compat && result.run.runId !== runId) {
          throw new WorkflowRuntimeError(
            `Server returned different runId than requested: expected ${runId}, got ${result.run.runId}`
          );
        }
      }

      // These argument-stream ops are flushed in the background; the promise
      // handed to waitUntil must never reject (an unconsumed waitUntil
      // rejection crashes the process as unhandledRejection), so unexpected
      // failures are logged instead.
      safeWaitUntil(Promise.all(ops), (err) => {
        runtimeLogger.warn(
          'Background flush of workflow argument streams failed',
          {
            workflowRunId: runId,
            error: err instanceof Error ? err.message : String(err),
          }
        );
      });

      span?.setAttributes({
        ...Attribute.WorkflowRunId(runId),
        ...Attribute.DeploymentId(deploymentId),
        ...(runCreatedResult.status === 'fulfilled'
          ? Attribute.WorkflowRunStatus(runCreatedResult.value.run.status)
          : {}),
      });

      return new Run<TResult>(runId, { resilientStart });
    });
  });
}
