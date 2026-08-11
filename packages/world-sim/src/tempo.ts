/**
 * The scripting layer: stop a writer inside a world call, act while it is held,
 * let it go.
 *
 * Everything here compiles down to one thing — a watch on a call point whose
 * action returns a promise, which blocks the intercepted call until that
 * promise settles. `Writer.runTo*` (see `writers.ts`) is the vocabulary a
 * scenario should reach for; `park` / `until` / `during` are the primitive it is
 * built from, kept public for points no writer op names.
 *
 * The hazard a script introduces is that it can wait for something that will
 * never happen, and because a held call blocks the writer that made it — and,
 * when that writer is the one the scheduler is inside, the whole loop — that is
 * a hang rather than a quiescent stall. Three things buy the termination
 * guarantee back:
 *
 *  - `runTo` is **level-triggered**: a point that has already gone by is an
 *    error naming the call it happened at, not a wait.
 *  - Each `runTo` carries **its own wall-clock budget**, and blowing it reports
 *    where every writer was standing.
 *  - The scenario arms a **global wall-clock deadline** that releases every held
 *    call and rejects every pending wait, as a last resort.
 */

import type {
  CallContext,
  CallMatch,
  Parked,
  ScenarioApi,
  Tempo,
} from './types.js';
import type { SimWorld } from './world.js';
import { type ArmedHold, createWriters } from './writers.js';

/**
 * Raised into a script's pending waits when the scenario tears down. It means
 * "the world stopped, stop waiting" — not a failure of the script — so the
 * runner does not report it as one.
 */
export class ScenarioAborted extends Error {
  override readonly name = 'ScenarioAborted';
}

export interface TempoController {
  tempo: Tempo;
  /**
   * Release everything and reject everything still waiting. Called when the
   * scenario ends, whether cleanly or on the wall-clock deadline.
   */
  abort(reason: string): void;
  /** Human-readable description of what the script is still waiting for. */
  describeWaiting(): string | undefined;
  /** Whether anything is still parked or waiting. */
  isWaiting(): boolean;
}

interface PendingWait {
  label: string;
  reject(err: Error): void;
}

export function describeMatch(match: CallMatch): string {
  const bits: string[] = [];
  if (match.eventType) {
    bits.push(
      Array.isArray(match.eventType)
        ? match.eventType.join('|')
        : match.eventType
    );
  }
  if (match.call) {
    bits.push(Array.isArray(match.call) ? match.call.join('|') : match.call);
  }
  if (match.stepName) bits.push(`step=${match.stepName}`);
  if (match.correlationId) bits.push(`correlation=${match.correlationId}`);
  if (match.token) bits.push(`token=${match.token}`);
  if (match.where) bits.push('where(...)');
  if (match.phase) bits.push(match.phase);
  return bits.join(' ') || 'any call';
}

export interface CreateTempoOptions {
  /** Wall-clock budget for a single `runTo` that does not set its own. */
  runToWallMs?: number;
}

