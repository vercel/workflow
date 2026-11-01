import { z } from 'zod';
import type { WorldCapabilities } from './interfaces.js';

const flag = z.boolean().optional().catch(undefined);
const activeFlag = z
  .object({ active: z.boolean() })
  .optional()
  .catch(undefined);

/**
 * Parses a {@link WorldCapabilities} object received from another process,
 * such as a target deployment's health-check response.
 *
 * Tolerant by design, because the peer may run a newer or older SDK:
 *
 * - unknown keys are dropped, so a newer peer advertising a capability this
 *   build does not know about still parses;
 * - a malformed field reads as absent (unsupported), without affecting the
 *   others;
 * - a value that is not an object at all reads as no capabilities.
 *
 * Every capability fails closed when absent, so tolerance can only ever turn
 * a feature off. The documentation for each field lives on
 * {@link WorldCapabilities}.
 */
export const WorldCapabilitiesSchema = z
  .object({
    invoke: flag,
    hookRetention: activeFlag,
    atomicStartHook: activeFlag,
    maxConcurrency: flag,
    inBandFence: flag,
    hookResumeDedup: flag,
    hookForceClaim: flag,
    deploymentAffinity: flag,
    dynamicWorkflowCode: flag,
  })
  .optional()
  .catch(undefined);

/** Parses a peer's capabilities; see {@link WorldCapabilitiesSchema}. */
export function parseWorldCapabilities(
  value: unknown
): WorldCapabilities | undefined {
  const parsed = WorldCapabilitiesSchema.parse(value);
  if (!parsed) return undefined;
  // Drop the keys a failed field left behind as explicit `undefined`, so the
  // result compares and serializes like a hand-written capabilities object.
  return Object.fromEntries(
    Object.entries(parsed).filter(([, v]) => v !== undefined)
  ) as WorldCapabilities;
}

// The schema must cover exactly the capabilities the interface declares, so
// adding a capability without teaching the parser about it fails to compile.
type ParsedCapabilities = NonNullable<z.infer<typeof WorldCapabilitiesSchema>>;
type AssertSameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : never
  : never;
const _capabilitiesSchemaCoversInterface: AssertSameKeys<
  ParsedCapabilities,
  WorldCapabilities
> = true;
void _capabilitiesSchemaCoversInterface;
