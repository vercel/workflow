/**
 * Correlation-id allocation for a single workflow invocation.
 *
 * A correlation id names an operation the workflow body issued — a step call, a
 * sleep — and must come out identical on every replay of that run, because it
 * is how a replay recognises the event that already recorded the operation.
 *
 * Two schemes exist. A run on ULID identity draws from the invocation's seeded
 * monotonic ULID generator, which is replay-stable because its seed and initial
 * clock are derived from the run. A run on slot identity counts: the first step
 * of the run is `step_…001`, the second `step_…002`, zero-padded to ULID width
 * (see `slotIdBody`). Which scheme applies is fixed by the run's persisted
 * `specVersion` and never by the build, so a run started before slot identity
 * keeps proposing the ids its log already holds.
 *
 * Counters are **per kind**, and there is nothing to seed them with. The VM is
 * rebuilt for every replay and the workflow body issues its operations in the
 * same order every time, which is the same argument that licenses the seeded
 * ULID sequence today. Recovering counters from the loaded log would be actively
 * wrong: the n-th step's id would then depend on how much of the log this
 * replay happened to load.
 *
 * Per-kind is a strict improvement over the shared ULID sequence. Today all
 * four id kinds draw from one generator, so introducing a hook allocation
 * renumbers every step and wait issued after it; separate counters mean a step's
 * number depends only on the steps before it.
 *
 * Hook and attribute ids stay on ULIDs and are not allocated here. Both are
 * written from outside the VM in cases where no counter exists (an attribute set
 * on a run from the outside), and both already carry their own per-run
 * idempotency, so slots would buy them nothing.
 */

import { FIRST_SLOT, slotIdBody, usesSlotIdentity } from '@workflow/world';

/** Operation kinds whose correlation ids are allocated per run and per kind. */
export type CorrelationKind = 'step' | 'wait';

/**
 * Allocates the next correlation id for a kind, prefix included. Returning the
 * finished id — rather than a number or a bare body — keeps the prefix from
 * ever diverging from the counter it was drawn against.
 */
export type CorrelationIdFactory = (kind: CorrelationKind) => string;

export function createCorrelationIdFactory({
  specVersion,
  generateUlid,
}: {
  /** The run's *persisted* spec version. */
  specVersion: number | undefined;
  /** The invocation's replay-stable ULID generator. */
  generateUlid: () => string;
}): CorrelationIdFactory {
  if (!usesSlotIdentity(specVersion)) {
    return (kind) => `${kind}_${generateUlid()}`;
  }

  const allocated = new Map<CorrelationKind, number>();
  return (kind) => {
    const slot = (allocated.get(kind) ?? FIRST_SLOT - 1) + 1;
    allocated.set(kind, slot);
    return `${kind}_${slotIdBody(slot)}`;
  };
}
