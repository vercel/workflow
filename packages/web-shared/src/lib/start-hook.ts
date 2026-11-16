import {
  type Event,
  isHookLifecycleEventType,
  isRunCreationEvent,
  startHookId,
  type WorkflowRun,
} from '@workflow/world';

/**
 * The creation of a run's start Hook (`start(workflow, args, { hook })`).
 *
 * A start Hook has no `hook_created` of its own: the World creates it while
 * it admits the run, and the run's creation event (`run_created`, or the
 * `run_started` holding the first slot) stands for it, carrying
 * `eventData.startHook`. Its deliveries are ordinary `hook_received` events
 * under {@link startHookId}`(runId)`, and it ends with an ordinary
 * `hook_disposed`. Anything that rebuilds Hooks from the log has to seed the
 * start Hook from here, or it drops the Hook and every delivery to it.
 */
export interface StartHookCreation {
  hookId: string;
  runId: string;
  token?: string;
  createdAt: Date;
}

function eventTimestamp(event: Event | undefined): Date | undefined {
  const value = event?.occurredAt ?? event?.createdAt;
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function tokenOf(startHook: unknown): string | undefined {
  if (!startHook || typeof startHook !== 'object') return undefined;
  const { token } = startHook as { token?: unknown };
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/**
 * The run's start Hook, or `undefined` for a run started without one.
 *
 * Read from the creation event's `eventData.startHook`, falling back to
 * `run.startHook`. Events listed without their data still identify the start
 * Hook by its id, so a run whose log holds an event for
 * {@link startHookId}`(runId)` has one even when no token is known.
 */
export function findStartHookCreation(
  events: readonly Event[],
  run?: Pick<WorkflowRun, 'runId' | 'createdAt'> & { startHook?: unknown }
): StartHookCreation | undefined {
  const creationEvent = events.find(isRunCreationEvent);
  const runId = run?.runId ?? creationEvent?.runId ?? events[0]?.runId;
  if (!runId?.startsWith('wrun_') || runId.length <= 'wrun_'.length) {
    return undefined;
  }
  const hookId = startHookId(runId);
  const token =
    tokenOf(
      creationEvent && 'eventData' in creationEvent
        ? (creationEvent.eventData as { startHook?: unknown } | undefined)
            ?.startHook
        : undefined
    ) ?? tokenOf(run?.startHook);
  const hookEvents = events.filter(
    (event) =>
      event.correlationId === hookId &&
      isHookLifecycleEventType(event.eventType)
  );
  if (token === undefined && hookEvents.length === 0) return undefined;
  // `hook_created` for a start Hook's id is refused by every World, so one in
  // the log means this is not a start Hook after all.
  if (hookEvents.some((event) => event.eventType === 'hook_created')) {
    return undefined;
  }
  const createdAt =
    eventTimestamp(creationEvent) ??
    (run?.createdAt ? new Date(run.createdAt) : undefined) ??
    eventTimestamp(hookEvents[0]);
  if (!createdAt) return undefined;
  return { hookId, runId, token, createdAt };
}
