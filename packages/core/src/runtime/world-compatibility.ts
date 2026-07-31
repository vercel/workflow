import { WorkflowRuntimeError } from '@workflow/errors';
import type { World } from '@workflow/world';
import {
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_MAX_SUPPORTED,
} from '@workflow/world';

type WorldSpecVersionMetadata = Pick<World, 'specVersion'>;

/**
 * Rejects a World whose protocol this runtime does not speak.
 *
 * A World declares the spec version it stamps on the runs it creates. Anything
 * from {@link SPEC_VERSION_CURRENT} up to {@link SPEC_VERSION_MAX_SUPPORTED} is
 * fine: the upper end covers a World opted into a newer identity scheme that
 * this runtime already understands, and only versions this runtime has no code
 * for are refused. Below the current version means the World package predates
 * this runtime and cannot record what it emits.
 */
export function assertWorldSupportsRuntimeProtocol(
  world: WorldSpecVersionMetadata
): void {
  if (
    world.specVersion !== undefined &&
    world.specVersion >= SPEC_VERSION_CURRENT &&
    world.specVersion <= SPEC_VERSION_MAX_SUPPORTED
  ) {
    return;
  }

  const supportedVersion = world.specVersion ?? 'none';
  const supported =
    SPEC_VERSION_CURRENT === SPEC_VERSION_MAX_SUPPORTED
      ? `${SPEC_VERSION_CURRENT}`
      : `${SPEC_VERSION_CURRENT} to ${SPEC_VERSION_MAX_SUPPORTED}`;
  throw new WorkflowRuntimeError(
    `This Workflow runtime requires a World with spec version ${supported}, ` +
      `but the configured World declares spec version ${supportedVersion}. ` +
      'Install a World package version compatible with the current Workflow runtime.'
  );
}
