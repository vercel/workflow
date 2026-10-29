import { runSingleFlight } from '../step-single-flight.js';
import type { StepExecutionResult } from './step-executor.js';

/** Delay before a delivery that lost the single-flight is redelivered. */
export const STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS = 1;

/**
 * A step has one queue message, so two executions of one step in one process
 * are two deliveries of that message: the queue redelivered it while the
 * first delivery was still running the body (an event loop stalled past the
 * lease, or a world without an invocation kill bound). The second delivery
 * awaits the first one's settlement and then asks for the same message again
 * after a short delay instead of running the body (a `throttled` result). It
 * never acknowledges on the first one's behalf: the message is acknowledged
 * only once a terminal step event is committed, and the redelivery confirms
 * that from the log.
 *
 * Background step invocations are not fenced; a cross-instance duplicate
 * runs the body twice.
 */
export function runStepSingleFlight(
  runId: string,
  correlationId: string,
  execute: () => Promise<StepExecutionResult>,
  logLevel: 'debug' | 'warn' = 'warn'
): Promise<StepExecutionResult> {
  return runSingleFlight(
    runId,
    correlationId,
    execute,
    () => ({
      type: 'throttled',
      timeoutSeconds: STEP_SINGLE_FLIGHT_REDELIVERY_SECONDS,
    }),
    logLevel
  );
}
