/**
 * Child-run completion: the system hook a parent workflow suspends on while
 * it awaits `run.returnValue` of runs it started, so the wait costs no
 * compute and no worker slot, and ends the moment a child finishes instead of
 * on a poll tick.
 *
 * A parent has ONE completion hook, shared by all of its children:
 *
 * 1. `start()` called from a workflow (directly or from one of its steps)
 *    stamps the parent's run id on the child
 *    (`executionContext.completionParentRunId`) and records it on the
 *    returned `Run`.
 * 2. When the parent awaits a child's `returnValue`, a per-run dispatcher
 *    registers the system hook {@link childRunCompletionToken}(parent) if it
 *    is not already open, then reads every child awaited since its last read
 *    in one step. Children that already finished are answered from that read.
 * 3. The runtime that records a child's terminal event (or the SDK call that
 *    cancels it) resumes the parent's token with `{ runId, status }`. The
 *    dispatcher hands each payload to the waiting child, which then reads its
 *    result. Once no child is waiting, the hook is disposed, so children the
 *    parent never awaits do not wake it. Resuming a token nobody registered
 *    is a no-op.
 *
 * The parent registers *before* it reads, and a child resumes *after* its
 * terminal write, so whichever way the two interleave one of them sees the
 * other: a resume that finds no hook happened after the terminal write, which
 * the read (issued after registration) is then guaranteed to observe.
 *
 * A notification can still be lost: a cancellation written to the World
 * without going through the SDK, or a child whose invocation dies between its
 * terminal write and the resume. So while children are pending, the
 * dispatcher also keeps one safety-net sleep open and re-reads every pending
 * child when it fires ({@link safetyCheckDelayMs}).
 *
 * This module is evaluated inside the workflow VM (it is imported by
 * `run.ts`, which is compiled into the workflow bundle), so it must stay free
 * of runtime imports. It reaches the orchestrator through the same
 * `globalThis` symbols as `createHook()`, `sleep()` and
 * `getWorkflowMetadata()`.
 */
import type { Hook, HookOptions } from '../create-hook.js';

/**
 * Prefix of a parent's child-run completion token. The token is the parent's
 * run id behind this prefix, which is globally unique, so a child computes it
 * from the parent id it was stamped with.
 */
export const CHILD_RUN_COMPLETION_TOKEN_PREFIX = 'wkf_child_run_completion:';

/**
 * The `executionContext` key `start()` stamps on a child with the run id of
 * the parent that may await it through the completion hook.
 */
export const CHILD_RUN_COMPLETION_CONTEXT_KEY = 'completionParentRunId';

/**
 * Version of the completion-hook protocol a deployment implements: whether
 * it resumes {@link childRunCompletionToken} for runs stamped with
 * {@link CHILD_RUN_COMPLETION_CONTEXT_KEY}. Advertised on the health check so
 * a cross-deployment `start()` only stamps a run whose executing deployment
 * honors it.
 */
export const CHILD_RUN_COMPLETION_VERSION = 1;

/** The payload a finished child resumes its parent's completion hook with. */
export interface ChildRunCompletionPayload {
  runId: string;
  status: 'completed' | 'failed' | 'cancelled';
}

/**
 * Delay of the n-th safety-net re-check of pending children: 5 minutes after
 * the parent starts waiting, then doubling, capped at 6 hours. A check costs
 * one sleep and one step, so a child that runs for a day costs its parent
 * about a dozen of each, and a lost notification is noticed within one
 * interval.
 */
export function safetyCheckDelayMs(index: number): number {
  return Math.min(5 * 60_000 * 2 ** index, 6 * 60 * 60_000);
}

export function childRunCompletionToken(parentRunId: string): string {
  return `${CHILD_RUN_COMPLETION_TOKEN_PREFIX}${parentRunId}`;
}

// Same symbols as `symbols.ts` and `workflow/get-workflow-metadata.ts`,
// spelled out so this module imports nothing at runtime.
const WORKFLOW_CREATE_HOOK = Symbol.for('WORKFLOW_CREATE_HOOK');
const WORKFLOW_SLEEP = Symbol.for('WORKFLOW_SLEEP');
const WORKFLOW_CONTEXT = Symbol.for('WORKFLOW_CONTEXT');

/**
 * Per-run dispatcher state. It lives on the VM's `globalThis`, which is fresh
 * for every replay and rebuilt by the same workflow code in the same order,
 * so every replay drives the hook identically.
 */
const DISPATCHER = Symbol.for('@workflow/core//childRunCompletionDispatcher');

interface Dispatcher {
  /** One promise per awaited child, so repeated awaits share it. */
  waits: Map<string, Promise<unknown>>;
  /** Children waiting for a notification; called when it (or a read) says done. */
  waiting: Map<string, () => void>;
  /** Children awaited since the last status read. */
  toCheck: string[];
  /** Nudges a parked dispatch loop when `toCheck` grows. */
  wake: (() => void) | undefined;
  /** Whether a dispatch loop (and its hook) is active. */
  running: boolean;
  /** The token is held by another run: every child polls instead. */
  conflicted: boolean;
  /** The outstanding safety-net sleep, kept across dispatch loops. */
  safety: Promise<void> | undefined;
  safetyIndex: number;
}

