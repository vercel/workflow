import {
  EntityConflictError,
  ThrottleError,
  WorkflowRuntimeError,
  WorkflowWorldError,
} from '@workflow/errors';
import { workflowDisplayName } from '@workflow/utils/parse-name';
import type { WorkflowInvokePayload, World } from '@workflow/world';
import {
  isLegacySpecVersion,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_COMPRESSION,
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { normalizeAttributeChanges } from '../attribute-changes.js';
import { getRunCapabilities } from '../capabilities.js';
import { importKey } from '../encryption.js';
import { runtimeLogger } from '../logger.js';
import type { Serializable } from '../schemas.js';
import {
  dehydrateWorkflowArguments,
  SerializationFormat,
} from '../serialization.js';
import * as Attribute from '../telemetry/semantic-conventions.js';
import { serializeTraceCarrier, trace } from '../telemetry.js';
import { version as workflowCoreVersion } from '../version.js';
import { getWorldLazy } from './get-world-lazy.js';
import { getWorkflowQueueName, healthCheck } from './helpers.js';
import { Run } from './run.js';
import { safeWaitUntil, waitedUntil } from './wait-until.js';

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

export interface StartOptionsBase {
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
   * the `experimental_setAttributes` option of the same name.
   */
  allowReservedAttributes?: boolean;
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

      const world = opts?.world ?? (await getWorldLazy());
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
      // Worlds that don't expose the `streams` API (e.g. minimal test
      // mocks) can't service health checks, so we skip the probe for them.
      let framedByteStreams: boolean;
      let targetSupportsCompression: boolean;
      if (deploymentId === currentDeploymentId) {
        framedByteStreams = true;
        targetSupportsCompression = true;
      } else if (typeof world.streams?.get !== 'function') {
        framedByteStreams = false;
        targetSupportsCompression = false;
      } else {
        const probe = await healthCheck(world, 'workflow', {
          deploymentId,
          timeout: CROSS_DEPLOYMENT_CAPABILITY_PROBE_TIMEOUT_MS,
        }).catch(() => undefined);
        const capabilities = getRunCapabilities(probe?.workflowCoreVersion);
        framedByteStreams = capabilities.framedByteStreams;
        targetSupportsCompression = capabilities.supportedFormats.has(
          SerializationFormat.GZIP
        );
      }

      const ops: Promise<void>[] = [];

      // Generate runId client-side so we have it before serialization
      // (required for future E2E encryption where runId is part of the encryption context)
      const runId = `wrun_${ulid()}`;

      // Serialize current trace context to propagate across queue boundary
      const traceCarrier = await serializeTraceCarrier();

      // Use world-declared specVersion when available (our worlds set this),
      // otherwise fall back to the safe baseline that community worlds handle.
      // Community worlds built against older @workflow/world reject runs with
      // specVersion > their SPEC_VERSION_CURRENT via requiresNewerWorld().
      const specVersion =
        opts.specVersion ??
        world.specVersion ??
        SPEC_VERSION_SUPPORTS_EVENT_SOURCING;
      const v1Compat = isLegacySpecVersion(specVersion);
      const allowReservedAttributes = opts.allowReservedAttributes === true;
      let attributes: Record<string, string> | undefined;
      if (opts.attributes && Object.keys(opts.attributes).length > 0) {
        if (specVersion < SPEC_VERSION_SUPPORTS_ATTRIBUTES) {
          throw new WorkflowRuntimeError(
            'Initial workflow attributes require a World that supports spec version 4 or later.'
          );
        }
        // `normalizeAttributeChanges` treats `undefined` as "remove this
        // key", which is meaningless at creation time — reject it up front
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
      // Seed payload shared by run_created and the resilient-start queue
      // input. The flag rides along so server-side validation matches the
      // client-side check above on both paths.
      const attributeSeed = attributes
        ? {
            attributes,
            ...(allowReservedAttributes
              ? { allowReservedAttributes: true as const }
              : {}),
          }
        : {};

      // Resolve encryption key for the new run. The runId has already been
      // generated above (client-generated ULID) and will be used for both
      // key derivation and the run_created event. The World implementation
      // uses the runId for per-run HKDF key derivation. We pass the resolved
      // deploymentId (not just the raw opts) so the World can use it for
      // key resolution even when deploymentId was inferred from the environment
      // rather than explicitly provided in opts (e.g., in e2e test runners).
      const rawKey = await world.getEncryptionKeyForRun?.(runId, {
        ...opts,
        deploymentId,
      });
      const encryptionKey = rawKey ? await importKey(rawKey) : undefined;

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

      const executionContext = {
        traceCarrier,
        workflowCoreVersion,
        features: { encryption: !!encryptionKey },
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
              ...attributeSeed,
            },
          },
          { v1Compat }
        ),
        world.queue(
          getWorkflowQueueName(workflowName),
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
                    ...attributeSeed,
                  },
                }
              : {}),
          } satisfies WorkflowInvokePayload,
          {
            deploymentId,
            specVersion,
          }
        ),
      ]);

      // Queue failure is always fatal — the run was not enqueued
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
        } else if (isRetryableStartError(err)) {
          // 429 (ThrottleError) and 5xx (WorkflowWorldError with status >= 500)
          // are retryable — the run was accepted via the queue and creation
          // will be re-tried by the runtime when it calls run_started.
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
        // Assert that the run was created
        if (!result.run) {
          throw new WorkflowRuntimeError(
            "Missing 'run' in server response for 'run_created' event"
          );
        }

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
        ...(runCreatedResult.status === 'fulfilled' &&
        runCreatedResult.value.run
          ? Attribute.WorkflowRunStatus(runCreatedResult.value.run.status)
          : {}),
      });

      return new Run<TResult>(runId, { resilientStart });
    });
  });
}

/**
 * Checks if an error from events.create (run_created) is retryable,
 * meaning the queue can re-try creation later via the run_started path.
 * - ThrottleError (429): rate limited, will succeed later
 * - WorkflowWorldError with status >= 500: server error, will succeed later
 */
function isRetryableStartError(err: unknown): boolean {
  if (ThrottleError.is(err)) return true;
  if (WorkflowWorldError.is(err) && err.status && err.status >= 500)
    return true;
  return false;
}
