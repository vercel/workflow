/**
 * Scenario definition and the deterministic scheduler that plays one out.
 *
 * A scenario is one workflow, its input, and a script that steers the run's
 * writers. Playing it consists of exactly one loop: take the next queue
 * message, jump the virtual clock to its delivery time, hand it to the flow
 * handler, repeat until the queue is empty. Nothing else can advance the world
 * — no timers, no background delivery, no wall-clock waiting — so the sequence
 * of world calls is reproducible.
 *
 * Termination is a hard requirement, and three separate things enforce it:
 *
 *  - **Virtual time.** A `sleep('30d')` is a queue message dated 30 days out;
 *    delivering it means moving a number, not waiting.
 *  - **Quiescence.** An empty queue ends the loop. If the run has not reached
 *    a terminal state at that point the scenario is *stalled* — reported, with
 *    the open hooks and waits that explain it, rather than hung.
 *  - **Budgets.** Delivery count, virtual span and wall time are all capped,
 *    so even a workflow that genuinely loops forever ends as a failed scenario
 *    instead of a wedged process.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { resumeHook, setWorld, start } from '@workflow/core/runtime';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@workflow/world';
import { createVirtualClock } from './clock.js';
import {
  DEFAULT_LIMITS,
  deliver,
  driveQueue,
  performanceNow,
  type ScenarioLimits,
  type SelectNext,
} from './drive.js';
import { checkInvariants } from './invariants.js';
import { verifyReplay } from './replay.js';
import { createTempo, ScenarioAborted } from './tempo.js';
import type {
  InvariantViolation,
  PendingMessageView,
  ScenarioApi,
  ScenarioScript,
  TraceEntry,
} from './types.js';
import {
  createSimWorld,
  type SimWorld,
  WORKFLOW_QUEUE_PREFIX,
} from './world.js';

/** Real-time grace period for a script to unwind after the scenario aborts it. */
const SCRIPT_UNWIND_MS = 50;

export interface ScenarioSpec {
  /**
   * Stable hyphenated handle for this scenario, e.g. `hook-at-step-started`.
   *
   * The `name` is prose and will be reworded; the id is what a commit message,
   * a bug report or a `pnpm sim <id>` invocation refers to, so it is expected
   * to outlive several rewordings of the sentence next to it.
   */
  id: string;
  name: string;
  description?: string;
  /**
   * The workflow to run: either its plain function name (resolved against the
   * build manifest) or an explicit `{ workflowId }`.
   */
  workflow: string | { workflowId: string };
  /** Arguments passed to the workflow function. */
  input?: unknown[];
  /**
   * When external input arrives and how the run's writers interleave, written
   * as a sequence of writer advances. Runs concurrently with the delivery loop
   * and starts before the run does, so it can hold the very first world call.
   *
   * A scenario with no script is a control: the run plays out on the default
   * schedule and the only question is whether the log it leaves reproduces it.
   */
  script?: ScenarioScript;
  /**
   * Override which queue message is delivered next.
   *
   * The default is total and deterministic — earliest `readyAt`, then enqueue
   * order — which is the right model for a queue whose delays are real
   * deadlines. Override it to pin an order the default would not produce, e.g.
   * to deliver a later message first and check the run tolerates it. Return a
   * `messageId` from `pending`, or `undefined` to fall back to the default.
   */
  selectNext?: SelectNext;
  /**
   * Cold-replay the committed log at the end and check it regenerates the run.
   * On by default for runs that reached `completed` or `failed`; see
   * `verifyReplay`.
   */
  verifyReplay?: boolean;
  /**
   * Assertions about how the run should end — what *correct* looks like, which
   * is not always what happens today.
   *
   * `status` accepts the non-run outcomes too (`stalled`, `budget-exceeded`),
   * because "this workflow deadlocks when the hook never arrives" is a
   * property worth pinning down rather than an accident to be tolerated.
   *
   * There is deliberately no way to expect a consistency violation. A scenario
   * that reproduces a corruption states the outcome the run *should* have had
   * and fails until the runtime delivers it: the failure is the open bug, and
   * it goes green when the bug is fixed, not when it is observed one more time.
   * Any violation fails the scenario that tripped it.
   *
   * There is also deliberately no per-world variant of this field. A scenario
   * is one sequence of advances, and the only thing a world changes is what a
   * read returns — so an expectation that has to be restated per world is
   * pinning a consequence of the reads rather than a property of the run. Pin
   * the part that holds in every world; where the branch a run takes is decided
   * by what it read, do not pin the branch. What catches the fault there is the
   * invariant, not the expectation: the log a run wrote must be a log the
   * runtime can replay back into that same run, and that sentence is true in
   * both worlds. `verifyReplay` is on by default for exactly this reason, and
   * every red in the book is red on the invariant alone — the expectations
   * could all be deleted without changing which scenarios fail.
   */
  expect?: ScenarioExpectation;
  limits?: ScenarioLimits;
  /** Enforce (and advertise) the optimistic-concurrency fence. */
  preconditionGuard?: boolean;
  /**
   * Also enforce the count half of the fence: reject a write whose caller loaded
   * fewer events at or below its watermark than the log now holds.
   *
   * Defaults to `preconditionGuard`, because that is production: a world that
   * fences at all fences with both halves. Set it to `false` alongside
   * `preconditionGuard: true` to model the watermark alone.
   */
  countGuard?: boolean;
}

