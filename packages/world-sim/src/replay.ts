/**
 * Replay verification: does the committed log actually regenerate the state?
 *
 * Everything else in this package checks the log's *shape*: ordering, entity
 * rows folding back out of it, lifecycle rules. None of that answers the
 * question the durability model actually rests on: if a fresh process picked
 * up this log tomorrow, would it reconstruct the same run?
 *
 * The check is a cold start with the answer withheld. Take the finished log,
 * drop its terminal `run_*` event, load the rest into an empty world as
 * durable history, and deliver one queue message. The real runtime (the same
 * `workflowEntrypoint` a deployment serves) replays the workflow from the log
 * and must re-derive the event we removed, with the same output. No step body
 * re-executes (every `step_completed` is in the log, so the step consumer
 * resolves from it), so anything the replay produces came from the log alone.
 *
 * Three ways it can fail, and all three are the same bug class:
 *
 *  - The replay cannot follow the log: the runtime raises
 *    `ReplayDivergenceError`, retries its recovery replays, and then fails the
 *    run with `CorruptedEventLogError`. Surfaced here as `replay.diverged`.
 *  - The replay runs out of log before the workflow finishes, and suspends:
 *    the log did not contain enough to rebuild the run. `replay.suspended`.
 *  - The replay finishes but derives a different answer. `replay.output-differs`
 *    / `replay.log-differs`.
 */

import { setWorld } from '@workflow/core/runtime';
import { RUN_ERROR_CODES } from '@workflow/errors';
import {
  type Event,
  isTerminalRunEventType,
  type WorkflowRun,
} from '@workflow/world';
import { createVirtualClock } from './clock.js';
import { driveQueue, type ScenarioLimits } from './drive.js';
import type { InvariantViolation } from './types.js';
import { createSimWorld, WORKFLOW_QUEUE_PREFIX } from './world.js';

export interface ReplayCheckInput {
  run: WorkflowRun;
  /** The full committed log of the finished run. */
  events: readonly Event[];
  handler: (req: Request) => Promise<Response>;
  limits: Required<ScenarioLimits>;
}

export interface ReplayCheckResult {
  violations: InvariantViolation[];
  /** The log the replay produced, for reporting. */
  regenerated: Event[];
  /** How many deliveries the cold replay needed. */
  deliveries: number;
}

/** Events after the terminal one (a step closing out post-cancellation). */
function splitAtTerminal(events: readonly Event[]): {
  history: Event[];
  terminal: Event | undefined;
  trailing: Event[];
} {
  const index = events.findIndex((e) => isTerminalRunEventType(e.eventType));
  if (index === -1)
    return { history: [...events], terminal: undefined, trailing: [] };
  return {
    history: events.slice(0, index),
    terminal: events[index],
    trailing: events.slice(index + 1),
  };
}

/** `(eventType, correlationId)`: the part of a log that must be reproducible. */
function shape(events: readonly Event[]): string[] {
  return events.map((e) =>
    e.correlationId ? `${e.eventType}#${e.correlationId}` : e.eventType
  );
}

function sameBytes(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array && b instanceof Uint8Array) {
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  }
  return a === b;
}

/**
 * Cold-replay a finished run's log and compare what comes back.
 *
 * Only meaningful for a run that reached a terminal state: a stalled or
 * cancelled run's log legitimately does not drive the workflow to an end, so
 * there is no regenerated answer to compare against.
 */
