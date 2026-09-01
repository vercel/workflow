import { z } from 'zod';

/**
 * Optional features a World implementation supports. Missing capabilities are
 * unsupported so runtime behavior always fails closed.
 */
export const WorldCapabilitiesSchema = z.object({
  /**
   * Supports `experimental_minRetention` for Hooks. Missing or inactive means
   * the runtime rejects retained Hooks before registration.
   */
  hookRetention: z.object({ active: z.boolean() }).optional(),

  /**
   * Atomically admits a workflow run and reserves its start Hook token.
   * Missing or inactive means `start({ hook })` must fail before enqueueing.
   */
  atomicStartHook: z.object({ active: z.boolean() }).optional(),

  /**
   * The World's queue supports `maxConcurrency`-limited consumption. This
   * declares queue support, not deployed configuration, so the runtime cannot
   * enable a fast path from this capability alone.
   */
  maxConcurrency: z.boolean().optional(),

  /**
   * `events.create` deduplicates concurrent `hook_received` writes sharing a
   * `(runId, resumeId)`, and `events.list` returns the persisted `resumeId`.
   * Worlds that accept but do not enforce or round-trip it must leave this
   * unset.
   */
  hookResumeDedup: z.boolean().optional(),

  /**
   * Deployments are atomic and immutable, so a deployment id always names one
   * fixed build. Worlds with synthetic or version-tagged deployment ids must
   * leave this unset.
   */
  deploymentAffinity: z.boolean().optional(),
});

export type WorldCapabilities = z.infer<typeof WorldCapabilitiesSchema>;
