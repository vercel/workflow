import { WorkflowRuntimeError } from '@workflow/errors';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';

type WorldSpecVersionMetadata = Pick<World, 'specVersion'>;

export function assertWorldSupportsRuntimeProtocol(
  world: WorldSpecVersionMetadata
): void {
  if (world.specVersion === SPEC_VERSION_CURRENT) {
    return;
  }

  const supportedVersion = world.specVersion ?? 'none';
  throw new WorkflowRuntimeError(
    `This Workflow runtime requires a World with matching spec version ${SPEC_VERSION_CURRENT}, ` +
      `but the configured World declares spec version ${supportedVersion}. ` +
      'Install a World package version compatible with the current Workflow runtime.'
  );
}
