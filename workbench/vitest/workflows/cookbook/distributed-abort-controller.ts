/**
 * Cookbook: distributed-abort-controller pattern
 *
 * Demonstrates a distributed AbortController that uses a durable workflow
 * to coordinate cancellation signals across process boundaries.
 *
 * Uses a semantically meaningful ID (like a chat ID or task ID) to coordinate:
 * 1. `create(id)` — Starts a workflow that registers a hook using the provided ID
 * 2. `getSignal(id)` — Finds the run via the hook token and returns a signal listening to its stream
 * 3. `abort(id)` — Triggers the hook which writes a cancellation message to the stream
 */
import { defineHook, getWritable } from 'workflow';
import { getHookByToken, getRun, start } from 'workflow/api';

// Hook to trigger the abort signal
export const abortHook = defineHook<{ reason?: string }>();

// The abort message written to the stream
export type AbortMessage = {
  type: 'abort';
  reason?: string;
};

// Helper to create a consistent hook token from the user ID
function getAbortToken(id: string): string {
  return `abort:${id}`;
}

/**
 * Step function that writes the abort message to the stream.
 * Writing must happen inside a step, not directly in the workflow.
 */
async function writeAbortSignal(reason?: string) {
  'use step';

  const writable = getWritable<AbortMessage>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: 'abort', reason });
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}

/**
 * Workflow that waits for the abort hook and writes to the stream.
 * Accepts a user-provided ID to use as the hook token.
 */
export async function abortControllerWorkflow(id: string) {
  'use workflow';

  // Use the user-provided ID for the hook token
  const hook = abortHook.create({ token: getAbortToken(id) });
  const { reason } = await hook;

  // Write the abort message inside a step
  await writeAbortSignal(reason);

  return { aborted: true, reason };
}

/**
 * A distributed abort controller that works across process boundaries.
 * Uses a semantically meaningful ID (like a chat ID or task ID) to coordinate.
 *
 * Unlike the standard AbortController which only works in a single process,
 * this version uses a durable workflow to coordinate the abort signal.
 * Any process with the same ID can create, abort, or listen to the signal.
 */
export class DistributedAbortController {
  /**
   * Creates a new distributed abort controller by starting a workflow.
   * The ID should be semantically meaningful (e.g., "chat:123", "task:abc").
   *
   * @param id - A unique, semantically meaningful ID
   */
  static async create(id: string): Promise<void> {
    await start(abortControllerWorkflow, { args: [id] });
  }

  /**
   * Triggers the abort signal for the given ID.
   * Can be called from any process — resumes the hook registered with this ID.
   *
   * @param id - The same ID used when creating the controller
   * @param reason - Optional reason for the cancellation
   */
  static async abort(id: string, reason?: string): Promise<void> {
    await abortHook.resume(getAbortToken(id), { reason });
  }

  /**
   * Returns an AbortSignal for the given ID.
   * Finds the run via the hook token and listens to its stream.
   *
   * @param id - The same ID used when creating the controller
   */
  static async getSignal(id: string): Promise<AbortSignal> {
    // Find the run by looking up the hook token
    const hook = await getHookByToken(getAbortToken(id));
    const run = getRun<{ aborted: boolean; reason?: string }>(hook.runId);

    const controller = new AbortController();
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
