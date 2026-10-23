import { WorkflowWorldError } from '@workflow/errors';
import { runtimeLogger } from '../../logger.js';

/** Default of {@link getOrchestratorReadTimeoutMs}, in milliseconds. */
export const DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS = 5_000;

/**
 * How many times {@link readWithDeadline} sends a read whose attempts all run
 * out of time before it gives up.
 */
export const ORCHESTRATOR_READ_ATTEMPTS = 3;

/**
 * How long the first attempt at an orchestrator's incremental log read may
 * take before it is abandoned and sent again
 * (`WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS`, default
 * {@link DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS}); each later attempt gets
 * twice as long as the one before. Such a read returns only what was
 * appended since the last one, so it is small, and a World answers it in
 * tens of milliseconds. One that has not answered after this long is
 * usually held somewhere between the World and the process, and a fresh
 * request for the same position is answered in the usual time; the longer
 * later attempts let a read that is slow because it carries large payloads
 * still finish. `0` disables the deadline.
 */
export function getOrchestratorReadTimeoutMs(
  env: Record<string, string | undefined> = process.env
): number {
  const raw = env.WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS;
  if (raw === undefined || raw === '') {
    return DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_ORCHESTRATOR_READ_TIMEOUT_MS;
}

const TIMED_OUT = Symbol('timed out');

/**
 * Runs a log read under a deadline, sending it again, up to `attempts` times
 * in all, when an attempt runs out of time. The first attempt gets
 * `timeoutMs`, and each later one twice the time of the one before.
 *
 * `read` must be safe to repeat: the orchestrator's reads are, since each
 * attempt asks for the same position and nothing is folded into the log
 * until one returns. An abandoned attempt's signal is aborted, so a World
 * that honors it cancels the request; its outcome, whenever it settles, is
 * dropped. When every attempt runs out of time the read fails with a
 * retryable `TIMEOUT` World error, so the delivery is redelivered rather than
 * held.
 *
 * A read that fails on its own (not by the deadline) fails at once, as it
 * would without the deadline. `timeoutMs <= 0` runs `read` once, with no
 * deadline and no signal.
 */
export async function readWithDeadline<T>(
  read: (signal: AbortSignal | undefined) => Promise<T>,
  options: {
    timeoutMs: number;
    attempts?: number;
    /** What is being read, for the log line and the error. */
    label: string;
    runId: string;
  }
): Promise<T> {
  const { timeoutMs, label, runId } = options;
  if (timeoutMs <= 0) return read(undefined);
  const attempts = Math.max(1, options.attempts ?? ORCHESTRATOR_READ_ATTEMPTS);
  for (let attempt = 1; ; attempt++) {
    const attemptTimeoutMs = timeoutMs * 2 ** (attempt - 1);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), attemptTimeoutMs);
    });
    const pending = read(controller.signal);
    let outcome: T | typeof TIMED_OUT;
    try {
      outcome = await Promise.race([pending, deadline]);
    } finally {
      clearTimeout(timer);
    }
    if (outcome !== TIMED_OUT) return outcome;
    const error = new WorkflowWorldError(
      `${label} did not answer within ${attemptTimeoutMs}ms (attempt ${attempt} of ${attempts})`,
      { code: 'TIMEOUT' }
    );
    controller.abort(error);
    // Settles on the World's schedule, if ever; nothing reads it.
    pending.catch(() => undefined);
    runtimeLogger.warn('Event log read timed out', {
      workflowRunId: runId,
      read: label,
      timeoutMs: attemptTimeoutMs,
      attempt,
      attempts,
    });
    if (attempt >= attempts) throw error;
  }
}
