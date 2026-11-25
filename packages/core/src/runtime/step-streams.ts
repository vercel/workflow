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
                !state.failuresDeliveredToStep?.has(error)
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
 * The step's ops, with each stream completion that rejects with a failure
 * already delivered to the step body excused. Call it only after the body
 * returned normally: the body saw that failure and carried on, so it handled
 * it. `onExcused` runs for each excused failure.
 */
export function excuseHandledStreamFailures<T>(
  ops: Promise<T>[],
  states: FlushableStreamState[],
  onExcused: (error: unknown) => void
): Promise<T | undefined>[] {
  const delivered = new Map<Promise<unknown>, Set<unknown>>();
  for (const state of states) {
    if (state.failuresDeliveredToStep?.size) {
      delivered.set(state.promise, state.failuresDeliveredToStep);
    }
  }
  if (delivered.size === 0) return ops;
  return ops.map((op) => {
    const seen = delivered.get(op);
    if (!seen) return op;
    return op.catch((error: unknown) => {
      if (!seen.has(error)) throw error;
      onExcused(error);
      return undefined;
    });
  });
}
