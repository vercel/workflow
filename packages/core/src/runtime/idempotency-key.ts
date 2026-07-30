/**
 * Run scoping for queue idempotency keys.
 *
 * Every keyed enqueue the runtime performs is deduped by the world on
 * `(queue, idempotencyKey)`, and the dedupe record outlives the first delivery
 * by a long way — Vercel Queues keeps it until message-retention TTL (24h),
 * world-postgres keeps a completed-keys cache. Queue names are per workflow, not
 * per run, so any key built only from a correlation id is shared by every
 * concurrent run of that workflow the moment correlation ids stop being unique
 * per run — which is exactly what slot numbering does: the first step of every
 * run of `myWorkflow` is `step_…001`.
 *
 * A collision there is silent and total. The send is answered normally (Vercel
 * Queues v3 returns a fresh message id; only the legacy provider reported
 * duplicates), so no error surfaces in the SDK; the dispatcher records the
 * message as a duplicate and excludes it from notifications, so no callback is
 * dispatched; the orchestrator returns without a timeout and acks. The step is
 * never executed, nothing anywhere reports a failure, and the run stalls for the
 * length of the dedupe window. The inline-ownership backstop cannot recover it
 * either — that path needs a `step_started` which never happened.
 *
 * So every key carries the run it belongs to, built here rather than at each
 * call site. Keys are opaque to the worlds, so the prefix costs only length: a
 * run id plus a correlation id plus a suffix is well under the 256-char cap.
 */

/**
 * Builds a queue idempotency key scoped to `runId`. Parts are joined with `:`,
 * so a key keeps the readable shape it had before scoping was introduced.
 */
export function runScopedKey(runId: string, ...parts: string[]): string {
  return [runId, ...parts].join(':');
}
