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
 * 2. When the parent first awaits a child's `returnValue`, a per-run
 *    dispatcher registers the system hook {@link childRunCompletionToken}
 *    (parent), which then stays open for the rest of the run. On every await
 *    it reads the children awaited since its last read in one step. Children
 *    that already finished are answered from that read.
 * 3. The runtime that records a child's terminal event (or the SDK call that
 *    cancels it) resumes the parent's token with `{ runId, status }`. The
 *    dispatcher hands each payload to the waiting child, which then reads its
 *    result. A payload for a child nobody waits on is dropped. Between waits
 *    the dispatcher stops listening, so the open hook is inert to spec 9
 *    run-ahead; a child finishing then still wakes the parent, and its
 *    payload is buffered and dropped at the next wait. Resuming a token
 *    nobody registered (the parent never awaited a child) is a no-op.
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
 * child when it fires ({@link safetyCheckDelayMs}). A sleep cannot be
 * cancelled, so when a wait ends before its check is due the sleep outlives
 * it: the next wait reuses it, and if none is running when it fires the
 * parent gets one no-op wake. That is at most one wake per outstanding sleep,
 * and a wait due minutes out is inert to spec 9's run-ahead.
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
  /** Whether a dispatch loop is active. */
  running: boolean;
  /**
   * The parent's completion hook, registered by the first await and kept
   * open for the rest of the run (see {@link dispatch}).
   */
  hook: Hook<ChildRunCompletionPayload> | undefined;
  /** Whether the hook's registration is committed. */
  registered: boolean;
  /** Whether a `then()` on the hook is waiting for the next payload. */
  armed: boolean;
  /** Bumped per `then()`, so a superseded one does not clear `armed`. */
  armGeneration: number;
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
 * returns a promise of the child's return value that, once awaited, waits for
 * the child through the parent's completion hook. Nothing starts until the
 * first `then`, `catch` or `finally` (see {@link lazyPromise}). Returns `undefined` everywhere else (host code, steps, a
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
      hook: undefined,
      registered: false,
      armed: false,
      armGeneration: 0,
      conflicted: false,
      safety: undefined,
      safetyIndex: 0,
    };
    g[DISPATCHER] = d;
  }
  const existing = d.waits.get(childRunId) as Promise<T> | undefined;
  if (existing) return existing;

  const dispatcher = d;
  const parent = parentRunId;
  const begin = async (): Promise<T> => {
    if (!dispatcher.conflicted) {
      const done = new Promise<void>((resolve) => {
        dispatcher.waiting.set(childRunId, resolve);
      });
      dispatcher.toCheck.push(childRunId);
      dispatcher.wake?.();
      if (!dispatcher.running) {
        dispatcher.running = true;
        void dispatch(dispatcher, parent, createHook, sleep, readFinished);
      }
      await done;
    }
    // Finished (or, after a conflict, the plain poll returnValue always was).
    return await readValue();
  };
  const wait = lazyPromise(begin);
  dispatcher.waits.set(childRunId, wait);
  return wait;
}

/**
 * A promise that runs `start` on its first `then`, `catch` or `finally`
 * rather than when it is created. Reading `run.returnValue` without
 * awaiting it yet must not open the completion hook: while the hook is
 * waited on, every boundary of the parent is path-changing, so spec 9 would
 * stop running ahead for the steps between the read and the await.
 * `instanceof Promise` still holds.
 */
function lazyPromise<T>(start: () => Promise<T>): Promise<T> {
  let started: Promise<T> | undefined;
  const run = () => (started ??= start());
  const lazy = Object.create(Promise.prototype) as Promise<T>;
  Object.defineProperties(lazy, {
    then: {
      value: (onFulfilled?: any, onRejected?: any) =>
        run().then(onFulfilled, onRejected),
    },
    catch: { value: (onRejected?: any) => run().catch(onRejected) },
    finally: { value: (onFinally?: any) => run().finally(onFinally) },
  });
  return lazy;
}

/** Hands a child its "done" signal, once. */
function release(d: Dispatcher, runId: string): void {
  const resolve = d.waiting.get(runId);
  if (!resolve) return;
  d.waiting.delete(runId);
  resolve();
}

// Same symbol as `HOOK_RELEASE_AWAITER` in `workflow/hook.ts` (and the
// QuickJS engine's hooks): drops the pending `then()` without disposing.
const HOOK_RELEASE_AWAITER = Symbol.for('WORKFLOW_HOOK_RELEASE_AWAITER');