type CreateHook = (
  options: HookOptions & { isSystem?: boolean }
) => Hook<ChildRunCompletionPayload>;
type Sleep = (durationMs: number) => Promise<void>;

/**
 * When called inside the workflow VM of the run that started `childRunId`,
 * waits for the child through the parent's completion hook and returns its
 * return value. Returns `undefined` everywhere else (host code, steps, a
 * workflow that was handed someone else's `Run`), where the caller polls.
 *
 * `readValue` is the child's return-value step (it polls until the child is
 * terminal, so it is only called once the child is known to be done), and
 * `readFinished` the step that reports which of a batch of runs finished.
 */
export function awaitChildRunCompletion<T>(
  childRunId: string,
  parentRunId: string | undefined,
  readValue: () => Promise<T>,
  readFinished: (runIds: string[]) => Promise<string[]>
): Promise<T> | undefined {
  if (!parentRunId) return undefined;
  const g = globalThis as Record<symbol, unknown>;
  const createHook = g[WORKFLOW_CREATE_HOOK] as CreateHook | undefined;
  const sleep = g[WORKFLOW_SLEEP] as Sleep | undefined;
  const ctx = g[WORKFLOW_CONTEXT] as { workflowRunId?: string } | undefined;
  if (
    typeof createHook !== 'function' ||
    typeof sleep !== 'function' ||
    ctx?.workflowRunId !== parentRunId
  ) {
    return undefined;
  }

  let d = g[DISPATCHER] as Dispatcher | undefined;
  if (!d) {
    d = {
      waits: new Map(),
      waiting: new Map(),
      toCheck: [],
      wake: undefined,
      running: false,
      conflicted: false,
      safety: undefined,
      safetyIndex: 0,
    };
    g[DISPATCHER] = d;
  }
  const existing = d.waits.get(childRunId) as Promise<T> | undefined;
  if (existing) return existing;

  const dispatcher = d;
  const wait = (async () => {
    if (!dispatcher.conflicted) {
      const done = new Promise<void>((resolve) => {
        dispatcher.waiting.set(childRunId, resolve);
      });
      dispatcher.toCheck.push(childRunId);
      dispatcher.wake?.();
      if (!dispatcher.running) {
        dispatcher.running = true;
        void dispatch(dispatcher, parentRunId, createHook, sleep, readFinished);
      }
      await done;
    }
    // Finished (or, after a conflict, the plain poll returnValue always was).
    return await readValue();
  })();
  dispatcher.waits.set(childRunId, wait);
  return wait;
}

/** Hands a child its "done" signal, once. */
function release(d: Dispatcher, runId: string): void {
  const resolve = d.waiting.get(runId);
  if (!resolve) return;
  d.waiting.delete(runId);
  resolve();
}

type Wakeup =
  | { kind: 'payload'; payload: ChildRunCompletionPayload }
  | { kind: 'safety' }
  | { kind: 'nudge' };

async function dispatch(
  d: Dispatcher,
  parentRunId: string,
  createHook: CreateHook,
  sleep: Sleep,
  readFinished: (runIds: string[]) => Promise<string[]>
): Promise<void> {
  const hook = createHook({
    token: childRunCompletionToken(parentRunId),
    isSystem: true,
  });
  try {
    // Commit the registration before reading any child: a resume a child
    // issues from here on lands on this hook, and one it issued earlier means
    // it was already terminal, which the read below observes. `getConflict()`
    // rejects instead of resolving when it cannot construct the conflicting
    // `Run`; either way the token is held elsewhere.
    const conflict = await hook.getConflict().catch(() => true);
    if (conflict !== null) {
      d.conflicted = true;
      for (const runId of [...d.waiting.keys()]) release(d, runId);
      d.toCheck.length = 0;
      return;
    }
    if (d.safety === undefined) d.safetyIndex = 0;

    let nextPayload: Promise<Wakeup> | undefined;
    while (d.waiting.size > 0) {
      if (d.toCheck.length > 0) {
        const runIds = d.toCheck.splice(0);
        for (const runId of await readFinished(runIds)) release(d, runId);
        continue;
      }
      nextPayload ??= hook.then((payload) => ({ kind: 'payload', payload }));
      if (d.safety === undefined) {
        const safety = sleep(safetyCheckDelayMs(d.safetyIndex));
        d.safety = safety;
        void safety.then(() => {
          if (d.safety === safety) d.safety = undefined;
        });
      }
      const safety = d.safety;
      const nudge = new Promise<Wakeup>((resolve) => {
        d.wake = () => resolve({ kind: 'nudge' });
      });
      const wakeup = await Promise.race<Wakeup>([
        nextPayload,
        safety.then(() => ({ kind: 'safety' })),
        nudge,
      ]);
      d.wake = undefined;
      if (wakeup.kind === 'payload') {
        nextPayload = undefined;
        release(d, wakeup.payload.runId);
      } else if (wakeup.kind === 'safety') {
        // A notification may have been lost: read every pending child again.
        if (d.safety === safety) d.safety = undefined;
        d.safetyIndex++;
        d.toCheck.push(...d.waiting.keys());
      }
    }
  } finally {
    // Close the hook between waits, so children the parent is not awaiting
    // cannot wake it. The next await registers it again.
    hook.dispose();
    d.running = false;
  }
}
