/**
 * Writers: the scenario's unit of scheduling.
 *
 * The property under test is that a workflow run has **several concurrent
 * writers appending to one event log with no serializable isolation between
 * them**. The orchestrator loads the log, replays the workflow against it, and
 * commits what that decides; each step body writes its own result; a webhook
 * receiver writes a `hook_received` whenever it likes. Nothing sequences those
 * against each other, and the World API exposes no primitive that could — at
 * most an optimistic fence, which is two checks and not isolation:
 *
 * - `stateUpdatedAt` is a high-water mark on one class of write ("is there an
 *   out-of-band event newer than my snapshot?"). It sees a log truncated at the
 *   end; it cannot see a hole in the middle.
 * - a count of the events the caller loaded at or below that mark closes the
 *   hole, but only for events already committed when the write is checked, and
 *   only within a bounded window of the log's tail. It is also dark in
 *   production, since no client sends the count (`countGuard` arms it).
 *
 * So a hole in the middle is what the step-vs-step scenarios exploit, and a hole
 * that opens *after* the write it should have fenced is beyond either check.
 *
 * A real deployment resolves that by racing. This module resolves it by
 * *naming* the writers and letting a scenario advance them one at a time, so
 * the interleaving is a statement in the script rather than an accident:
 *
 * ```ts
 * const wf   = sim.writer.orchestrator();
 * const slow = sim.writer.step('slow');
 *
 * await wf.runToEventCommitted('step_started', 'reserveInventory');
 * await sim.deliverHook('approval:doc-1', { approved: true });
 * await wf.release();
 * ```
 *
 * The hook is committed after `step_started` is durable and before the workflow
 * resumes, because the orchestrator is *stopped inside the call that committed
 * it*. That is a fact about the run, not a race the scenario won.
 *
 * ## Level-triggered, deliberately
 *
 * `runTo` consults the history of points each writer has already reached before
 * arming anything. If the point has gone by it throws, naming the call it
 * happened at. The alternative — arm a watch and wait — is a hang: a held call
 * blocks its writer, and in the limit blocks the scheduler, so there is no
 * quiescence to fall back on and no timer to eventually fire. An edge-triggered
 * wait on an edge that has passed is the one way to lose the termination
 * guarantee this package is built around, so it is made impossible rather than
 * merely documented.
 *
 * ## What is not offered
 *
 * Writers form a dependency graph — the orchestrator awaits its own step
 * bodies — so not every interleaving exists to be asked for, and an
 * unsatisfiable `runTo` can only be reported, not prevented. Each wait
 * therefore carries its own wall-clock budget and, on expiry, reports where
 * every writer was standing.
 *
 * Concurrent *invocations* are also out of reach: the scheduler delivers one
 * queue message at a time, so `orchestrator` names one delivery's worth of
 * orchestration. Two step bodies inside one delivery are genuinely concurrent
 * and separately steerable, which is enough to reach the interesting corruption
 * without a second invocation.
 */

import type {
  CallMatch,
  CallPhase,
  Held,
  ObservedPoint,
  RunToOptions,
  WorldCallName,
  Writer,
  WriterHandles,
  WriterId,
} from './types.js';
import type { SimWorld } from './world.js';

/**
 * Thrown when a `runTo` names a point its writer has already gone past. Not a
 * simulator failure — a scenario that armed too late.
 */
export class AlreadyPassedError extends Error {
  override readonly name = 'AlreadyPassedError';
}

/** Thrown when a `runTo` blows its own wall-clock budget. */
export class RunToTimeoutError extends Error {
  override readonly name = 'RunToTimeoutError';
}

/** A hold armed but not yet reached. `cancel` disposes it and rejects the wait. */
export interface ArmedHold {
  reached: Promise<{ ctx: Held['ctx']; release(): void }>;
  cancel(reason: Error): void;
}

/** How a hold gets armed. Supplied by the tempo layer. */
export type Arm = (match: CallMatch, label: string) => ArmedHold;

export interface WriterRegistry {
  handles: WriterHandles;
  /** Where every writer is standing right now, for an error report. */
  describe(): string;
  /** Forget every local hold, because the scenario released them wholesale. */
  forgetHolds(): void;
}

/** The fields that identify a point, shared by the watch and the level check. */
interface PointSpec {
  phase: CallPhase;
  eventTypes?: string[];
  calls?: WorldCallName[];
  stepName?: string;
  token?: string;
  correlationId?: string;
  /** Mirrors `CallMatch.failed`; `undefined` accepts either outcome. */
  failed?: boolean;
}

function asOptions(options: string | RunToOptions | undefined): RunToOptions {
  return typeof options === 'string' ? { stepName: options } : (options ?? {});
}

function toArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

