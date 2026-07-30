/**
 * Kill Switch — cross-process cancellation flag backed by a
 * durable workflow.
 *
 * THE PATTERN:
 *   1. KillSwitch.create(id) spawns a coordination workflow
 *      that races a manual abort hook against a TTL sleep.
 *   2. Any process that creates a controller with the same semantic ID gets
 *      a handle to the same underlying run — no runId sharing required.
 *   3. .abort() resumes the hook; .signal returns an AbortSignal that fires
 *      when the hook fires or the TTL expires.
 *   4. The coordination workflow writes an "abort" message to its stream;
 *      .signal subscribes to that stream and calls controller.abort() on it.
 *
 * USEFUL WHEN:
 *   - Cancelling a long-running fetch when a user clicks "Cancel" on a
 *     different machine or tab.
 *   - Stopping parallel work across multiple serverless function invocations.
 *   - Propagating a stop signal to any number of subscribers across processes.
 *
 * TO ADAPT THIS TO YOUR USE CASE:
 *   - Pass a meaningful semantic ID (job ID, request ID, session ID) that
 *     all participants can derive without coordination.
 *   - Tune ttlMs (default 24h) for short-lived operations.
 *   - Tune graceMs (default 1h) — how long after TTL the stream stays open
 *     for late subscribers to observe the abort.
 *   - Pass controller.signal to any fetch() or async operation that respects
 *     AbortSignal — including OpenAI SDK, axios, and Node.js streams.
 *
 * DOCS: https://workflow-sdk.dev/patterns/kill-switch
 */
import { defineHook, getWritable, sleep } from 'workflow';
import { getHookByToken, getRun, start } from 'workflow/api';

export const abortHook = defineHook<{ reason?: string }>();

export type AbortMessage = {
  type: 'abort';
  reason?: string;
  expired?: boolean;
};

function getAbortToken(id: string): string {
  return `abort:${id}`;
}

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

// Coordination workflow — races a manual abort against TTL expiration.
// The result is written to the run's stream so any .signal subscriber
// receives it regardless of when they connect.
export async function killSwitchWorkflow(
  id: string,
  ttlMs: number,
  graceMs: number
) {
  'use workflow';

  const startTime = Date.now();
  const hook = abortHook.create({ token: getAbortToken(id) });

  const result = await Promise.race([
    hook.then((payload) => ({ reason: payload.reason, expired: false })),
    sleep(`${ttlMs}ms`).then(() => ({
      reason: 'Controller expired',
      expired: true,
    })),
  ]);

  await writeAbortSignal(result.reason, result.expired);

  // On TTL expiry, sleep through the grace period so late subscribers
  // can still observe the abort event from the stream.
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
 * Distributed kill switch on top of a durable workflow. Unlike the native
 * AbortController support that ships in Workflow v5 (scoped to a single
 * run), a KillSwitch is a named, durable flag shared across processes,
 * machines, and runs.
 * Calling .abort() on any process triggers .signal on any other process
 * that created a controller with the same ID.
 */
export class KillSwitch {
  private id: string;
  readonly runId: string;

  private constructor(id: string, runId: string) {
    this.id = id;
    this.runId = runId;
  }

  /**
   * Create or reconnect by semantic ID. If a controller with this ID already
   * exists, returns a handle to it; otherwise spawns a new workflow.
   */
  static async create(
    id: string,
    options: { ttlMs?: number; graceMs?: number } = {}
  ): Promise<KillSwitch> {
    const {
      ttlMs = 24 * 60 * 60 * 1000, // 24h
      graceMs = 60 * 60 * 1000, // 1h grace for late subscribers
    } = options;
    const token = getAbortToken(id);

    // Reconnect to an existing controller if one is already running.
    const existingHook = await getHookByToken(token).catch(() => null);
    if (existingHook) {
      return new KillSwitch(id, existingHook.runId);
    }

    await start(killSwitchWorkflow, [id, ttlMs, graceMs]);

    // Adopt the REGISTERED owner's runId, not the run we just started. If
    // two create() calls raced, the loser run dies on HookConflictError —
    // and a handle pointing at the loser would have a .signal that never
    // fires. Only the winner ever registers the hook, so poll for it.
    for (let i = 0; i < 10; i++) {
      const owner = await getHookByToken(token).catch(() => null);
      if (owner) {
        return new KillSwitch(id, owner.runId);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`Kill switch "${id}" failed to register`);
  }

  /**
   * Trigger the abort signal. Idempotent — safe to call after expiry.
   */
  async abort(reason?: string): Promise<void> {
    try {
      await abortHook.resume(getAbortToken(this.id), { reason });
    } catch (error) {
      const msg = error instanceof Error ? error.message.toLowerCase() : '';
      if (msg.includes('not found') || msg.includes('expired')) {
        return; // Already aborted or expired — no-op.
      }
      throw error;
    }
  }

  /**
   * AbortSignal that fires when .abort() is called or TTL expires.
   * Cache the returned signal if you subscribe more than once.
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
