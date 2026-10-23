/**
 * Child-run completion: the system hook a parent workflow suspends on while
 * it awaits `run.returnValue` of a run it started, so the wait costs no
 * compute and no worker slot, and ends the moment the child finishes instead
 * of on a poll tick.
 *
 * The handshake has three parts:
 *
 * 1. `start()` called from a workflow (directly or from one of its steps)
 *    stamps `executionContext.notifyParentOnCompletion` on the child and
 *    records the parent's run id on the returned `Run`.
 * 2. When the parent awaits that `Run`'s `returnValue`, it registers a hook
 *    under {@link childRunCompletionToken}, then reads the child once. A
 *    child that already finished is answered from that read; otherwise the
 *    parent suspends on the hook.
 * 3. The runtime that records the child's terminal event (or the SDK call
 *    that cancels it) resumes that token. Resuming a token nobody registered
 *    is a no-op, so a child whose parent never awaits it costs one lookup.
 *
 * The parent registers *before* it reads, and the child resumes *after* its
 * terminal write, so whichever way the two interleave one of them sees the
 * other: a resume that finds no hook happened after the terminal write,
 * which the read (issued after registration) is then guaranteed to observe.
 *
 * This module is evaluated inside the workflow VM (it is imported by
 * `run.ts`, which is compiled into the workflow bundle), so it must stay free
 * of Node.js-only imports. It reaches the orchestrator through the same
 * `globalThis` symbols as `createHook()` and `getWorkflowMetadata()`.
 */
import type { Hook, HookOptions } from '../create-hook.js';

/**
 * Prefix of the system hook token a child run resumes when it finishes. The
 * token is derived from the child's run id alone, which is globally unique,
 * so the child can compute it without knowing anything about its parent.
 */
export const CHILD_RUN_COMPLETION_TOKEN_PREFIX = 'wkf_child_run_completion:';

/**
 * The `executionContext` key `start()` stamps on a child whose parent may
 * await it through the completion hook.
 */
export const CHILD_RUN_COMPLETION_CONTEXT_KEY = 'notifyParentOnCompletion';

/**
 * Version of the completion-hook protocol a deployment implements: whether
 * it resumes {@link childRunCompletionToken} for runs stamped with
 * {@link CHILD_RUN_COMPLETION_CONTEXT_KEY}. Advertised on the health check so
 * a cross-deployment `start()` only stamps the marker on a run whose
 * executing deployment honors it; a parent waiting on a child that never
 * resumes the hook would wait forever.
 */
export const CHILD_RUN_COMPLETION_VERSION = 1;

/** The payload a finished child resumes its parent's completion hook with. */
export interface ChildRunCompletionPayload {
  status: 'completed' | 'failed' | 'cancelled';
}

/**
 * The result of reading a run's return value without waiting for it: either
 * the run has finished (`done`, with its value; failures throw), or it has
 * not yet.
 */
export type ReturnValueRead<T> = { done: true; value: T } | { done: false };

export function childRunCompletionToken(childRunId: string): string {
  return `${CHILD_RUN_COMPLETION_TOKEN_PREFIX}${childRunId}`;
}

// Same symbols as `symbols.ts` and `workflow/get-workflow-metadata.ts`,
// spelled out so this module imports nothing at runtime.
const WORKFLOW_CREATE_HOOK = Symbol.for('WORKFLOW_CREATE_HOOK');
const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');

/**
 * Per-run memo of completion waits, keyed by child run id. It lives on the
 * VM's `globalThis`, which is fresh for every replay, so a workflow that
 * awaits the same child twice (or through two `Run` handles) shares one hook
 * instead of colliding with itself on the token, and does so the same way on
 * every replay.
 */
const COMPLETION_WAITS = Symbol.for('@workflow/core//childRunCompletionWaits');

/**
 * When called inside the workflow VM of the run that started `childRunId`,
 * waits for the child through its completion hook and returns its return
 * value. Returns `undefined` everywhere else (host code, steps, a workflow
 * that was handed someone else's `Run`), where the caller polls instead.
 *
 * `read` is the `Run`'s return-value step: `read(false)` reads the run once,
 * `read(true)` waits until it is terminal.
 */
export function awaitChildRunCompletion<T>(
  childRunId: string,
  parentRunId: string | undefined,
  read: (wait: boolean) => Promise<ReturnValueRead<T>>
): Promise<T> | undefined {
  if (!parentRunId) return undefined;
  const g = globalThis as Record<symbol, unknown>;
  const createHook = g[WORKFLOW_CREATE_HOOK] as
    | ((options?: HookOptions) => Hook<ChildRunCompletionPayload>)
    | undefined;
  const ctx = g[WORKFLOW_CONTEXT] as { workflowRunId?: string } | undefined;
  if (typeof createHook !== 'function' || ctx?.workflowRunId !== parentRunId) {
    return undefined;
  }

  let waits = g[COMPLETION_WAITS] as Map<string, Promise<T>> | undefined;
  if (!waits) {
    waits = new Map();
    g[COMPLETION_WAITS] = waits;
  }
  const existing = waits.get(childRunId);
  if (existing) return existing;

  const wait = (async () => {
    const hook = createHook({ token: childRunCompletionToken(childRunId) });
    try {
      // Commit the registration before reading the child: a resume the child
      // issues from here on lands on this hook, and one it issued earlier
      // means it was already terminal, which the read below observes.
      // `getConflict()` rejects instead of resolving when it cannot construct
      // the conflicting `Run`; either way the token is held elsewhere.
      const conflict = await hook.getConflict().catch(() => true);
      if (conflict === null) {
        const first = await read(false);
        if (first.done) return first.value;
        await hook;
      }
      // The child finished (or the token is unexpectedly held elsewhere, in
      // which case this is the plain poll `returnValue` always was).
      const result = await read(true);
      return (result as { value: T }).value;
    } finally {
      hook.dispose();
    }
  })();
  waits.set(childRunId, wait);
  return wait;
}
