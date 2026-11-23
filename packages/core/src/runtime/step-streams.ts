import { WorkflowRuntimeError } from '@workflow/errors';
import type { FlushableStreamState } from '../flushable-stream.js';

/**
 * Longest a step waits for its stream writes to reach the server before it
 * completes. This is the cap on that wait: a World may allow a single stream
 * write as long or longer, and retry it, so while its stream backend hangs the
 * wait ends here with a timeout rather than with the write's own error.
 */
export const STEP_STREAM_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Waits until what a step has asked its streams to write so far is on the
 * server: every chunk passed to `write()`, awaited or not, and every requested
 * `close()`, whether or not the step still holds the writer. Chunks written
 * after the call are not waited for, so a stream that keeps being written in
 * the background does not delay completion.
 *
 * Completing the step lets the workflow continue, and the server does not
 * create streams for a run that has finished, so a write still in flight when
 * the last step completes can be refused and lost.
 *
 * Every stream is waited for even when another one fails. Rejects with the
 * first failure once all have settled, or when the wait times out.
 */
export async function settleStepStreams(
  states: FlushableStreamState[],
  timeoutMs = STEP_STREAM_DRAIN_TIMEOUT_MS
): Promise<void> {
  if (states.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled(states.map((state) => state.settleWrites?.())),
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
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