/**
 * Waits for the hook's next payload, unless already waiting. The payload
 * releases its child (a child nobody waits on is a no-op) and nudges the
 * parked loop, which re-arms while children are still waiting.
 */
function arm(d: Dispatcher, hook: Hook<ChildRunCompletionPayload>): void {
  if (d.armed) return;
  d.armed = true;
  const generation = ++d.armGeneration;
  hook.then(
    (payload) => {
      if (d.armGeneration === generation) d.armed = false;
      release(d, payload.runId);
      d.wake?.();
    },
    () => {
      // Taken over by another run, or a payload that cannot be read: stop
      // using the hook, and let every waiting child poll its own result.
      if (d.armGeneration === generation) d.armed = false;
      d.conflicted = true;
      for (const runId of [...d.waiting.keys()]) release(d, runId);
      d.wake?.();
    }
  );
}

/**
 * Stops waiting for the next payload. A payload landing from now on is
 * buffered on the hook for the next `arm()`. Without this, the leftover
 * `then()` would keep the hook observed, and spec 9 would drain instead of
 * running ahead until some child resumed it.
 */
function disarm(d: Dispatcher, hook: Hook<ChildRunCompletionPayload>): void {
  if (!d.armed) return;
  d.armed = false;
  d.armGeneration++;
  (hook as unknown as Record<symbol, (() => void) | undefined>)[
    HOOK_RELEASE_AWAITER
  ]?.();
}

async function dispatch(
  d: Dispatcher,
  parentRunId: string,
  createHook: CreateHook,
  sleep: Sleep,
  readFinished: (runIds: string[]) => Promise<string[]>
): Promise<void> {
  // One hook for the rest of the run, opened by the first await. It is not
  // disposed between waits: re-registering it would cost a serial
  // `hook_created` (and `hook_disposed`) per wait, and an open completion
  // hook nobody is waiting on is inert to spec 9's run-ahead, like any
  // unawaited hook (`isAlwaysObservedHook` in `out-of-band-observation.ts`).
  // The cost is that a child the parent never awaits still resumes it when
  // it finishes, which wakes the parent for a replay that changes nothing.
  d.hook ??= createHook({
    token: childRunCompletionToken(parentRunId),
    isSystem: true,
  });
  const hook = d.hook;
  try {
    if (!d.registered) {
      // Commit the registration before reading any child: a resume a child
      // issues from here on lands on this hook, and one it issued earlier
      // means it was already terminal, which the read below observes.
      // `getConflict()` rejects instead of resolving when it cannot construct
      // the conflicting `Run`; either way the token is held elsewhere.
      const conflict = await hook.getConflict().catch(() => true);
      if (conflict !== null) {
        d.conflicted = true;
        for (const runId of [...d.waiting.keys()]) release(d, runId);
        d.toCheck.length = 0;
        return;
      }
      d.registered = true;
    }
    if (d.safety === undefined) d.safetyIndex = 0;

    while (d.waiting.size > 0 && !d.conflicted) {
      if (d.toCheck.length > 0) {
        const runIds = d.toCheck.splice(0);
        for (const runId of await readFinished(runIds)) release(d, runId);
        continue;
      }
      arm(d, hook);
      if (d.safety === undefined) {
        const safety = sleep(safetyCheckDelayMs(d.safetyIndex));
        d.safety = safety;
        void safety.then(() => {
          if (d.safety === safety) d.safety = undefined;
        });
      }
      const safety = d.safety;
      // Settled by a payload (see `arm`) or by a newly awaited child.
      const nudge = new Promise<'nudge'>((resolve) => {
        d.wake = () => resolve('nudge');
      });
      const wakeup = await Promise.race([
        safety.then(() => 'safety' as const),
        nudge,
      ]);
      d.wake = undefined;
      if (wakeup === 'safety') {
        // A notification may have been lost: read every pending child again.
        if (d.safety === safety) d.safety = undefined;
        d.safetyIndex++;
        d.toCheck.push(...d.waiting.keys());
      }
    }
  } catch {
    // The batched status read failed for good. It is only a shortcut: hand
    // every waiting child back to its own `readValue`, which polls until the
    // child is terminal and surfaces any error of its own, so one unreadable
    // child cannot fail its siblings. A later await starts a fresh loop.
    d.toCheck.length = 0;
    for (const runId of [...d.waiting.keys()]) release(d, runId);
  } finally {
    // The hook stays open, but nothing waits on it between waits.
    disarm(d, hook);
    d.running = false;
  }
}
