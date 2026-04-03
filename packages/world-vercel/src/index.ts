import type { World } from '@workflow/world';
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
    ...createQueue(config),
    ...createStorage(config),
    ...instrumentObject('world.streams', createStreamer(config)),
    getEncryptionKeyForRun: createGetEncryptionKeyForRun(
      projectId,
      config?.projectConfig?.teamId,
      config?.token
    ),
    resolveLatestDeploymentId: createResolveLatestDeploymentId(config),
  };
}
