import { WorkflowRuntimeError } from '@workflow/errors';
import type { World } from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_MAX_SUPPORTED,
} from '@workflow/world';

type WorldSpecVersionMetadata = Pick<World, 'specVersion'>;

/**
 * Rejects a World this runtime cannot speak to.
 *
 * The accepted range is `[SPEC_VERSION_CURRENT, SPEC_VERSION_MAX_SUPPORTED]`.
 * Below the current version means an old World package paired with a new
 * runtime, which cannot serve the protocol this runtime speaks. Above the
 * ceiling means a World built against a newer spec than this runtime knows how
 * to read.
 *
 * The range has a floor and a ceiling rather than a single value because a
 * World may opt into a spec version above the default: `world-vercel` declares
 * the slot-identity version so its new runs are created with slot event ids,
 * while every other World stays on the default. An equality check would make
 * this runtime refuse the adapter shipped alongside it.
 */
export function assertWorldSupportsRuntimeProtocol(
  world: WorldSpecVersionMetadata
): void {
  const declared = world.specVersion;
  if (
    declared !== undefined &&
    declared !== null &&
    declared >= SPEC_VERSION_CURRENT &&
    declared <= SPEC_VERSION_MAX_SUPPORTED
  ) {
    return;
  }

  const supportedVersion = declared ?? 'none';
  throw new WorkflowRuntimeError(
    `This Workflow runtime requires a World with matching spec version ${SPEC_VERSION_CURRENT}, ` +
      `but the configured World declares spec version ${supportedVersion}. ` +
      'Install a World package version compatible with the current Workflow runtime.'
  );
}
