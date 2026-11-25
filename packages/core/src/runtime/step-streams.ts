import { WorkflowRuntimeError } from '@workflow/errors';

import { envNumber } from '@workflow/world/env-config';
import type { FlushableStreamState } from '../flushable-stream.js';

export const STEP_STREAM_DRAIN_TIMEOUT_MS = 30_000;

export function getStepStreamDrainTimeoutMs(): number {
  return envNumber(
    'WORKFLOW_STEP_STREAM_DRAIN_TIMEOUT_MS',
    STEP_STREAM_DRAIN_TIMEOUT_MS,
    { integer: true, min: 1 }
  );
}

export function isClientDisconnectError(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === 'AbortError' || name === 'ResponseAborted';
}

export async function settleReleasedStepStreams(
  states: FlushableStreamState[]
): Promise<void> {
  if (states.length === 0) return;

  const timeoutMs = getStepStreamDrainTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(
        states.map((state) =>
          (state.settleReleasedWrites?.() ?? Promise.resolve(false)).catch(
            (error) => {
              // A disconnected client may abandon one response stream, but it
              // must not let that rejection bypass durability waits for other
              // streams written by the same step.
              if (
                !isClientDisconnectError(error) &&
                !state.failureDeliveredToStep
              ) {
                throw error;
              }
              return false;
            }
          )
        )
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new WorkflowRuntimeError(
                `Timed out draining step stream writes after ${timeoutMs}ms`
              )
            ),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    if (!isClientDisconnectError(error)) throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * The step's ops, with the completion of each stream whose failure was
 * delivered to the step body excused. Call it only after the body returned
 * normally: the body saw the failure and carried on, so it handled it.
 */
export function excuseHandledStreamFailures(
  ops: Promise<unknown>[],
  states: FlushableStreamState[]
): { ops: Promise<unknown>[]; handled: FlushableStreamState[] } {
  const handled = states.filter((state) => state.failureDeliveredToStep);
  if (handled.length === 0) return { ops, handled };
  const excused = new Set<Promise<unknown>>(
    handled.map((state) => state.promise)
  );
  return {
    ops: ops.map((op) => (excused.has(op) ? op.catch(() => {}) : op)),
    handled,
  };
}
