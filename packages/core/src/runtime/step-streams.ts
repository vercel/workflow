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
              if (!isClientDisconnectError(error)) throw error;
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
