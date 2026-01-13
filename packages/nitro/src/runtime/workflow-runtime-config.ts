import { defineNitroPlugin } from 'nitro/~internal/runtime/plugin';
import { useRuntimeConfig } from 'nitro/runtime-config';

/**
 * Bridge Nitro runtimeConfig -> Workflow local world env vars.
 *
 * This is framework-agnostic:
 * - Works in Nuxt because Nuxt feeds runtimeConfig into Nitro.
 * - Works in standalone Nitro if the user provides `runtimeConfig` in nitro.config.
 *
 * Supported keys:
 * - `runtimeConfig.workflow.baseUrl` (preferred, private/server-only)
 * - `runtimeConfig.public.workflow.baseUrl` (fallback)
 * - `runtimeConfig.workflow.{protocol,host,port}` (preferred)
 * - `runtimeConfig.public.workflow.{protocol,host,port}` (fallback)
 *
 * Result:
 * - Sets `process.env.WORKFLOW_LOCAL_BASE_URL` if not already set.
 */
export default defineNitroPlugin(() => {
  if (process.env.WORKFLOW_LOCAL_BASE_URL) return;

  const runtimeConfig = useRuntimeConfig();
  const workflow =
    runtimeConfig?.workflow ?? runtimeConfig?.public?.workflow ?? undefined;

  if (!workflow) return;

  // Full baseUrl override (recommended)
  if (typeof workflow.baseUrl === 'string' && workflow.baseUrl.length > 0) {
    process.env.WORKFLOW_LOCAL_BASE_URL = workflow.baseUrl;
    return;
  }

  // Construct from parts (protocol/host/port)
  const protocol =
    typeof workflow.protocol === 'string' && workflow.protocol.length > 0
      ? workflow.protocol
      : undefined;
  const host =
    typeof workflow.host === 'string' && workflow.host.length > 0
      ? workflow.host
      : undefined;
  const port =
    typeof workflow.port === 'number' || typeof workflow.port === 'string'
      ? String(workflow.port)
      : undefined;

  if (!protocol || !host) return;
  process.env.WORKFLOW_LOCAL_BASE_URL = port
    ? `${protocol}://${host}:${port}`
    : `${protocol}://${host}`;
});
