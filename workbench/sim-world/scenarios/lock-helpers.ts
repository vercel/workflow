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
