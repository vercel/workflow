/**
 * Shared moves for the lock scenarios. Every run in them is `lockedWorkflow`
 * on one key, so a run is steered by its runId rather than by writer name.
 */
import type { PendingMessageView, Tempo } from '@workflow/world-sim';

/** The flow message (not a step message) waiting for `runId`. */
export const flowMessageFor =
  (runId: string) =>
  (pending: PendingMessageView[]): string | undefined =>
    pending.find((m) => m.runId === runId && !m.stepId)?.messageId;

/** Events of `runId` whose type starts with `lock_`. */
export function lockEventsOf(sim: Tempo, runId: string): string[] {
  return sim.world
    .events(runId)
    .map((e) => e.eventType)
    .filter((t) => t.startsWith('lock_'));
}

/**
 * Park `runId` inside its critical section: its step is started (the slot is
 * held) and the run is not resumed until the returned handle is released.
 */
export function parkInCriticalSection(sim: Tempo, runId: () => string) {
  return sim.park(
    {
      eventType: 'step_started',
      where: (ctx) => ctx.runId === runId(),
    },
    'holder inside its critical section'
  );
}

/**
 * Start a second run on the key and deliver its first message while the
 * holder is parked: it asks for the slot, is refused, and waits.
 */
export async function startWaiter(
  sim: Tempo,
  key: string,
  concurrency: number,
  tag: string
): Promise<string> {
  const waiter = await sim.startRun('lockedWorkflow', [key, concurrency, tag]);
  await sim.deliverQueued(flowMessageFor(waiter));
  return waiter;
}

/** A FIFO World: the FIFO waitlist with direct handoff. */
export const FIFO = { fifo: true } as const;

/** The handoff wake a release sent `runId` (keyed `lock-wake:<runId>:…`). */
export const wakeFor =
  (runId: string) =>
  (pending: PendingMessageView[]): string | undefined =>
    pending.find((m) => m.idempotencyKey?.startsWith(`lock-wake:${runId}:`))
      ?.messageId;

/** `runId`'s armed lock retry: its backstop on a FIFO World. */
export const backstopFor =
  (runId: string) =>
  (pending: PendingMessageView[]): string | undefined =>
    pending.find(
      (m) => m.runId === runId && /:r\d+$/.test(m.idempotencyKey ?? '')
    )?.messageId;

/** When `runId`'s armed lock retry becomes deliverable. */
export function backstopAt(sim: Tempo, runId: string): number | undefined {
  const pending = sim.world.pendingMessages();
  const id = backstopFor(runId)(pending);
  return pending.find((m) => m.messageId === id)?.readyAtMs;
}

/** The fencing token `runId` was granted, from its `lock_acquired`. */
export function tokenOf(sim: Tempo, runId: string): number | undefined {
  const acquired = sim.world
    .events(runId)
    .find((e) => e.eventType === 'lock_acquired') as
    | { eventData: { fencingToken: number } }
    | undefined;
  return acquired?.eventData.fencingToken;
}

/**
 * Hold the run under test's `run_completed` write: its release (and the
 * handoff wake that release sent) has happened, and the delivery loop is
 * stopped inside the holder's invocation, so the wake cannot be delivered
 * until the returned handle is released.
 */
export function parkHolderCompletion(sim: Tempo) {
  return sim.park(
    { eventType: 'run_completed', phase: 'before', runId: sim.runId },
    'holder released, completion held'
  );
}
