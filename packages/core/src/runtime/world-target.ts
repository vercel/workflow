import type { World } from '@workflow/world';

function throwMissingStaticInjection(): never {
  throw new Error(
    'Workflow target world was not statically injected. Configure a Workflow builder/framework plugin so @workflow/core/runtime/world-target is aliased to the selected world package.'
  );
}

/**
 * Unaliased target stub.
 *
 * Framework integrations alias this module to the configured world package at
 * build time, including the default local world. Reaching this file means that
 * static injection did not happen, so fail loudly instead of importing a
 * fallback world that bundlers could retain alongside the configured one.
 */
export function createWorld(): World | Promise<World> {
  throwMissingStaticInjection();
}
