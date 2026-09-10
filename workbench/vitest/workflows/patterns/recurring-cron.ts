/**
 * Recurring Cron — a self-rescheduling job loop with drift correction.
 *
 * THE PATTERN:
 *   1. The workflow sleeps until each ABSOLUTE due time (nextDueAt), runs
 *      the job, then advances nextDueAt by the interval — anchored on the
 *      schedule, not on "now", so drift never accumulates.
 *   2. After ITERATIONS_PER_RUN ticks, the run starts a successor and
 *      exits (continue-as-new), so the event log stays bounded. On Vercel,
 *      add { deploymentId: "latest" } to that start() so the job also
 *      adopts new deployments within a day.
 *   3. A stop hook (token cron:<name>:<generation-start>) races each sleep
 *      so the schedule can be ended cleanly between ticks.
 *
 * USEFUL WHEN:
 *   - Hourly/daily syncs, digests, cleanups — without any cron
 *     infrastructure, and with each tick's execution durable + retried.
 *   - Schedules that must survive deploys and code changes indefinitely.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Replace runJob with your real work; tune INTERVAL_MS and
 *     ITERATIONS_PER_RUN (their product is how long a generation lasts —
 *     keep it ≲ a day so new deployments are adopted promptly).
 *   - Start it once: start(recurringCron, ["my-job", { iteration: 0,
 *     nextDueAt: Date.now() + INTERVAL_MS }]). Use the Singleton Run
 *     pattern's getOrStart() to make that idempotent.
 *   - For calendar-aligned schedules ("9am daily"), compute nextDueAt with
 *     a calendar library inside a step instead of adding a fixed interval.
 *   - If a tick is still running at the next due time, this design simply
 *     starts late (no overlap). For overlapping ticks, spawn runJob as a
 *     child workflow instead of awaiting it.
 *
 * DOCS: https://workflow-sdk.dev/patterns/recurring-cron
 */
import { defineHook, sleep } from 'workflow';
import { start } from 'workflow/api';

// Run the job this often.
const INTERVAL_MS = 60 * 60 * 1000; // hourly
// Hand off to a fresh run after this many iterations (bounds the event
// log and adopts the latest deployment).
const ITERATIONS_PER_RUN = 24;

export interface CronState {
  /** Monotonic counter across generations. */
  iteration: number;
  /** Absolute epoch-ms of the next due tick — the drift-correction anchor. */
  nextDueAt: number;
}

// Resume this hook (token `cron:<name>`) to stop the schedule cleanly.
export const stopCron = defineHook<{ reason?: string }>();

export async function recurringCron(name: string, state: CronState) {
  'use workflow';

  const stop = stopCron.create({ token: `cron:${name}:${state.iteration}` });
  // ONE shared awaiter for the stop signal, hoisted out of the loop. Each
  // `stop.then()` would register a fresh awaiter that consumes one payload
  // in arrival order — racing the hook directly inside the loop leaks an
  // awaiter per tick, and a stale one from an earlier iteration would
  // swallow the stop message.
  const stopRequested = stop.then(() => true as const);
  let current = state;

  for (let i = 0; i < ITERATIONS_PER_RUN; i++) {
    // Drift correction: sleep to the absolute due time. If the job ran
    // long or the run was delayed, the next sleep shrinks to compensate.
    const stopped = await Promise.race([
      sleep(new Date(current.nextDueAt)).then(() => false as const),
      stopRequested,
    ]);
    if (stopped) {
      return { name, stoppedAt: current.iteration };
    }

    await runJob(name, current.iteration, current.nextDueAt);

    current = {
      iteration: current.iteration + 1,
      // Anchor on the previous due time, never on "now" — this is what
      // prevents drift from accumulating.
      nextDueAt: current.nextDueAt + INTERVAL_MS,
    };
  }

  // Continue-as-new: hand the schedule to a fresh run. State is the only
  // thing that crosses over.
  await continueCron(name, current);
  return { name, continuedAt: current.iteration };
}

// In-memory record of ticks so the demo runs out of the box. (`dueAt` is
// the drift-corrected absolute time the tick was scheduled for.)
export const cronTicks = new Map<
  string,
  { iteration: number; dueAt: number }[]
>();

// THE JOB — replace this step body with your real recurring work, e.g.:
//
//   await fetch('https://api.your-domain.com/cron-job', {
//     method: 'POST',
//     body: JSON.stringify({ name, iteration }),
//   });
async function runJob(
  name: string,
  iteration: number,
  dueAt: number
): Promise<void> {
  'use step';
  const ticks = cronTicks.get(name) ?? [];
  // Steps run at-least-once — skip if a transparent retry of this step
  // already recorded the tick.
  if (!ticks.some((tick) => tick.iteration === iteration)) {
    ticks.push({ iteration, dueAt });
  }
  cronTicks.set(name, ticks);
}

// On Vercel, pass { deploymentId: 'latest' } as a third argument to
// start() so each generation runs on the newest deployment. (Local dev
// can't resolve 'latest'.)
async function continueCron(name: string, state: CronState): Promise<void> {
  'use step';
  await start(recurringCron, [name, state]);
}
