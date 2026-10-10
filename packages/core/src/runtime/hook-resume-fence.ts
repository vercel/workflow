import {
  type Event,
  HOOK_RESUME_FENCE_INPUT_VERSION,
  HOOK_RESUME_FENCE_MAX_WINDOW_MS,
  type HookResumeFence,
} from '@workflow/world';

/**
 * Parallel hook wake: `resumeHook()` publishes the workflow wake concurrently
 * with its `hook_received` write instead of after it, saving one producer
 * round trip. The two halves of the protocol live here so the producer and
 * consumer cannot drift:
 *
 * - The wake carries a {@link HookResumeFence}. The consumer does not replay
 *   until it has read the fenced `hook_received`, or a read that started
 *   `windowMs` after its handler was entered still lacked it, or the log
 *   proves the event can no longer commit ({@link awaitHookResumeFence}).
 * - If the producer's write took long enough to have committed after that
 *   window closed, it publishes a second, distinctly keyed wake once the
 *   write has committed ({@link parallelHookWakeNeedsInsurance}).
 *
 * Why the two together never strand a resume: the consumer cannot start
 * before the publish was requested (T), the write committed no later than the
 * producer observed it (W), and the consumer's last read started at or after
 * `entry + windowMs >= T + windowMs`. If `W - T < windowMs` that read saw the
 * event; otherwise the insurance wake, published after W, is replayed over a
 * log that holds it. Both durations are measured on monotonic clocks on their
 * own machines, so no cross-machine clock agreement is assumed. The producer
 * insures at half the window, a 2x margin.
 *
 * Only runs whose creating deployment stamped
 * `hookResumeInputVersion >= HOOK_RESUME_FENCE_INPUT_VERSION` receive a
 * fenced wake: a run is pinned to that deployment, and an older consumer
 * would strip the field and replay unfenced.
 */

/** Environment variable that enables the parallel dispatch on producers. */
export const PARALLEL_HOOK_WAKE_ENV_VAR = 'WORKFLOW_PARALLEL_HOOK_WAKE';

/** The fence window producers send. */
export const HOOK_RESUME_FENCE_WINDOW_MS = 1_000;

/**
 * Whether this producer may use the parallel dispatch. Off by default: set
 * `WORKFLOW_PARALLEL_HOOK_WAKE=1` to opt in. Read per call so the variable
 * also works as an instant kill switch.
 */
export function isParallelHookWakeEnabled(): boolean {
  const value = process.env[PARALLEL_HOOK_WAKE_ENV_VAR]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/** Whether the target run's runtime honors a fenced wake. */
export function runSupportsHookResumeFence(
  hookResumeInputVersion: number | undefined
): boolean {
  return (hookResumeInputVersion ?? 0) >= HOOK_RESUME_FENCE_INPUT_VERSION;
}

/**
 * Whether a parallel resume whose write took `writeDurationMs` (measured from
 * just before the publish was requested to the write's acknowledgement) must
 * publish an insurance wake.
 */
export function parallelHookWakeNeedsInsurance(
  writeDurationMs: number,
  windowMs: number = HOOK_RESUME_FENCE_WINDOW_MS
): boolean {
  return !(writeDurationMs < windowMs / 2);
}

/** Clamp a received window to what a consumer will honor. */
export function clampHookResumeFenceWindow(windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
  return Math.min(windowMs, HOOK_RESUME_FENCE_MAX_WINDOW_MS);
}

/** What the loaded log says about the fenced `hook_received`. */
export type HookResumeFenceOutcome =
  /** The fenced event is in the log. */
  | 'present'
  /** The hook was disposed with no matching receipt: it can never commit. */
  | 'hook_disposed'
  /** The run ended: the receipt can never commit. */
  | 'run_terminal'
  /** The window closed without the event: replay without it. */
  | 'window_elapsed';

function isFencedReceipt(event: Event, fence: HookResumeFence): boolean {
  if (event.eventType !== 'hook_received') return false;
  if (event.resumeId === fence.resumeId) return true;
  // Servers also echo the resumeId inside eventData; accept either.
  const data = (event as { eventData?: { resumeId?: unknown } }).eventData;
  return data?.resumeId === fence.resumeId;
}

/**
 * Classify the log against the fence, or `undefined` when the fenced event may
 * still commit. A receipt anywhere in the log wins over a disposal or terminal
 * event, since it is what the replay needs.
 */
export function classifyHookResumeFence(
  events: readonly Event[],
  fence: HookResumeFence,
  runId: string
): Exclude<HookResumeFenceOutcome, 'window_elapsed'> | undefined {
  let disposed = false;
  let terminal = false;
  for (const event of events) {
    if (isFencedReceipt(event, fence)) return 'present';
    if (
      event.eventType === 'hook_disposed' &&
      event.correlationId === fence.hookId
    ) {
      disposed = true;
    } else if (
      event.runId === runId &&
      (event.eventType === 'run_completed' ||
        event.eventType === 'run_failed' ||
        event.eventType === 'run_cancelled')
    ) {
      terminal = true;
    }
  }
  if (terminal) return 'run_terminal';
  if (disposed) return 'hook_disposed';
  return undefined;
}

const FENCE_FIRST_DELAY_MS = 10;
const FENCE_MAX_DELAY_MS = 200;

export interface AwaitHookResumeFenceOptions {
  fence: HookResumeFence;
  runId: string;
  /** The current loaded log (re-read after every `reload`). */
  getEvents: () => readonly Event[];
  /** Extend the loaded log with whatever has committed since. */
  reload: () => Promise<void>;
  /** Monotonic instant the delivery's handler was entered. */
  handlerEnteredAt: number;
  /** Monotonic clock, injectable for tests. Defaults to `performance.now`. */
  now?: () => number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface HookResumeFenceResult {
  outcome: HookResumeFenceOutcome;
  /** Re-reads performed beyond the log the delivery already held. */
  reloads: number;
  /** Time spent in the fence. */
  waitedMs: number;
}

/**
 * Hold a fenced wake's replay until the fenced `hook_received` is readable,
 * proven impossible, or the window has closed (see the module doc).
 *
 * Read-only by construction: it never writes `hook_received`, so a disposal
 * that commits while the resume is in flight still refuses the producer's
 * write rather than being bypassed by the wake (vercel/workflow#3794).
 */
export async function awaitHookResumeFence(
  options: AwaitHookResumeFenceOptions
): Promise<HookResumeFenceResult> {
  const now = options.now ?? (() => performance.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const deadline =
    options.handlerEnteredAt +
    clampHookResumeFenceWindow(options.fence.windowMs);
  let reloads = 0;
  let delay = FENCE_FIRST_DELAY_MS;
  let lastReadStartedAt = Number.NEGATIVE_INFINITY;
  for (;;) {
    const state = classifyHookResumeFence(
      options.getEvents(),
      options.fence,
      options.runId
    );
    if (state !== undefined) {
      return { outcome: state, reloads, waitedMs: now() - startedAt };
    }
    // Done once a read that started at or after the deadline missed it.
    if (lastReadStartedAt >= deadline) {
      return {
        outcome: 'window_elapsed',
        reloads,
        waitedMs: now() - startedAt,
      };
    }
    const wait = Math.max(0, Math.min(delay, deadline - now()));
    if (wait > 0) await sleep(wait);
    delay = Math.min(delay * 2, FENCE_MAX_DELAY_MS);
    // Stamped right before the read. A timer that fired early leaves this
    // below the deadline, so the loop simply reads once more.
    lastReadStartedAt = now();
    await options.reload();
    reloads++;
  }
}
