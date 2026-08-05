import type { World } from '@workflow/world';
import { SPEC_VERSION_SUPPORTS_COMPRESSION } from '@workflow/world';
import { createAnalytics } from './analytics.js';
import { createRunId, describeRun } from './create-run-id.js';
import { createGetEncryptionKeyForRun } from './encryption.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue } from './queue.js';
import { createResolveLatestDeploymentId } from './resolve-latest-deployment.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import { type APIConfig, resolveClientEnvironment } from './utils.js';

export { createAnalytics } from './analytics.js';
export { createRunId, describeRun, regionForRunId } from './create-run-id.js';
export {
  createGetEncryptionKeyForRun,
  deriveRunKey,
  fetchRunKey,
} from './encryption.js';
export { createQueue } from './queue.js';
export { createStorage } from './storage.js';
export { createStreamer } from './streamer.js';
export type { APIConfig } from './utils.js';

export function createWorld(config?: APIConfig): World {
  // Project ID for HKDF key derivation context.
  // Use config value first (set correctly by CLI/web), fall back to env var (runtime).
  const projectId =
    config?.projectConfig?.projectId || process.env.VERCEL_PROJECT_ID;

  return {
    // Spec v5 adds client-side zstd/gzip payload compression. The server stores
    // those payloads opaquely, and v5 remains a superset of v4 attributes.
    specVersion: SPEC_VERSION_SUPPORTS_COMPRESSION,
    capabilities: {
      // workflow-server enforces the `stateUpdatedAt` optimistic-concurrency
      // guard: creations carrying a stale snapshot are rejected with 412
      // (PreconditionFailedError) when the run's outside-event marker is
      // newer. See vercel/workflow-server#484.
      preconditionGuard: true,
      // workflow-server cooperates with resilient step dispatch under the
      // guard: a 412-rejected `step_created` records a dispatch-revocation
      // marker, and a consumer re-ensure marked `viaStepDispatch` is refused
      // with 410 for a revoked, never-created step. Lets the runtime keep the
      // parallel create+publish dispatch even where the guard is enforced.
      resilientStepDispatch: true,
      // Vercel Queues supports maxConcurrency-limited consumers, which
      // WORKFLOW_SEQUENTIAL_REPLAYS=1 uses for per-run `maxConcurrency: 1`
      // flow topics (see queue.ts and @workflow/builders).
      maxConcurrency: true,
      // NOTE: the backend half of resumeHook()'s parallel fast path — that
      // the server enforces the `(runId, resumeId)` dedup constraint — is
      // NO LONGER a static world capability here. It is attested per-lookup by
      // the server via `Hook.resumeCapabilities.hookResumeDedupVersion`
      // (response-only, recomputed every by-token read). This lets a server
      // rollback or kill switch drop new resumes to the sequential path
      // immediately, without a redeploy of this adapter.
    },
    // On Vercel the platform fails the function invocation when the
    // process exits non-zero, and VQS redelivers the queue message via a
    // fresh invocation. The core runtime uses this to decide whether
    // `process.exit(1)` is an acceptable response to an exhausted replay
    // budget.
    processExitTriggersQueueRedelivery: true,
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
    getEncryptionKeyForRun: createGetEncryptionKeyForRun(
      projectId,
      config?.projectConfig?.teamId,
      config?.token,
      config?.dispatcher
    ),
    resolveLatestDeploymentId: createResolveLatestDeploymentId(config),
  };
}