function describePoint(spec: PointSpec): string {
  const bits = [
    ...(spec.eventTypes ?? []),
    ...(spec.calls ?? []),
    spec.stepName ? `step=${spec.stepName}` : '',
    spec.token ? `token=${spec.token}` : '',
    spec.correlationId ? `correlation=${spec.correlationId}` : '',
  ].filter(Boolean);
  const where = spec.phase === 'before' ? 'produced' : 'committed';
  return `${bits.join(' ') || 'any call'} (${where})`;
}

/** Does a remembered point satisfy the spec? The level-triggered half. */
function pointMatches(spec: PointSpec, point: ObservedPoint): boolean {
  if (point.phase !== spec.phase) return false;
  if (spec.eventTypes) {
    if (point.call !== 'events.create') return false;
    if (!point.eventType || !spec.eventTypes.includes(point.eventType)) {
      return false;
    }
  } else if (spec.calls && !spec.calls.includes(point.call)) {
    return false;
  }
  if (spec.stepName && point.stepName !== spec.stepName) return false;
  if (spec.token && point.token !== spec.token) return false;
  if (spec.correlationId && point.correlationId !== spec.correlationId) {
    return false;
  }
  if (spec.failed !== undefined && spec.failed !== point.failed) return false;
  return true;
}

export function createWriters(deps: {
  world: SimWorld;
  arm: Arm;
  defaultTimeoutMs: number;
}): WriterRegistry {
  const { world, arm } = deps;
  const created: {
    label: string;
    heldAt(): string | undefined;
    forget(): void;
  }[] = [];

  /** The last few points a writer reached, for an error report. */
  function recentPoints(pred: (writer: WriterId) => boolean): string {
    const points = world
      .callHistory()
      .filter((p) => pred(p.writer))
      .slice(-4)
      .map(
        (p) =>
          `#${p.seq} ${p.call}:${p.phase}${p.eventType ? ` ${p.eventType}` : ''}${
            p.stepName ? `/${p.stepName}` : ''
          }`
      );
    return points.length > 0 ? points.join(', ') : 'nothing yet';
  }

  /**
   * Where in the recorded history a reached hold sits.
   *
   * The watch hands over a `CallContext`, and a call is recorded once per phase
   * under the same `seq`, so the pair identifies the record. Searching from the
   * end finds it immediately in the normal case. A history that hit its cap has
   * stopped recording, so fall back to "everything recorded is behind us" —
   * over-consuming is safe, under-consuming would report a spurious miss.
   */
  function ordinalReached(ctx: Held['ctx']): number {
    const history = world.callHistory();
    for (let i = history.length - 1; i >= 0; i--) {
      const point = history[i];
      if (point.seq === ctx.seq && point.phase === ctx.phase) {
        return point.ordinal;
      }
    }
    return history.length > 0 ? history[history.length - 1].ordinal : -1;
  }

  function describe(): string {
    const parts = created.map((w) => {
      const at = w.heldAt();
      return at ? `${w.label} HELD at ${at}` : `${w.label} running`;
    });
    const seen = handles.seen();
    parts.push(`writers seen: ${seen.join(', ') || 'none'}`);
    return parts.join('; ');
  }

  function makeWriter(
    id: WriterId,
    label: string,
    pred: (writer: WriterId) => boolean
  ): Writer {
    /**
     * How far this writer has been advanced, as a history ordinal. Points at or
     * before it are "already consumed" and do not count as already-passed:
     * asking twice for `step_completed` means the *next* one, which is what the
     * duplicate-delivery scenarios need. A consumed point with no successor is
     * therefore not an error here — it is the per-`runTo` timeout's business.
     */
    let watermark = -1;
    let hold: { ctx: Held['ctx']; release(): void; done: boolean } | undefined;

    const release = async (): Promise<void> => {
      if (!hold || hold.done) return;
      hold.done = true;
      const target = hold;
      hold = undefined;
      target.release();
      // Yield a full turn so that once this resolves the released writer has
      // actually moved. Without it `await release()` returns while the call is
      // still sitting in the microtask queue, and a scenario that reads the log
      // straight afterwards sees the state it was trying to leave behind.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    };

    async function runTo(
      spec: PointSpec,
      options: RunToOptions
    ): Promise<Held> {
      const what = describePoint(spec);
      const name = options.label ?? `${label} -> ${what}`;

      // The level-triggered check. `where` is a predicate on world state at the
      // moment of the point, and world state has moved on since, so it cannot
      // be re-evaluated against history: with a `where` this degrades to
      // edge-triggered and leans on the timeout instead.
      if (!options.where) {
        const passed = world
          .callHistory()
          .find(
            (p) =>
              p.ordinal > watermark && pred(p.writer) && pointMatches(spec, p)
          );
        if (passed) {
          throw new AlreadyPassedError(
            `${label} has already passed ${what} — it happened at call #${passed.seq}` +
              (passed.depth > 0
                ? `, inside another call the scenario was holding, where a hold is not possible`
                : '') +
              `.\n` +
              `runTo is level-triggered: it reports a missed point instead of arming a hold ` +
              `that can never fire, because a hold that never fires is a hang.\n` +
              `Arm the hold before the point is reached — start every wait, then await them:\n` +
              `    const a = first.runToEventProduced('step_completed');\n` +
              `    const b = second.runToEventProduced('step_completed');\n` +
              `    await a; await b;\n` +
              `State: ${describe()}`
          );
        }
      }

      const match: CallMatch = {
        phase: spec.phase,
        writer: pred,
        ...(spec.eventTypes ? { eventType: spec.eventTypes as never } : {}),
        ...(spec.calls ? { call: spec.calls } : {}),
        ...(spec.stepName ? { stepName: spec.stepName } : {}),
        ...(spec.token ? { token: spec.token } : {}),
        ...(spec.correlationId ? { correlationId: spec.correlationId } : {}),
        ...(spec.failed !== undefined ? { failed: spec.failed } : {}),
        ...(options.where
          ? { where: (_ctx, snapshot) => options.where?.(snapshot) ?? true }
          : {}),
      };

      const armed = arm(match, name);
      const budget = options.timeoutMs ?? deps.defaultTimeoutMs;
      const timer = setTimeout(() => {
        armed.cancel(
          new RunToTimeoutError(
            `${label} did not reach ${what} within ${budget}ms.\n` +
              `State: ${describe()}\n` +
              `${label} has reached: ${recentPoints(pred)}`
          )
        );
      }, budget);

      try {
        // Advancing a writer that is already held means "let it go, then stop
        // it at the next thing" — the reading `runTo` after `runTo` invites.
        // The release happens *after* the watch is armed, and that order is
        // load-bearing: the released writer can reach the next point within the
        // same turn — the `after` phase of the very call it was held in is the
        // common case — and a watch armed afterwards would have missed it.
        await release();
        const reached = await armed.reached;
        watermark = ordinalReached(reached.ctx);
        hold = { ctx: reached.ctx, release: reached.release, done: false };
        return {
          writer: reached.ctx.writer,
          ctx: reached.ctx,
          release,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    const writer: Writer = {
      id,
      runToEventProduced: (eventType, options) => {
        const opts = asOptions(options);
        return runTo(
          {
            phase: 'before',
            eventTypes: toArray(eventType),
            ...(opts.stepName ? { stepName: opts.stepName } : {}),
            ...(opts.token ? { token: opts.token } : {}),
            ...(opts.correlationId
              ? { correlationId: opts.correlationId }
              : {}),
          },
          opts
        );
      },
      runToEventCommitted: (eventType, options) => {
        const opts = asOptions(options);
        return runTo(
          {
            phase: 'after',
            // "Committed" means committed. Without this a rejected create
            // matches too, and under the fence a `PreconditionFailedError` is
            // routine — the script would resume believing a write is durable
            // when it 412'd, and the watermark would consume the point, so the
            // retry's real commit would read as the *next* one.
            failed: false,
            eventTypes: toArray(eventType),
            ...(opts.stepName ? { stepName: opts.stepName } : {}),
            ...(opts.token ? { token: opts.token } : {}),
            ...(opts.correlationId
              ? { correlationId: opts.correlationId }
              : {}),
          },
          opts
        );
      },
      release,
      isHeld: () => hold !== undefined && !hold.done,
      history: () => world.callHistory().filter((p) => pred(p.writer)),
    };

    created.push({
      label,
      heldAt: () =>
        hold && !hold.done
          ? `${hold.ctx.call}:${hold.ctx.phase}${
              hold.ctx.request?.eventType
                ? ` ${hold.ctx.request.eventType}`
                : ''
            }`
          : undefined,
      forget: () => {
        if (hold) hold.done = true;
        hold = undefined;
      },
    });

    return writer;
  }

  const handles: WriterHandles = {
    orchestrator: () =>
      makeWriter('orchestrator', 'orchestrator', (w) => w === 'orchestrator'),
    step: (shortName) =>
      makeWriter(
        `step:${shortName}`,
        `step:${shortName}`,
        (w) => w === `step:${shortName}`
      ),
    anyStep: () =>
      makeWriter('step:*', 'any step body', (w) => w.startsWith('step:')),
    any: () => makeWriter('*', 'any writer', () => true),
    seen: () => {
      const out: WriterId[] = [];
      for (const point of world.callHistory()) {
        if (!out.includes(point.writer)) out.push(point.writer);
      }
      return out;
    },
  };

  return {
    handles,
    describe,
    forgetHolds: () => {
      for (const w of created) w.forget();
    },
  };
}