export function createTempo(
  world: SimWorld,
  api: ScenarioApi,
  options: CreateTempoOptions = {}
): TempoController {
  /** Waits that have not been satisfied yet. */
  const waiting = new Map<number, PendingWait>();
  /** Calls currently held inside the world. */
  const held = new Map<number, { label: string; release(): void }>();
  let seq = 0;
  let abortedWith: string | undefined;

  /**
   * Arm a hold and hand back both the wait and a way to call it off.
   *
   * The watch is registered *synchronously*, before this returns, which is what
   * makes "arm two holds, then await both" work: awaiting the first would yield
   * the event loop, and the second writer may sail past its point in that gap.
   */
  function armHold(match: CallMatch, label: string): ArmedHold {
    const id = seq++;
    let settle: ((err: Error) => void) | undefined;
    let reached = false;

    const promise = new Promise<{ ctx: CallContext; release(): void }>(
      (resolve, reject) => {
        if (abortedWith) {
          reject(new ScenarioAborted(abortedWith));
          return;
        }
        settle = reject;
        // Indirect through `settle` rather than storing `reject`: `settle` is
        // replaced below with the wrapper that also disposes the watch, and
        // `abort()` walks this map. Storing the raw `reject` here would reject
        // the script's promise while leaving the watch armed — and a watch that
        // fires after an abort blocks its call on a promise whose `release` is
        // no longer reachable from anywhere, which is a hang rather than a
        // late wake-up (the global deadline is one-shot and already spent).
        waiting.set(id, { label, reject: (err: Error) => settle?.(err) });

        const dispose = world.addWatch({
          match,
          // A script's waits are not "required": a wait that never fires is
          // already reported, in more useful detail, as the script still
          // waiting or as its own timeout.
          options: { nth: 1, label },
          action: (ctx) => {
            // Belt and braces with the disposing `settle` above: never block a
            // call on behalf of a script that is no longer running to release
            // it. Returning undefined lets the call through untouched.
            if (abortedWith) return;
            reached = true;
            waiting.delete(id);
            dispose();
            // The call now blocks on this promise. Everything the script does
            // before releasing happens inside the intercepted call.
            return new Promise<void>((letGo) => {
              let released = false;
              const release = () => {
                if (released) return;
                released = true;
                held.delete(id);
                letGo();
              };
              held.set(id, { label, release });
              resolve({ ctx, release });
            });
          },
        });

        // Calling off a wait has to remove the watch, not just abandon the
        // promise: a watch left armed would later stop a writer that nobody is
        // going to release.
        settle = (err: Error) => {
          if (reached) return;
          dispose();
          waiting.delete(id);
          reject(err);
        };
      }
    );

    return {
      reached: promise,
      cancel: (reason) => settle?.(reason),
    };
  }

  const park: Tempo['park'] = async (match, label) => {
    const name = label ?? `park ${describeMatch(match)}`;
    const armed = armHold(match, name);
    const { ctx, release } = await armed.reached;
    return { ctx, release } satisfies Parked;
  };

  const until: Tempo['until'] = (match, label) => {
    const name = label ?? `until ${describeMatch(match)}`;
    if (abortedWith) return Promise.reject(new ScenarioAborted(abortedWith));
    const id = seq++;

    return new Promise<CallContext>((resolve, reject) => {
      // Same disposing-reject shape as `armHold`. A leaked watch here does not
      // hang anything — this action resolves rather than blocking — but it
      // still stops a writer for a wait nobody is listening to.
      waiting.set(id, {
        label: name,
        reject: (err: Error) => {
          dispose();
          waiting.delete(id);
          reject(err);
        },
      });
      const dispose = world.addWatch({
        match,
        options: { nth: 1, label: name },
        action: (ctx) => {
          waiting.delete(id);
          dispose();
          resolve(ctx);
        },
      });
    });
  };

  const writers = createWriters({
    world,
    arm: armHold,
    defaultTimeoutMs: options.runToWallMs ?? 5_000,
  });

  const tempo: Tempo = {
    ...api,
    // `runId` is a getter on `api`; spreading would freeze its value at
    // construction time, before the run exists.
    get runId() {
      return api.runId;
    },
    get world() {
      return api.world;
    },
    writer: writers.handles,
    park,
    until,
    async during(match, body, label) {
      const parked = await park(match, label);
      try {
        return await body(parked);
      } finally {
        parked.release();
      }
    },
  };

  return {
    tempo,
    abort(reason) {
      abortedWith = reason;
      const error = new ScenarioAborted(reason);
      for (const wait of waiting.values()) wait.reject(error);
      waiting.clear();
      // Release after rejecting, so a script woken by its own rejection does
      // not race the scheduler resuming.
      for (const entry of [...held.values()]) entry.release();
      held.clear();
      writers.forgetHolds();
    },
    describeWaiting() {
      const parts: string[] = [];
      for (const entry of held.values()) parts.push(`holding "${entry.label}"`);
      for (const wait of waiting.values())
        parts.push(`waiting for "${wait.label}"`);
      return parts.length > 0 ? parts.join('; ') : undefined;
    },
    isWaiting: () => waiting.size > 0 || held.size > 0,
  };
}
