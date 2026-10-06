import { WorkflowRuntimeError } from '@workflow/errors';
import type { World } from '@workflow/world';
import {
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
} from '@workflow/world';

/**
 * Rejects a World this runtime cannot speak to.
 *
 * The accepted range is
 * `[SPEC_VERSION_SUPPORTS_SLOT_IDENTITY, SPEC_VERSION_MAX_SUPPORTED]`. Below
 * the floor means an old World package paired with a new runtime, which cannot
 * serve the protocol this runtime speaks. A World that does not number events
 * by position allocates ids the runtime cannot read positions out of. Above the
 * ceiling means a World built against a newer spec than this runtime knows how
 * to read.
 *
 * The floor is deliberately the slot-identity version rather than
 * `SPEC_VERSION_CURRENT`, which now sits one above it at the sealed log. Two
 * reasons, and both are about the window a spec bump is staged over:
 *
 * - `WORKFLOW_SEALED_LOG=0` puts a deployment back on slot identity, so its
 *   World declares the lower version. Flooring at the version we stamp by
 *   default would make that kill switch reject the very World it selects,
 *   turning a rollback into a startup failure.
 * - A World package one version behind the runtime it ships alongside is the
 *   normal state mid-bump, and it can still serve the protocol: slot identity
 *   is what the runtime actually requires, and sealed logs are a capability on
 *   top of it that only the backend implements.
 *
 * The range narrows again when the sealed log becomes mandatory and the flag
 * goes away, exactly as slot identity's own floor did.
 */
export function assertWorldSupportsRuntimeProtocol(
  world: Pick<World, 'specVersion'>
): void {
  const declared = world.specVersion;
  if (
    declared !== undefined &&
    declared !== null &&
    declared >= SPEC_VERSION_SUPPORTS_SLOT_IDENTITY &&
    declared <= SPEC_VERSION_MAX_SUPPORTED
  ) {
    return;
  }

  const supportedVersion = declared ?? 'none';
  throw new WorkflowRuntimeError(
    `This Workflow runtime supports Worlds with spec version ${SPEC_VERSION_SUPPORTS_SLOT_IDENTITY} ` +
      `through ${SPEC_VERSION_MAX_SUPPORTED}, ` +
      `but the configured World declares spec version ${supportedVersion}. ` +
      'Install a World package version compatible with the current Workflow runtime.'
  );
}

/**
 * Rejects a World that does not declare the in-band writer fence
 * (`WorldCapabilities.inBandFence`).
 *
 * Every run this runtime creates and drives is a single-orchestrator run
 * (spec >= 9), and on those the fence is what keeps a run to one writer when
 * two orchestrator deliveries overlap: the runtime takes its in-band count
 * from the `snapshot` of a log load and sends it on every in-band write, and
 * it has no unfenced mode. Against a World without the fence two overlapping
 * deliveries could both write decisions into the log, so the runtime refuses
 * the World instead of running unprotected.
 *
 * Checked where a run is created (`start()`) and where an orchestrator
 * delivery begins writing (the `InBandWriter`), so a misconfigured World
 * fails the first `start()` and never writes an unfenced decision. Reads
 * (streams, run and hook lookups) do not need the fence and are not
 * checked.
 */
export function assertWorldSupportsInBandFence(
  world: Pick<World, 'capabilities'>
): void {
  if (world.capabilities?.inBandFence === true) return;
  throw new WorkflowRuntimeError(
    'The configured World does not declare the in-band writer fence ' +
      '(`capabilities.inBandFence`), which this Workflow runtime requires ' +
      `for spec version ${SPEC_VERSION_SINGLE_ORCHESTRATOR} runs. ` +
      'A World must return `snapshot: { seq, seqInBand }` from `events.list` ' +
      'and refuse a stale in-band write with `InBandSupersededError` (412). ' +
      'Install a World package version that implements it; see "Building a World" ' +
      'in the Workflow docs.'
  );
}
