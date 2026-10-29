import { globalSingleton } from '@workflow/utils';
import type { World } from '@workflow/world';

/**
 * Clean termination for single-owner runs. Any source that learns this
 * process's instance is stopping (today the World's `onRuntimeTermination`)
 * calls `terminateOwners`; every active owner then hands off as it does at its
 * deadline: it takes no new work, answers pending inputs retryably, arms a
 * wake for the next owner and ends, so a stopping instance does not keep the
 * run's only owner idling until its own timeout.
 */
export interface Terminable {
  terminate(reason: string): void;
}

const registry = globalSingleton('@workflow/core//ownerTermination', 1, () => ({
  owners: new Set<Terminable>(),
  unsubscribe: undefined as (() => void) | undefined,
}));

/** End every active owner in this process cleanly. */
export function terminateOwners(reason: string) {
  for (const owner of [...registry.owners]) owner.terminate(reason);
}

/**
 * Track an active owner for termination; the returned function stops it.
 * Sources keep their own state: one that already knows the instance is
 * stopping notifies a new subscriber at once.
 */
export function watchOwnerTermination(
  world: World,
  owner: Terminable
): () => void {
  registry.owners.add(owner);
  if (!registry.unsubscribe)
    registry.unsubscribe = world.onRuntimeTermination?.(terminateOwners);
  return () => {
    registry.owners.delete(owner);
    if (!registry.owners.size) {
      registry.unsubscribe?.();
      registry.unsubscribe = undefined;
    }
  };
}
