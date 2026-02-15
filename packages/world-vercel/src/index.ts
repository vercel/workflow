import type { WorkflowRun, World } from '@workflow/world';
import { deriveRunKey, fetchRunKey } from './encryption.js';
import { createQueue } from './queue.js';
import { createStorage } from './storage.js';
import { createStreamer } from './streamer.js';
import type { APIConfig } from './utils.js';

export { deriveRunKey, fetchRunKey } from './encryption.js';
export { createQueue } from './queue.js';
export { createStorage } from './storage.js';
export { createStreamer } from './streamer.js';
export type { APIConfig } from './utils.js';

export function createVercelWorld(config?: APIConfig): World {
  const storage = createStorage(config);
  // Project ID for HKDF key derivation context.
  // Use config value first (set correctly by CLI/web), fall back to env var (runtime).
  const projectId =
    config?.projectConfig?.projectId || process.env.VERCEL_PROJECT_ID;
  const currentDeploymentId = process.env.VERCEL_DEPLOYMENT_ID;

  // Parse the local deployment key from env (lazy, only when encryption is used)
  let localDeploymentKey: Uint8Array | undefined;
  function getLocalDeploymentKey(): Uint8Array | undefined {
    if (localDeploymentKey) return localDeploymentKey;
    const deploymentKeyBase64 = process.env.VERCEL_DEPLOYMENT_KEY;
    if (!deploymentKeyBase64) return undefined;
    localDeploymentKey = Uint8Array.from(
      Buffer.from(deploymentKeyBase64, 'base64')
    );
    return localDeploymentKey;
  }

  return {
    ...createQueue(config),
    ...storage,
    ...createStreamer(config),

    async getEncryptionKeyForRun(
      run: WorkflowRun | string
    ): Promise<Uint8Array | undefined> {
      if (!projectId) return undefined;

      const runId = typeof run === 'string' ? run : run.runId;
      const deploymentId =
        typeof run === 'string' ? undefined : run.deploymentId;

      // Same deployment (or run is just a string, i.e., from start())
      // → use local deployment key + local HKDF derivation
      if (!deploymentId || deploymentId === currentDeploymentId) {
        const localKey = getLocalDeploymentKey();
        if (!localKey) return undefined;
        return deriveRunKey(localKey, projectId, runId);
      }

      // Different deployment — fetch the derived per-run key from the
      // Vercel API. The API performs HKDF derivation server-side so the
      // raw deployment key never leaves the API boundary.
      // Covers cross-deployment resumeHook() (OIDC auth) and o11y
      // tooling reading data from other deployments (VERCEL_TOKEN).
      // No caching needed here — callers (CLI/web) cache at a higher level.
      return fetchRunKey(deploymentId, projectId, runId, {
        token: config?.token,
      });
    },
  };
}
