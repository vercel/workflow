/** Default margin before the function's deadline in which no inline step starts. */
export const DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS = 60_000;

/**
 * How long before the function's max duration the orchestrator stops
 * starting inline steps (`WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS`, default
 * {@link DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS}). A step created inside the
 * margin is handed to the queue instead, so the platform does not cut a body
 * off at the deadline; a body killed that way is retried and counts as a
 * platform re-execution.
 */
export function getInlineStepDeadlineMarginMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_INLINE_STEP_DEADLINE_MARGIN_MS;
}

/** Whether an inline step may still start at `nowMs`. */
export function mayStartInlineStep(params: {
  nowMs: number;
  deadlineMs: number | undefined;
  marginMs: number;
}): boolean {
  if (params.deadlineMs === undefined) return true;
  return params.nowMs < params.deadlineMs - params.marginMs;
}