export async function verifyReplay(
  input: ReplayCheckInput
): Promise<ReplayCheckResult> {
  const violations: InvariantViolation[] = [];
  const { run, events, handler, limits } = input;
  const runId = run.runId;

  const add = (rule: string, message: string, eventId?: string) =>
    violations.push({ rule, message, runId, eventId });

  const { history, terminal, trailing } = splitAtTerminal(events);
  if (!terminal) {
    return { violations, regenerated: [], deliveries: 0 };
  }

  // A step that closed out after the run terminated cannot be re-derived by a
  // replay, since it was driven by an inline body that already ran, not by the
  // log.
  // Seed those as history too so the replay sees the same durable state a
  // fresh process would.
  const seeded = [...history, ...trailing];

  // The replay must happen at the instant the run ended, not whenever the
  // scenario happened to finish draining its queue. Replaying later is not
  // wrong (the runtime would legitimately complete any wait that has since
  // elapsed), but it answers a different question than "does this log
  // reproduce this run", and the comparison below would flag the difference as
  // a divergence when nothing diverged.
  //
  // The +1ms offset is what keeps ids sortable: `events.list` orders by
  // (createdAt, eventId), so an event minted in the same millisecond as the
  // seeded tail could sort ahead of it. One millisecond is below the
  // resolution of any wait a workflow can express.
  const replayClock = createVirtualClock(terminal.createdAt.getTime() + 1);
  const uninstallClock = replayClock.install();

  const replayWorld = createSimWorld({ clock: replayClock });
  replayWorld.store.seedFromLog(seeded);
  replayWorld.registerHandler(WORKFLOW_QUEUE_PREFIX, handler);
  replayWorld.setScenarioApi(() => {
    throw new Error('the replay world runs no script');
  });

  setWorld(replayWorld);

  let drain: Awaited<ReturnType<typeof driveQueue>>;
  try {
    await replayWorld.queue(
      `${WORKFLOW_QUEUE_PREFIX}${run.workflowName}` as never,
      { runId }
    );
    drain = await driveQueue({
      world: replayWorld,
      limits,
      wallStart: performance.now(),
    });
  } finally {
    uninstallClock();
  }

  const regenerated = replayWorld.store.allEvents(runId).slice(seeded.length);

  if (drain.exceeded) {
    add(
      'replay.budget',
      `cold replay of the committed log did not settle: ${drain.exceeded}`
    );
    return { violations, regenerated, deliveries: drain.deliveries };
  }

  const replayedRun = replayWorld.store
    .allRuns()
    .find((r) => r.runId === runId);

  // The runtime turns a persistent divergence into a failed run carrying
  // REPLAY_DIVERGENCE / CORRUPTED_EVENT_LOG. That is the signal this whole
  // check exists to catch, so name it explicitly rather than letting it read
  // as a generic "the outcome differs".
  const errorCode = replayedRun?.errorCode;
  if (
    errorCode === RUN_ERROR_CODES.CORRUPTED_EVENT_LOG ||
    errorCode === RUN_ERROR_CODES.REPLAY_DIVERGENCE
  ) {
    add(
      'replay.diverged',
      `replaying the committed log failed with ${errorCode}: the runtime could not ` +
        `follow the history it wrote. ${await describeRunError(replayedRun?.error)}`
    );
    return { violations, regenerated, deliveries: drain.deliveries };
  }

  if (
    !replayedRun ||
    replayedRun.status === 'running' ||
    replayedRun.status === 'pending'
  ) {
    add(
      'replay.suspended',
      `replaying the committed log left the run "${replayedRun?.status ?? 'missing'}" instead of "${run.status}" — the log does not contain enough to rebuild the run`
    );
    return { violations, regenerated, deliveries: drain.deliveries };
  }

  if (replayedRun.status !== run.status) {
    add(
      'replay.status-differs',
      `replay ended "${replayedRun.status}", the original run ended "${run.status}"` +
        (replayedRun.status === 'failed'
          ? `: ${await describeRunError(replayedRun.error)}`
          : '')
    );
  }

  if (!sameBytes(replayedRun.output, run.output)) {
    add(
      'replay.output-differs',
      'replay produced a different output than the one recorded on the run'
    );
  }

  // The tail the replay re-derived should be the tail we withheld. Compared by
  // (eventType, correlationId): ids and timestamps are necessarily new.
  const expectedTail = shape([terminal]);
  const actualTail = shape(regenerated);
  if (actualTail.join(',') !== expectedTail.join(',')) {
    add(
      'replay.log-differs',
      `replay re-derived [${actualTail.join(', ')}] where the original log recorded [${expectedTail.join(', ')}]`
    );
  }

  return { violations, regenerated, deliveries: drain.deliveries };
}

/** Best-effort human-readable form of a dehydrated run error, for reporting. */
async function describeRunError(error: unknown): Promise<string> {
  if (error === undefined) return '(no error recorded)';
  try {
    // Go through the real hydration path, not the observability one: a run
    // error is written by `dehydrateRunError` and may be compressed, which the
    // synchronous observability reviver cannot undo.
    const { hydrateRunError } = await import('@workflow/core/serialization');
    const value = await hydrateRunError(error, 'wrun_replay', undefined);
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value && typeof value === 'object') {
      const { name, message } = value as { name?: string; message?: string };
      if (message) return `${name ?? 'Error'}: ${message}`;
    }
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '(error could not be hydrated)';
  }
}
