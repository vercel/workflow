import { WorkflowRuntimeError } from '@workflow/errors';
import type { World } from '@workflow/world';
import {
  SPEC_VERSION_MAX_SUPPORTED,
  SPEC_VERSION_SUPPORTS_SLOT_IDENTITY,
} from '@workflow/world';

type WorldSpecVersionMetadata = Pick<World, 'specVersion'>;

/**
 * Rejects a World this runtime cannot speak to.
 *
 * The accepted range is
 * `[SPEC_VERSION_SUPPORTS_SLOT_IDENTITY, SPEC_VERSION_MAX_SUPPORTED]`. Below
 * the floor means an old World package paired with a new runtime, which cannot
 * serve the protocol this runtime speaks — a World that does not number events
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
  world: WorldSpecVersionMetadata
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
