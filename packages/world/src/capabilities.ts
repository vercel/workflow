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
   * Enforces the event count and update-time preconditions on event creation.
   * Worlds that accept but ignore either field must leave this unset.
   */
  preconditionGuard: z.boolean().optional(),

  /** Supports `maxConcurrency`-limited queue consumption. */
  maxConcurrency: z.boolean().optional(),

  /**
   * Deduplicates concurrent `hook_received` writes sharing a
   * `(runId, resumeId)` and returns the canonical event to every caller.
   */
  hookResumeDedup: z.boolean().optional(),

  /**
   * Uses atomic, immutable deployments with strict run affinity. Worlds with
   * synthetic or version-tagged deployment ids must leave this unset.
   */
  deploymentAffinity: z.boolean().optional(),

  /**
   * Allocates dense, slot-numbered event IDs for new runs. Event creation
   * advances past occupied slots and returns the skipped events to the writer.
   * Existing runs keep their original event ID scheme.
   */
  slotEventIds: z.boolean().optional(),
});

export type WorldCapabilities = z.infer<typeof WorldCapabilitiesSchema>;
