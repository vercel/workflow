import type { Event } from '@workflow/world';

/**
 * Which out-of-band writers a replay's event log currently admits, computed
 * purely from the log.
 */
export interface OpenHookAndWaitState {
  /** A `hook_created` with no `hook_disposed`: a webhook receiver can append `hook_received`. */
  openHook: boolean;
  /** A `wait_created` with no `wait_completed`: the wait timer can append `wait_completed`. */
  openWait: boolean;
  /**
   * The earliest `resumeAt` among the open waits, as epoch milliseconds.
   * `undefined` when there is no open wait. `-Infinity` when at least one
   * open wait carries no parseable `resumeAt`: a wait whose deadline cannot
   * be read is treated as due now, so it gates exactly as an open wait did
   * before deadlines were consulted.
   */
  earliestOpenWaitResumeAtMs: number | undefined;
}

/**
 * Whether the run has a hook and/or wait that an out-of-band writer could
 * append an event for between an inline step's `step_completed` write and
 * the next replay, namely an open hook (a `hook_created` not yet
 * `hook_disposed`, which a webhook receiver can resolve with
 * `hook_received`) or an open wait (a `wait_created` not yet
 * `wait_completed`, which the wait timer can resolve with
 * `wait_completed`).
 *
 * Open waits that can fire during this invocation (see
 * {@link hasOpenWaitDueBy}) block inline deltas. Open hooks and such waits
 * disable turbo's forced optimistic start. Open hooks additionally suppress operator-enabled optimistic start
 * until the `step_started` claim succeeds; open waits leave that explicit,
 * idempotency-only opt-in alone.
 *
 * A wait that lost a `Promise.race` against a hook stays open until its timer
 * elapses (there is no event that disposes a wait), which is why the
 * deadline matters: without it a `sleep('24h')` timeout branch would hold
 * every later step boundary of the run on the slow path.
 *
 * Step-body `attr_set` writes are NOT a concern: they land before the
 * step's terminal write and are therefore already inside the returned
 * delta.
 */
export function openHookAndWaitState(events: Event[]): OpenHookAndWaitState {
  const hooks = new Set<string>();
  const waits = new Map<string, number>();
  for (const event of events) {
    switch (event.eventType) {
      case 'hook_created':
        hooks.add(event.correlationId);
        break;
      case 'hook_disposed':
        hooks.delete(event.correlationId);
        break;
      case 'wait_created':
        waits.set(event.correlationId, resumeAtMs(event.eventData?.resumeAt));
        break;
      case 'wait_completed':
        waits.delete(event.correlationId);
        break;
    }
  }
  let earliestOpenWaitResumeAtMs: number | undefined;
  for (const at of waits.values()) {
    if (
      earliestOpenWaitResumeAtMs === undefined ||
      at < earliestOpenWaitResumeAtMs
    ) {
      earliestOpenWaitResumeAtMs = at;
    }
  }
  return {
    openHook: hooks.size > 0,
    openWait: waits.size > 0,
    earliestOpenWaitResumeAtMs,
  };
}

/**
 * `resumeAt` is a `Date` once the World has parsed the event, but a log
 * assembled from a raw wire payload can still carry it as an ISO string or a
 * number. Anything that does not yield a finite timestamp is `-Infinity`,
 * the "due now" sentinel documented on
 * {@link OpenHookAndWaitState.earliestOpenWaitResumeAtMs}.
 */
function resumeAtMs(resumeAt: unknown): number {
  let ms: number;
  if (resumeAt instanceof Date) {
    ms = resumeAt.getTime();
  } else if (typeof resumeAt === 'number') {
    ms = resumeAt;
  } else if (typeof resumeAt === 'string') {
    ms = new Date(resumeAt).getTime();
  } else {
    return -Infinity;
  }
  return Number.isFinite(ms) ? ms : -Infinity;
}

/**
 * Whether an open wait is due at or before `deadlineMs` (epoch ms), so its
 * `wait_completed`, or the resume invocation carrying it, could arrive while
 * the caller is still exposed. A wait whose deadline is already past, or
 * cannot be read, is due. A log with no open wait is not.
 *
 * The runtime passes the end of the invocation's inline window plus a skew
 * allowance; the reasoning is on `OPEN_WAIT_CLOCK_SKEW_MS`.
 */
export function hasOpenWaitDueBy(
  state: Pick<OpenHookAndWaitState, 'openWait' | 'earliestOpenWaitResumeAtMs'>,
  deadlineMs: number
): boolean {
  if (!state.openWait || state.earliestOpenWaitResumeAtMs === undefined) {
    return false;
  }
  return state.earliestOpenWaitResumeAtMs <= deadlineMs;
}
