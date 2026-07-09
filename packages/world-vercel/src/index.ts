import type { World } from '@workflow/world';
import { SPEC_VERSION_SUPPORTS_COMPRESSION } from '@workflow/world';
import { createAnalytics } from './analytics.js';
import { createGetEncryptionKeyForRun } from './encryption.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue } from './queue.js';
import { createResolveLatestDeploymentId } from './resolve-latest-deployment.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export { createAnalytics } from './analytics.js';
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
    // Spec v5: new runs may carry gzip-compressed payloads (compression is
    // entirely client-side — the workflow-server stores payloads opaquely
    // via RemoteRef and never deserializes them). Spec 5 is a superset of
    // spec 4, so native `attr_set` events and initial run attributes still
    // work. New runs are stamped with this version; the server must support
    // at least it — workflow-server declared spec-5 support in
    // vercel/workflow-server#520.
    specVersion: SPEC_VERSION_SUPPORTS_COMPRESSION,
    // On Vercel the platform fails the function invocation when the
    // process exits non-zero, and VQS redelivers the queue message via a
    // fresh invocation. The core runtime uses this to decide whether
    // `process.exit(1)` is an acceptable response to an exhausted replay
    // budget.
    processExitTriggersQueueRedelivery: true,
    ...createQueue(config),
    ...createStorage(config),
    analytics: createAnalytics(config),
    ...instrumentObject('world.streams', createStreamer(config)),
    getEncryptionKeyForRun: createGetEncryptionKeyForRun(
      projectId,
      config?.projectConfig?.teamId,
      config?.token,
      config?.dispatcher
    ),
    resolveLatestDeploymentId: createResolveLatestDeploymentId(config),
  };
}

/**
 * @deprecated Use `createWorld()` instead.
 */
export function createVercelWorld(config?: APIConfig): World {
  return createWorld(config);
}