export interface ScenarioExpectation {
  status?: ScenarioOutcome;
  /** Compared against the hydrated run output with deep equality. */
  output?: unknown;
}

export type ScenarioOutcome =
  | WorkflowRunStatus
  | 'stalled'
  | 'budget-exceeded'
  | 'error';

export interface ScenarioResult {
  /** The spec's stable handle. See `ScenarioSpec.id`. */
  id: string;
  name: string;
  description?: string;
  runId: string;
  outcome: ScenarioOutcome;
  ok: boolean;
  /** Scenario-level failures: unmet expectations, failed checks, script errors. */
  problems: string[];
  /** World-contract violations found by re-deriving state from the log. */
  violations: InvariantViolation[];
  /**
   * Outcome of the cold-replay check, when it ran. `skipped` carries why —
   * a cancelled or stalled run has no workflow-derived terminal event for a
   * replay to re-derive.
   */
  replay?: { deliveries: number; regenerated: number } | { skipped: string };
  events: Event[];
  trace: TraceEntry[];
  run?: WorkflowRun;
  /** Hydrated run output, when the run completed and hydration succeeded. */
  output?: unknown;
  /** Anything still queued when the loop ended. */
  pending: PendingMessageView[];
  deliveries: number;
  worldCalls: number;
  virtualElapsedMs: number;
  wallMs: number;
  /** Populated when the runner itself threw. */
  error?: unknown;
}

export interface RunScenarioOptions {
  /** The compiled flow handler (see `loadFlowHandler`). */
  handler: (req: Request) => Promise<Response>;
  /** Workflow function name → machine workflow id, from `buildSimBundle`. */
  workflowIds?: Record<string, string>;
  /**
   * Force `SimStoreOptions.preconditionGuard` on or off for this run,
   * overriding whatever the spec asked for.
   *
   * The fence exists to reject a write whose snapshot predates an out-of-band
   * event — that is, a write an extended prefix invalidated. So turning it off
   * across the whole book answers a question the book cannot otherwise ask: is
   * any scenario relying on it? If none is, then no emitter here is
   * prefix-sensitive and the fence guards against nothing; if one goes red that
   * was not red before, that scenario names the exception.
   *
   * Disabling it takes the count half with it: `countGuard` is evaluated inside
   * the same predicate, and the marker bookkeeping that both halves read is
   * gated on the same flag.
   */
  preconditionGuard?: boolean;
}

