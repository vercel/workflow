import { globalSingleton } from '@workflow/utils';
import type { Event, World } from '@workflow/world';
import type { OutOfBandObservation } from '../out-of-band-observation.js';

/**
 * What the boundary a speculative write ran ahead of allowed to land below
 * it: the classification of `observeOutOfBandWriters`, kept as the ids it
 * was made from.
 */
export interface RunAheadContext {
  /**
   * Open hooks whose next event could change the workflow's path: hooks
   * workflow code waits on, hooks with unknown observation, and system
   * (abort) hooks. Empty at an inert boundary; kept so a check can name one.
   */
  sensitiveHookIds: ReadonlySet<string>;
  /** Steps this delivery runs inline: only it writes their events. */
  selfStepIds: ReadonlySet<string>;
}

/**
 * Stops a delivery that ran ahead of its writes: a speculative write failed
 * a check before anything else was written. The delivery is redelivered and
 * decides from the log.
 */
export class RunAheadStopError extends Error {
  constructor(readonly reason: string) {
    super(`Run-ahead stopped: ${reason}`);
    this.name = 'RunAheadStopError';
  }

  static is(value: unknown): value is RunAheadStopError {
    return value instanceof Error && value.name === 'RunAheadStopError';
  }
}

/**
 * Why `event`, seen below a speculative write, would have made the boundary
 * of `context` path-changing, or `undefined` when it is inert there (or is
 * the delivery's own). See `runtime/out-of-band-observation.ts` for the
 * writers and why each is or is not path-changing.
 */
export function runAheadHazard(
  event: Event,
  context: RunAheadContext,
  isOwn: (event: Event) => boolean
): string | undefined {
  if (isOwn(event)) return undefined;
  const id = event.correlationId;
  switch (event.eventType) {
    case 'hook_received':
    case 'hook_disposed':
    case 'hook_conflict':
      return id !== undefined && context.sensitiveHookIds.has(id)
        ? `${event.eventType} for a hook the workflow may be waiting on`
        : undefined;
    case 'step_started':
    case 'step_completed':
    case 'step_failed':
    case 'step_retrying':
      return id !== undefined && context.selfStepIds.has(id)
        ? undefined
        : `${event.eventType} of a step this delivery does not run`;
    case 'wait_completed':
      return 'wait_completed written by another writer';
    default:
      return undefined;
  }
}

/**
 * Whether an event another writer placed below a run-ahead's speculative
 * events may still join the retained session that consumed them, fed after
 * them. True only where the event's position cannot move a decision on the
 * node:vm engine (see `../out-of-band-observation.ts`): a hook event for a
 * hook no boundary of the run-ahead was sensitive to (buffered as an unarmed
 * delivery, it orders nothing and leaves the clock alone), an attribute
 * write, or a sealed position. Anything else sends the session to a cold
 * replay of the corrected log.
 */
export function admitBelowSpeculation(
  event: Event,
  sensitiveHookIds: ReadonlySet<string>
): boolean {
  switch (event.eventType) {
    case 'hook_received':
    case 'hook_disposed':
    case 'hook_conflict':
      return (
        event.correlationId !== undefined &&
        !sensitiveHookIds.has(event.correlationId)
      );
    case 'attr_set':
    case 'noop':
      return true;
    default:
      return false;
  }
}

/** The context of a boundary from its suspension's queue. */
export function runAheadContextFor(input: {
  observation: OutOfBandObservation;
  hookItems: readonly {
    correlationId: string;
    isSystem?: boolean;
    disposed?: boolean;
  }[];
  observedHookIds: ReadonlySet<string> | undefined;
  selfStepIds: ReadonlySet<string>;
}): RunAheadContext {
  const sensitiveHookIds = new Set<string>();
  for (const hook of input.hookItems) {
    if (hook.disposed) continue;
    if (
      hook.isSystem ||
      input.observedHookIds === undefined ||
      input.observedHookIds.has(hook.correlationId)
    ) {
      sensitiveHookIds.add(hook.correlationId);
    }
  }
  return { sensitiveHookIds, selfStepIds: input.selfStepIds };
}

// On `globalThis` (see `globalSingleton`): a World found not to record an
// in-band write at its `occurredAt` stays excluded process-wide, whichever
// bundled copy of this module meets it.
const disabled = globalSingleton(
  '@workflow/core//runAheadDisabledWorlds',
  1,
  () => ({ worlds: new WeakSet<object>() })
);

/**
 * Whether run-ahead is off for `world` in this process: one of its in-band
 * writes came back with a time other than the `occurredAt` the orchestrator
 * sent, so a workflow that ran ahead of it would read a `Date.now()` replay
 * never reproduces.
 */
export function isRunAheadDisabledFor(world: World): boolean {
  return disabled.worlds.has(world);
}

export function disableRunAheadFor(world: World): void {
  disabled.worlds.add(world);
}
