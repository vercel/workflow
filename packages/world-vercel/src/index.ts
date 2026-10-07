import type { World } from '@workflow/world';
import { mintedSpecVersion } from '@workflow/world';
import { createAnalytics } from './analytics.js';
import { createRunId, describeRun } from './create-run-id.js';
import { uploadDynamicWorkflowCode } from './dynamic-code.js';
import { createGetEncryptionKeyForRun } from './encryption.js';
import { validateRunExecutionContext } from './execution-context.js';
import { getDeadline } from './get-deadline.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue, recordStepExecution } from './queue.js';
import { createResolveLatestDeploymentId } from './resolve-latest-deployment.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import { type APIConfig, resolveClientEnvironment } from './utils.js';

export { createAnalytics } from './analytics.js';
export { createRunId, describeRun, regionForRunId } from './create-run-id.js';
export { uploadDynamicWorkflowCode } from './dynamic-code.js';
export {
  createGetEncryptionKeyForRun,
  deriveRunKey,
  fetchRunKey,
} from './encryption.js';
export {
  MAX_EXECUTION_CONTEXT_BYTES,
  validateRunExecutionContext,
} from './execution-context.js';
export { createQueue } from './queue.js';
export { createStorage } from './storage.js';
export { createStreamer } from './streamer.js';
export type { APIConfig } from './utils.js';
/**
 * Open a run's WebSocket events channel and return its release (or
 * `undefined` when the World writes over HTTP). Event writes for that run go
 * over the socket while at least one claim is held. The flow route already
 * does this for queue deliveries; call it yourself when you write a run's
 * events from anywhere else, and call the release when you are done, or the
 * open socket keeps the process alive.
 */
export { openWsChannel as openEventsChannel } from './ws-transport.js';

export function createWorld(config?: APIConfig): World {
  // Project ID for HKDF key derivation context.
  // Use config value first (set correctly by CLI/web), fall back to env var (runtime).
  const projectId =
    config?.projectConfig?.projectId || process.env.VERCEL_PROJECT_ID;
  // Read once: the runtime validates this declaration, and `run_started`
  // attests the same value (see `APIConfig.mintedSpecVersion`).
  const specVersion = mintedSpecVersion();
  config = { ...config, mintedSpecVersion: specVersion };

  return {
    // The version is what tells the backend which id scheme a run uses: it is
    // stamped on `run_created` and read back on every later write, so a run
    // created before spec 6 keeps its ULIDs for its whole life even though this
    // adapter now asks for slot-numbered ids.
    //
    // Declared as the runtime's current version rather than as the literal
    // version that introduced slots: a bump has to move this declaration with
    // it, or the runtime's compatibility floor rises past the adapter shipped
    // alongside it and rejects it (see `assertWorldSupportsRuntimeProtocol`).
    specVersion,
    capabilities: {
      hookRetention: { active: true },
      // Vercel Queues supports maxConcurrency-limited consumers: every run's
      // orchestrator messages go to a per-run topic consumed with
      // `maxConcurrency: 1` (see queue.ts and @workflow/builders).
      maxConcurrency: true,
      // The backend fences in-band writes on single-orchestrator runs: list
      // pages carry `snapshot`, and a stale in-band write gets 412
      // `in-band-superseded`, mapped to `InBandSupersededError` (events.ts).
      inBandFence: true,
      // The backend stores a single-orchestrator event's `occurredAt` as its
      // `createdAt` (clamped only for clock skew beyond an hour ahead or a
      // week behind), on creates and batch items alike, so run-ahead may
      // hand an outcome to the workflow before its write commits. The
      // runtime checks every speculative write's stored time anyway.
      inBandEventTime: true,
      // Vercel deployments are atomic and immutable, so a deployment id names
      // one fixed build for its whole lifetime.
      deploymentAffinity: true,
      // The server implements the takeover protocol behind
      // `createHook({ experimental_force: true })` (workflow-server
      // docs/hook-force-claim.md). Static rather than attested per lookup,
      // because the decision is made at `createHook()` time, before any
      // lookup; against a server that has it switched off (or predates it)
      // a forced creation is answered with `hook_conflict`, which the
      // runtime reports as an unsupported-World failure rather than a win.
      hookForceClaim: true,
      // Stored with the run (inline, or behind `uploadDynamicWorkflowCode`
      // for large definitions). The server refuses a dynamic `run_created`
      // for a project outside its rollout, so `start()` fails at the write.
      dynamicWorkflowCode: true,
      // NOTE: the backend half of resumeHook()'s lazy path (that
      // the server enforces the `(runId, resumeId)` dedup constraint) is
      // NO LONGER a static world capability here. It is attested per-lookup by
      // the server via `Hook.resumeCapabilities.hookResumeDedupVersion`
      // (response-only, recomputed every by-token read). This lets a server
      // rollback or kill switch drop new resumes to the sequential path
      // immediately, without a redeploy of this adapter.
    },
    validateRunExecutionContext,
    getRuntimeDeadline: getDeadline,
    ...createQueue(config),
    ...createStorage(config),
    // Analytics list reads are served from an eventually-ingested store.
    // Tooling that needs read-your-writes listings immediately after a
    // write (e.g. deterministic e2e assertions) can force the CLI/world
    // list paths back onto primary storage by disabling the namespace.
    analytics:
      process.env.WORKFLOW_DISABLE_ANALYTICS_READS === '1'
        ? undefined
        : createAnalytics(config),
    ...instrumentObject('world.streams', createStreamer(config)),
    createRunId,
    describeRun,
    // Reports the environment this client's writes land in, so `start()` can
    // stamp it into the queue message and the consuming deployment can detect
    // that it was handed a run created against a different environment.
    getEnvironment: () => resolveClientEnvironment(config),
    // Deferred storage for a dynamic run's workflow code, used only when the
    // definition is too large to ride the `run_created` frame inline.
    uploadDynamicWorkflowCode: (runId, params) =>
      uploadDynamicWorkflowCode(runId, params, config),
    getEncryptionKeyForRun: createGetEncryptionKeyForRun(
      projectId,
      config?.projectConfig?.teamId,
      config?.token,
      config?.dispatcher
    ),
    resolveLatestDeploymentId: createResolveLatestDeploymentId(config),
    telemetry: { recordStepExecution },
  };
}
