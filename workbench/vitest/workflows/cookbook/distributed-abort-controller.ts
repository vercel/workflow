/**
 * Cookbook: distributed-abort-controller pattern
 *
 * Demonstrates a distributed AbortController that uses a durable workflow
 * to coordinate cancellation signals across process boundaries.
 *
 * Usage:
 *   const controller = await DistributedAbortController.create("chat:123");
 *   controller.signal.addEventListener("abort", () => console.log("Aborted!"));
 *   await controller.abort("User cancelled");
 */
import { defineHook, getWritable, sleep } from 'workflow';
import { getHookByToken, getRun, start } from 'workflow/api';

// Default TTL: 24 hours in milliseconds
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
// Default grace period: 1 hour (keeps hook alive after abort for late subscribers)
const DEFAULT_GRACE_MS = 60 * 60 * 1000;

// Hook to trigger the abort signal
export const abortHook = defineHook<{ reason?: string }>();

// The abort message written to the stream
export type AbortMessage = {
  type: 'abort';
  reason?: string;
  expired?: boolean;
};

// Helper to create a consistent hook token from the user ID
function getAbortToken(id: string): string {
  return `abort:${id}`;
}

/**
 * Step function that writes the abort message to the stream.
 * Writing must happen inside a step, not directly in the workflow.
 */
async function writeAbortSignal(reason?: string, expired?: boolean) {
  'use step';

  const writable = getWritable<AbortMessage>();
  const writer = writable.getWriter();
  try {
    await writer.write({ type: 'abort', reason, expired });
  } finally {
    writer.releaseLock();
  }
  await writable.close();
}

/**
 * Workflow that waits for the abort hook or TTL expiration.
 * Accepts a user-provided ID to use as the hook token.
 * After abort/expiration, sleeps until TTL + grace period to keep hook
 * alive for late subscribers.
 */
export async function abortControllerWorkflow(
  id: string,
  ttlMs: number,
  graceMs: number
) {
  'use workflow';

  const startTime = Date.now();
  const hook = abortHook.create({ token: getAbortToken(id) });

  // Race: manual abort OR TTL expiration
  const result = await Promise.race([
    hook.then((payload) => ({
      reason: payload.reason,
      expired: false,
    })),
    sleep(`${ttlMs}ms`).then(() => ({
      reason: 'Controller expired',
      expired: true,
    })),
  ]);

  // Write the abort message inside a step
  await writeAbortSignal(result.reason, result.expired);

  // Only sleep through grace period on TTL expiration (keeps hook alive for late subscribers).
  // Manual aborts complete immediately — no need to keep the workflow running.
  if (result.expired) {
    const elapsed = Date.now() - startTime;
    const remainingTime = graceMs - (elapsed - ttlMs);
    if (remainingTime > 0) {
      await sleep(`${remainingTime}ms`);
    }
  }

  return { aborted: true, reason: result.reason, expired: result.expired };
}

/**
 * A distributed abort controller that works across process boundaries.
 * Uses a semantically meaningful ID (like a chat ID or task ID) to coordinate.
 *
 * Unlike the standard AbortController which only works in a single process,
 * this version uses a durable workflow to coordinate the abort signal.
 * Any process with the same ID can create/reconnect, abort, or listen.
 */
export class DistributedAbortController {
  private id: string;
  readonly runId: string;

  private constructor(id: string, runId: string) {
    this.id = id;
    this.runId = runId;
  }

  /**
   * Creates or reconnects to a distributed abort controller.
   * If a controller with this ID already exists, reconnects to it.
   * Otherwise, starts a new workflow.
   *
   * @param id - A unique, semantically meaningful ID (e.g., "chat:123")
   * @param options.ttlMs - Time-to-live in ms (default: 24 hours)
   * @param options.graceMs - Grace period after abort to keep hook alive (default: 1 hour)
   */
  static async create(
    id: string,
    options: { ttlMs?: number; graceMs?: number } = {}
  ): Promise<DistributedAbortController> {
    const { ttlMs = DEFAULT_TTL_MS, graceMs = DEFAULT_GRACE_MS } = options;
    const token = getAbortToken(id);

    // Try to find an existing run with this hook token
    const existingHook = await getHookByToken(token).catch(() => null);

    if (existingHook) {
      // Reconnect to existing controller
      return new DistributedAbortController(id, existingHook.runId);
    }

    // Create a new workflow
    const run = await start(abortControllerWorkflow, [id, ttlMs, graceMs]);
    return new DistributedAbortController(id, run.runId);
  }

  /**
   * Triggers the abort signal.
   * Can be called from any process with this controller instance.
   * Idempotent: safe to call multiple times or after the workflow has completed.
   *
   * @param reason - Optional reason for the cancellation
   */
  async abort(reason?: string): Promise<void> {
    try {
      await abortHook.resume(getAbortToken(this.id), { reason });
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      if (msg.includes('not found') || msg.includes('expired')) {
        return;
      }
      throw error;
    }
  }

  /**
   * Returns an AbortSignal that fires when abort() is called or TTL expires.
   * The signal fires with a reason indicating what triggered it.
   */
  get signal(): AbortSignal {
    const run = getRun<{
      aborted: boolean;
      reason?: string;
      expired?: boolean;
    }>(this.runId);
    const controller = new AbortController();
    const readable = run.getReadable<AbortMessage>();

    (async () => {
      const reader = readable.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value.type === 'abort') {
            const reason = value.expired
              ? `${value.reason} (expired)`
              : value.reason;
            controller.abort(reason);
            break;
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          controller.abort(
            error instanceof Error ? error.message : 'Stream read failed'
          );
        }
      } finally {
        reader.releaseLock();
      }
    })();

    return controller.signal;
  }
}
