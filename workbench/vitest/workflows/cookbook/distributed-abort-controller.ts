/**
 * Cookbook: distributed-abort-controller pattern
 *
 * Demonstrates a distributed AbortController that uses a durable workflow
 * to coordinate cancellation signals across process boundaries.
 *
 * The controller:
 * 1. Starts a workflow with a unique run ID
 * 2. Waits for a hook signal to trigger abortion
 * 3. Writes a cancellation message to the run's stream
 * 4. Returns a local AbortSignal that listens to the stream
 */
import { defineHook, getWritable, getWorkflowMetadata } from 'workflow';
import { getRun, start } from 'workflow/api';

// Hook to trigger the abort signal
export const abortHook = defineHook<{ reason?: string }>();

// The abort message written to the stream
export type AbortMessage = {
  type: 'abort';
  reason?: string;
};

/**
 * Workflow that waits for the abort hook and writes to the stream.
 * This workflow is the "coordinator" - it holds the abort state durably.
 */
export async function abortControllerWorkflow() {
  'use workflow';

  const { workflowRunId } = getWorkflowMetadata();
  const writable = getWritable<AbortMessage>();

  // Wait for the abort hook to be triggered
  const hook = abortHook.create({ token: `abort:${workflowRunId}` });
  const { reason } = await hook;

  // Write the abort message to the stream
  const writer = writable.getWriter();
  try {
    await writer.write({ type: 'abort', reason });
  } finally {
    writer.releaseLock();
  }
  await writable.close();

  return { aborted: true, reason };
}

/**
 * A distributed abort controller that works across process boundaries.
 *
 * Unlike the standard AbortController which only works in a single process,
 * this version uses a durable workflow to coordinate the abort signal.
 * The runId can be shared with any other process to allow remote cancellation.
 */
export class DistributedAbortController {
  readonly runId: string;
  #signalPromise: Promise<AbortSignal> | null = null;

  private constructor(runId: string) {
    this.runId = runId;
  }

  /**
   * Creates a new distributed abort controller by starting a workflow.
   * The workflow will wait indefinitely for an abort signal.
   */
  static async create(): Promise<DistributedAbortController> {
    const run = await start(abortControllerWorkflow);
    return new DistributedAbortController(run.runId);
  }

  /**
   * Reconnects to an existing abort controller by run ID.
   * Use this to abort or listen from a different process.
   */
  static fromRunId(runId: string): DistributedAbortController {
    return new DistributedAbortController(runId);
  }

  /**
   * Triggers the abort signal across all listeners.
   * This resumes the hook in the workflow, which writes to the stream.
   */
  async abort(reason?: string): Promise<void> {
    await abortHook.resume(`abort:${this.runId}`, { reason });
  }

  /**
   * Returns an AbortSignal that triggers when the workflow receives
   * the abort hook. The signal listens to the workflow's readable stream.
   *
   * This is lazy - the stream connection is only established when
   * this property is first accessed.
   */
  get signal(): Promise<AbortSignal> {
    if (!this.#signalPromise) {
      this.#signalPromise = this.#createSignal();
    }
    return this.#signalPromise;
  }

  /**
   * Creates a local AbortSignal that listens to the workflow's stream.
   * When an abort message arrives, the local AbortController is aborted.
   */
  async #createSignal(): Promise<AbortSignal> {
    const controller = new AbortController();
    const run = getRun<{ aborted: boolean; reason?: string }>(this.runId);
    const readable = run.getReadable<AbortMessage>();

    // Read from the stream in the background
    // When an abort message arrives, trigger the local controller
    (async () => {
      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === 'abort') {
            controller.abort(value.reason);
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
    })();

    return controller.signal;
  }
}

/**
 * Example usage workflow that demonstrates using the distributed abort controller
 * to cancel a long-running operation.
 */
export async function longRunningOperationDemo(controllerRunId: string) {
  'use workflow';

  // Reconnect to the abort controller from a different "process"
  const controller = DistributedAbortController.fromRunId(controllerRunId);
  const signal = await controller.signal;

  // Simulate checking the signal during a long operation
  const results: string[] = [];
  for (let i = 0; i < 10; i++) {
    if (signal.aborted) {
      return {
        completed: false,
        reason: signal.reason,
        progress: results,
      };
    }
    results.push(`step-${i}`);
    // In real code, you'd do actual work here
  }

  return { completed: true, progress: results };
}
