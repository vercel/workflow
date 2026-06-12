/**
 * Debounce — collapse event bursts into one action per quiet period.
 *
 * THE PATTERN:
 *   1. debounceSend(key, payload) delivers events to a per-key coordination
 *      workflow (started lazily on the first event of a burst).
 *   2. Each event resets the quiet-period timer by spawning a fresh timer
 *      child workflow with a bumped sequence number; stale timer pings are
 *      ignored.
 *   3. When a timer with the CURRENT sequence number arrives — i.e. the
 *      quiet period passed with no new events — the action fires once with
 *      the latest payload, and the coordinator exits.
 *
 * USEFUL WHEN:
 *   - "At most one notification per user per quiet window", regardless of
 *     how many triggering events arrive.
 *   - Rebuilding an index / cache after a burst of writes settles.
 *   - Syncing to a third party once a rapid-fire edit session ends.
 *
 * CAVEATS / TO ADAPT:
 *   - Replace the onDebounceFire step body with your real action.
 *   - Only the LATEST payload is delivered. To act on all of them, see the
 *     Batch Aggregator pattern instead.
 *   - An event arriving in the same instant the timer fires can land after
 *     the coordinator exits — debounceSend then starts a fresh burst, so
 *     the event is never lost, but the action may fire twice in quick
 *     succession. Make the action idempotent.
 *   - quietMs is fixed per coordinator run (set by the burst's first
 *     event).
 *
 * DOCS: https://workflow-sdk.dev/patterns/debounce
 */
import { defineHook, getStepMetadata, sleep } from 'workflow';
import { start } from 'workflow/api';

type DebounceEvent<T = unknown> =
  | { type: 'event'; payload: T }
  | { type: 'timer'; timerId: number };

export const debounceEvents = defineHook<DebounceEvent>();

function debounceToken(key: string) {
  return `debounce:${key}`;
}

// COORDINATOR — one run per active debounce key. Exits after firing, so
// runs are short-lived; the next burst starts a fresh one.
export async function debounceCoordinator(key: string, quietMs: number) {
  'use workflow';

  const events = debounceEvents.create({ token: debounceToken(key) });
  // Claim the token before doing anything else. If another run already
  // owns it (we lost a start race), exit cleanly pointing at the owner
  // instead of dying with HookConflictError.
  const conflict = await events.getConflict();
  if (conflict) {
    return { dedupedTo: conflict.runId };
  }

  let latest: unknown;
  let hasPayload = false;
  let timerSeq = 0;

  for (;;) {
    const ev = await events;

    if (ev.type === 'event') {
      latest = ev.payload;
      hasPayload = true;
      // Reset the quiet-period timer: bump the sequence and spawn a fresh
      // timer child. Older timers still fire, but their stale timerId is
      // ignored below.
      timerSeq++;
      await spawnDebounceTimer(key, quietMs, timerSeq);
    } else if (ev.timerId === timerSeq && hasPayload) {
      // Quiet period elapsed with no newer event — fire once and exit.
      await onDebounceFire(key, latest);
      return { key, fired: true };
    }
  }
}

// Timer-as-a-message: a tiny child run sleeps, then pings the channel.
export async function debounceTimer(
  key: string,
  quietMs: number,
  timerId: number
) {
  'use workflow';
  await sleep(`${quietMs}ms`);
  try {
    await pingDebounce(key, timerId);
  } catch {
    // Coordinator already fired and exited — fine.
  }
}

async function spawnDebounceTimer(
  key: string,
  quietMs: number,
  timerId: number
): Promise<void> {
  'use step';
  await start(debounceTimer, [key, quietMs, timerId]);
}

async function pingDebounce(key: string, timerId: number): Promise<void> {
  'use step';
  await debounceEvents.resume(debounceToken(key), { type: 'timer', timerId });
}

// THE ACTION — replace this step body with what should happen once the
// burst goes quiet: rebuild a search index, send one summary notification,
// sync to a third party, etc. For example:
//
//   await fetch('https://api.example.com/debounced-action', {
//     method: 'POST',
//     body: JSON.stringify({ key, payload }),
//   });
//
// This demo records firings in memory so the pattern runs out of the box.
// Step execution is at-least-once, so the demo dedupes by stepId — your
// real action should be idempotent too (see CAVEATS above).
const firedActions: Array<{ key: string; payload: unknown }> = [];
const firedSteps = new Set<string>();

async function onDebounceFire(key: string, payload: unknown): Promise<void> {
  'use step';
  const { stepId } = getStepMetadata();
  if (firedSteps.has(stepId)) return;
  firedSteps.add(stepId);
  firedActions.push({ key, payload });
  console.log(`[debounce] fired for "${key}" with the latest payload`);
}

/** Read the demo firings for `key`. Goes away with the demo step body. */
export function readFired(
  key: string
): Array<{ key: string; payload: unknown }> {
  return firedActions.filter((f) => f.key === key);
}

/**
 * Report an event for `key`. The debounced action fires once with the
 * LATEST payload after `quietMs` with no further events. Callable from
 * API routes, steps — anywhere server-side.
 */
export async function debounceSend(
  key: string,
  payload: unknown,
  quietMs = 30_000
): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await debounceEvents.resume(debounceToken(key), {
        type: 'event',
        payload,
      });
      return;
    } catch {
      // No active coordinator for this key — start one and retry. A lost
      // double-start race is harmless: the loser run detects it via
      // getConflict() and returns { dedupedTo } cleanly.
    }
    try {
      await start(debounceCoordinator, [key, quietMs]);
    } catch {
      // Another sender raced us to start it — retry the resume.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Could not deliver debounce event for "${key}"`);
}
