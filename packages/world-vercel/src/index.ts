import type { World } from '@workflow/world';
import { SPEC_VERSION_SUPPORTS_ATTRIBUTES } from '@workflow/world';
import { createGetEncryptionKeyForRun } from './encryption.js';
import { instrumentObject } from './instrumentObject.js';
import { createQueue } from './queue.js';
import { createResolveLatestDeploymentId } from './resolve-latest-deployment.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export {
  createGetEncryptionKeyForRun,
  deriveRunKey,
  fetchRunKey,
} from './encryption.js';
export { createQueue } from './queue.js';
export { createStorage } from './storage.js';
export { createStreamer } from './streamer.js';
export type { APIConfig } from './utils.js';

export function createVercelWorld(config?: APIConfig): World {
  // Project ID for HKDF key derivation context.
  // Use config value first (set correctly by CLI/web), fall back to env var (runtime).
  const projectId =
    config?.projectConfig?.projectId || process.env.VERCEL_PROJECT_ID;

  return {
    // Spec v4: the workflow-server materializes native `attr_set` events
    // and accepts initial run attributes on creation. New runs are stamped
    // with this version; the server must be at least this version (it
    // rejects runs newer than its own SPEC_VERSION_CURRENT).
    specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
    // On Vercel the platform fails the function invocation when the
    // process exits non-zero, and VQS redelivers the queue message via a
    // fresh invocation. The core runtime uses this to decide whether
    // `process.exit(1)` is an acceptable response to an exhausted replay
    // budget.
    processExitTriggersQueueRedelivery: true,
    ...createQueue(config),
    ...createStorage(config),
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