export async function runScenario(
  spec: ScenarioSpec,
  options: RunScenarioOptions
): Promise<ScenarioResult> {
  const limits = { ...DEFAULT_LIMITS, ...spec.limits };
  const clock = createVirtualClock();
  // One expectation, whichever world this is. Aliased rather than read inline
  // so the outcome check and the output check below cannot drift apart.
  const expected = spec.expect;
  // Production arms both halves of the fence, so the count follows it unless a
  // scenario says otherwise. Resolved once: reading `options ?? spec` twice
  // would let a `--no-fence` run keep a count guard the fence no longer backs.
  const preconditionGuard =
    options.preconditionGuard ?? spec.preconditionGuard ?? false;
  const world = createSimWorld({
    clock,
    preconditionGuard,
    countGuard: spec.countGuard ?? preconditionGuard,
  });

  const workflowId =
    typeof spec.workflow === 'string'
      ? options.workflowIds?.[spec.workflow]
      : spec.workflow.workflowId;

  if (!workflowId) {
    return failedBeforeStart(
      spec,
      `Unknown workflow "${String(spec.workflow)}". Known: ${Object.keys(
        options.workflowIds ?? {}
      )
        .filter((k) => !k.includes('#'))
        .sort()
        .join(', ')}`
    );
  }

  const problems: string[] = [];
  /**
   * Problems that are only problems if the scenario did not ask for them. A
   * scenario may legitimately assert that a run stalls or blows its budget —
   * those are properties worth pinning down — so the diagnosis is always
   * recorded but only counted as a failure when it was a surprise.
   */
  const outcomeProblems: string[] = [];
  let replayViolations: InvariantViolation[] = [];
  let replay: ScenarioResult['replay'];
  let virtualElapsedMs = 0;
  let deliveries = 0;
  let outcome: ScenarioOutcome | undefined;
  let runId = '';
  let thrown: unknown;

  let uninstallClock = clock.install();
  const wallStart = performanceNow();

  world.registerHandler(WORKFLOW_QUEUE_PREFIX, options.handler);

  const api: ScenarioApi = {
    world: world.snapshot,
    get runId() {
      return runId;
    },
    async deliverHook(token, payload) {
      // Go through the real `resumeHook` rather than writing `hook_received`
      // directly: the point of the simulation is to exercise the same code an
      // out-of-band webhook receiver would run, including its payload
      // dehydration, its terminal-run rejection mapping, and its re-enqueue.
      //
      // `asExternal` marks the writes as the scenario's own: they are attributed
      // to the `external` writer and are not themselves call points, so a
      // script that delivers a hook while holding a writer cannot trip one of
      // its own holds.
      await world.asExternal(() => resumeHook(token, payload));
    },
    async beginHookDelivery(token, payload) {
      return {
        async commit() {
          await world.asExternal(() => resumeHook(token, payload));
        },
      };
    },
    async cancelRun(reason) {
      await world.asExternal(() =>
        world.events.create(runId, {
          eventType: 'run_cancelled',
          specVersion: SPEC_VERSION_CURRENT,
          ...(reason ? { eventData: { cancelReason: reason } } : {}),
        })
      );
    },
    withholdNextEvent(reads) {
      world.store.withholdNextEvent(reads);
    },
    advanceTime(ms) {
      clock.advanceBy(ms);
      world.pushTrace({
        kind: 'note',
        message: `advanced virtual time by ${ms}ms`,
      });
    },
    async deliverQueued(select) {
      const pending = world.simQueue.view();
      const chosen = select ? select(pending) : pending[0]?.messageId;
      if (!chosen) return false;
      // `takeById` removes it from pending, so the delivery loop cannot pick
      // the same message up: the two never race for one message, they only run
      // two different ones at once.
      const message = world.simQueue.takeById(chosen);
      if (!message) return false;
      clock.advanceTo(message.readyAtMs);
      await deliver(world, message);
      return true;
    },
    note(message) {
      world.pushTrace({ kind: 'note', message });
    },
    check(name, condition) {
      world.pushTrace({ kind: 'check', name, ok: condition });
      if (!condition) problems.push(`check failed: ${name}`);
    },
  };
  world.setScenarioApi(() => api);

  // The script steers writers by watching world calls, so its machinery must
  // exist before anything can fire — and it is launched before `start()` so it
  // can hold the very first world call the run makes.
  const controller = createTempo(world, api, {
    runToWallMs: Math.min(limits.maxRunToWallMs, limits.maxWallMs),
  });
  let scriptSettled = spec.script === undefined;
  let scriptError: unknown;
  const scriptDone = spec.script
    ? (async () => spec.script?.(controller.tempo))()
        .catch((err) => {
          scriptError = err;
        })
        .finally(() => {
          scriptSettled = true;
        })
    : undefined;

  /**
   * Real-time backstop. A parked call blocks the scheduler, so a script that
   * waits for something that never happens is a hang, not a stall — the one
   * way to lose the termination guarantee. This buys it back, and it has to be
   * wall-clock: the virtual clock is precisely what stops advancing.
   *
   * It is armed slightly past the loop's own wall budget so that whenever the
   * loop is able to notice the overrun itself, it reports it with the better
   * diagnosis; this fires only when the loop is blocked inside a held call.
   */
  const deadline = setTimeout(() => {
    const reason =
      `scenario exceeded its ${limits.maxWallMs}ms wall-clock budget while the ` +
      'script held or awaited a world call';
    world.pushTrace({ kind: 'warn', message: reason });
    problems.push(reason);
    controller.abort(reason);
  }, limits.maxWallMs + 250);
  // Deliberately NOT unref'd. A total deadlock — every writer parked, the
  // scheduler blocked inside a held call, the script awaiting something that
  // can never happen — leaves nothing else on the event loop. An unref'd
  // watchdog does not hold the loop open, so Node would empty it and exit with
  // a bare "unsettled top-level await" instead of this timer firing: the
  // watchdog would be absent from the one case it exists for. The `finally`
  // below clears it, so keeping it ref'd cannot outlive the scenario.

  setWorld(world);

  try {
    const run = await start({ workflowId }, (spec.input ?? []) as unknown[]);
    runId = run.runId;

    const drain = await driveQueue({
      world,
      limits,
      wallStart,
      selectNext: spec.selectNext,
    });
    deliveries = drain.deliveries;
    if (drain.exceeded) {
      outcome = 'budget-exceeded';
      outcomeProblems.push(drain.exceeded);
    }

    // ---- Replay verification ---------------------------------------------
    // Snapshot the run's own virtual span first: the replay reuses the clock
    // (it has to — `Date.now()` is what tells the runtime a wait has elapsed)
    // and would otherwise show up in the scenario's reported timings.
    virtualElapsedMs = clock.elapsed();
    const finished = world.store.allRuns().find((r) => r.runId === runId);
    if (spec.verifyReplay === false) {
      replay = { skipped: 'disabled for this scenario' };
    } else if (!finished) {
      replay = { skipped: 'no run entity' };
    } else if (
      finished.status !== 'completed' &&
      finished.status !== 'failed'
    ) {
      // A cancelled run's terminal event came from an operator, not from the
      // workflow, and a stalled run has none at all — in neither case is there
      // a workflow-derived answer for a replay to reproduce.
      replay = {
        skipped: `run ended "${finished.status}", which the workflow did not derive`,
      };
    } else {
      // `verifyReplay` installs a clock of its own, pinned to the instant the
      // run ended, so this one has to step aside for the duration.
      uninstallClock();
      let check: Awaited<ReturnType<typeof verifyReplay>>;
      try {
        check = await verifyReplay({
          run: finished,
          events: world.store.allEvents(runId),
          handler: options.handler,
          limits,
        });
      } finally {
        uninstallClock = clock.install();
        setWorld(world);
      }
      replayViolations = check.violations;
      replay = {
        deliveries: check.deliveries,
        regenerated: check.regenerated.length,
      };
      world.pushTrace({
        kind: 'note',
        message:
          `replay check: cold-started from the committed log in ${check.deliveries} ` +
          `delivery(ies), re-derived ${check.regenerated.length} event(s)` +
          (check.violations.length === 0 ? ' — matches' : ' — MISMATCH'),
      });
    }
  } catch (err) {
    thrown = err;
    outcome = 'error';
    problems.push(
      `scenario threw: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    // The loop is done, so nothing can satisfy a script still waiting on the
    // world. Report what it wanted before tearing its waits down.
    const stillWaiting = controller.describeWaiting();
    if (!scriptSettled && stillWaiting) {
      problems.push(`script never finished — ${stillWaiting}`);
    }
    controller.abort('scenario ended');
    clearTimeout(deadline);

    // Give the script a bounded moment to unwind from the rejections `abort`
    // just raised into it. Awaiting it outright would reintroduce the hang
    // this whole mechanism exists to prevent: a script parked on a promise
    // that never settles (rather than on the world) is unreachable from here.
    await Promise.race([scriptDone, sleep(SCRIPT_UNWIND_MS)]);
    if (!scriptSettled && !stillWaiting) {
      problems.push(
        'script never finished — it is blocked on something outside the world'
      );
    }
    if (
      scriptError !== undefined &&
      !(scriptError instanceof ScenarioAborted)
    ) {
      problems.push(
        `script threw: ${
          scriptError instanceof Error
            ? scriptError.message
            : String(scriptError)
        }`
      );
    }
    world.streamer.abortOpenReaders();
    setWorld(undefined);
    uninstallClock();
  }

  const wallMs = performanceNow() - wallStart;
  const events = runId ? world.store.allEvents(runId) : [];
  const runEntity = runId
    ? world.store.allRuns().find((r) => r.runId === runId)
    : undefined;

  if (!outcome) {
    if (
      runEntity &&
      runEntity.status !== 'pending' &&
      runEntity.status !== 'running'
    ) {
      outcome = runEntity.status;
    } else {
      outcome = 'stalled';
      const reason = describeStall(world, runId);
      world.pushTrace({ kind: 'note', message: `STALLED: ${reason}` });
      outcomeProblems.push(reason);
    }
  }

  if (expected?.status !== outcome) problems.push(...outcomeProblems);

  const violations = runId
    ? checkInvariants({
        runId,
        events,
        eventsInCommitOrder: world.store.allEventsInCommitOrder(runId),
        runs: world.store.allRuns(),
        steps: world.store.allSteps(runId),
        waits: world.store.allWaits(runId),
      }).concat(replayViolations)
    : [];

  problems.push(...world.watchErrors());

  let output: unknown;
  if (runEntity?.status === 'completed' && runEntity.output !== undefined) {
    output = await hydrateOutput(runEntity.output);
  }

  if (expected?.status && outcome !== expected.status) {
    problems.push(`expected run to end "${expected.status}", got "${outcome}"`);
  }
  if (expected && 'output' in expected) {
    if (!deepEqual(output, expected.output)) {
      problems.push(
        `expected output ${JSON.stringify(expected.output)}, got ${JSON.stringify(output)}`
      );
    }
  }

  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    runId,
    outcome,
    ok: problems.length === 0 && violations.length === 0 && outcome !== 'error',
    problems,
    violations,
    events,
    trace: world.trace,
    run: runEntity,
    output,
    pending: world.simQueue.view(),
    replay,
    deliveries,
    worldCalls: world.callCount(),
    virtualElapsedMs,
    wallMs,
    error: thrown,
  };
}

function describeStall(world: SimWorld, runId: string): string {
  const events = runId ? world.store.allEvents(runId) : [];
  const receivedHookIds = new Set(
    events
      .filter((e) => e.eventType === 'hook_received')
      .map((e) => e.correlationId)
  );
  const openHooks = world.store
    .allHooks(runId)
    .filter((h) => !receivedHookIds.has(h.hookId));
  const openWaits = world.store
    .allWaits(runId)
    .filter((w) => w.status === 'waiting');

  const parts: string[] = [
    'run never reached a terminal state and the world went quiet',
  ];
  if (openHooks.length > 0) {
    parts.push(
      `waiting on ${openHooks.length} hook(s) that were never delivered: ${openHooks
        .map((h) => JSON.stringify(h.token))
        .join(', ')}`
    );
  }
  if (openWaits.length > 0) {
    parts.push(
      `${openWaits.length} wait(s) still open with no continuation queued (this is a runtime bug — a pending wait should always have a queued continuation)`
    );
  }
  if (openHooks.length === 0 && openWaits.length === 0) {
    parts.push(
      'no open hooks or waits — the workflow suspended with nothing to wake it'
    );
  }
  return parts.join('; ');
}

async function hydrateOutput(raw: unknown): Promise<unknown> {
  const { hydrateData, observabilityRevivers } = await import(
    '@workflow/core/serialization-format'
  );
  try {
    return hydrateData(raw, observabilityRevivers);
  } catch {
    return raw;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  return ak.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k]
    )
  );
}

function failedBeforeStart(
  spec: ScenarioSpec,
  problem: string
): ScenarioResult {
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    runId: '',
    outcome: 'error',
    ok: false,
    problems: [problem],
    violations: [],
    events: [],
    trace: [],
    pending: [],
    deliveries: 0,
    worldCalls: 0,
    virtualElapsedMs: 0,
    wallMs: 0,
  };
}
