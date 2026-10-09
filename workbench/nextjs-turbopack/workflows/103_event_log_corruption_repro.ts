import {
  createHook,
  getWorkflowMetadata,
  setAttributes,
  sleep,
} from 'workflow';

/**
 * Workflows purpose-built to reproduce `CORRUPTED_EVENT_LOG`.
 *
 * A corrupted event log needs three things to line up, and these workflows are
 * shaped to supply all three at once rather than leaving any of them to luck:
 *
 * 1. **Concurrent writers on one run.** Every wake source (a raced step
 *    completing, a watchdog timer elapsing, an out-of-band `hook_received`)
 *    delivers its own queue message, so a run with many simultaneous wake
 *    sources is replayed by several invocations at the same time. Each one
 *    loads the event log, replays, and writes.
 * 2. **A write derived from an incomplete log.** With writers overlapping, one
 *    replay's event load can miss an event a sibling has already committed.
 * 3. **Control flow that depends on the missing event, by step *count*.** This
 *    is the amplifier, and it is what the older repro scenarios lacked. Because
 *    correlation IDs are positional ordinals of one seeded sequence, a replay
 *    that emits a different *number* of steps renames every entity after that
 *    point, turning one missing event into an unrecoverable divergence instead
 *    of a benign retry.
 *
 * Both workflows below race a settle path that emits one step against a
 * recovery path that emits two, then fan out a reconcile batch whose width is
 * derived from how many branches took the recovery path. They differ only in
 * what the branch races against the watchdog: an in-run step completion
 * (`stepStormReproWorkflow`) or an out-of-band hook delivery
 * (`hookStormReproWorkflow`, the shape seen corrupting production runs).
 */

interface StormInput {
  token: string;
  rounds?: number;
  width?: number;
  watchdogMs?: number;
  stepDelayMs?: number;
  stepDelayJitterMs?: number;
  jitterBuckets?: number;
  /** `blocked-branch`: per-index spacing of the launch step's duration, so the
   *  branches' launch completions commit one after another and a resume burst
   *  can land between the second-to-last and the last. */
  launchStaggerMs?: number;
  betweenRoundSleepMs?: number;
  reconcileBase?: number;
  attrWrites?: number;
}

type Winner = 'settled' | 'watchdog';

interface BranchRecord {
  round: number;
  index: number;
  winner: Winner;
}

interface RoundRecord {
  round: number;
  branches: BranchRecord[];
  stragglers: number;
  reconciled: number;
}

interface StormResult {
  runId: string;
  rounds: number;
  width: number;
  ledger: RoundRecord[];
}

interface WakePayload {
  round: number;
  index: number;
  sentAt: number;
}

const WATCHDOG = Symbol.for('event-log-corruption-repro:watchdog');

/**
 * The raced step. Its `delayMs` is chosen to land near the watchdog deadline,
 * so which branch wins is decided by real wall-clock timing — the legitimate
 * nondeterminism the event log exists to freeze. A replay that cannot see this
 * step's `step_completed` takes the recovery path instead.
 *
 * `attrWrites` issues `setAttributes` calls from inside the step body. Those
 * are genuinely out-of-band writes (no replay snapshot backs them, so they
 * carry no precondition), which both widens the window in which a concurrent
 * replay's loaded log is incomplete and forces the reader into an extra
 * in-process replay.
 */
async function settleStep(input: {
  delayMs: number;
  runId: string;
  round: number;
  index: number;
  attrWrites: number;
}) {
  'use step';
  // One fixed key, overwritten by every branch of every round, so the run never
  // accumulates attribute keys. The value is never asserted on — the point is
  // the `attr_set` event, not what it says.
  for (let write = 0; write < input.attrWrites; write += 1) {
    await setAttributes({
      settle: `r${input.round}b${input.index}w${write}`,
    });
  }
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return {
    runId: input.runId,
    round: input.round,
    index: input.index,
    settledAt: Date.now(),
  };
}

/**
 * Emitted only on the watchdog path, ahead of `finalizeStep`. The recovery path
 * therefore writes two steps where the settle path writes one, so a replay that
 * disagrees about the winner also disagrees about how many correlation IDs the
 * branch consumes.
 */
async function recoverStep(input: {
  runId: string;
  round: number;
  index: number;
}) {
  'use step';
  return { ...input, recoveredAt: Date.now() };
}

async function finalizeStep(input: {
  runId: string;
  round: number;
  index: number;
  winner: Winner;
}) {
  'use step';
  return { ...input, finalizedAt: Date.now() };
}

/** Runs in the branch's `finally`, so every branch ends on a write. */
async function releaseStep(input: {
  runId: string;
  round: number;
  index: number;
}) {
  'use step';
  return { ...input, releasedAt: Date.now() };
}

/**
 * One member of the round's reconcile batch. The batch's *width* is derived
 * from the round's race outcomes, so this is where a one-event disagreement
 * becomes a shifted correlation-ID sequence for the whole remainder of the run.
 */
async function reconcileStep(input: {
  runId: string;
  round: number;
  index: number;
  stragglers: number;
}) {
  'use step';
  return { ...input, reconciledAt: Date.now() };
}

/**
 * Deterministic per-branch delay spread around the watchdog deadline. It must
 * not use `Math.random()` (the workflow body has to replay identically), but it
 * does need to put different branches on either side of the deadline so the
 * straggler count — and therefore the reconcile width — varies from round to
 * round.
 */
function branchDelayMs(
  round: number,
  index: number,
  base: number,
  jitterMs: number,
  buckets: number
) {
  if (jitterMs <= 0 || buckets <= 1) return base;
  const bucket = (round * 3 + index * 5) % buckets;
  // Centre the spread on `base` so roughly half the branches beat the watchdog.
  return Math.max(0, base + (bucket - Math.floor(buckets / 2)) * jitterMs);
}

function normalize(input: StormInput) {
  return {
    rounds: input.rounds ?? 6,
    width: input.width ?? 8,
    watchdogMs: input.watchdogMs ?? 2500,
    // Slightly under `watchdogMs`: the sleep starts when the branch suspends,
    // while this delay only starts once the step body is dispatched, so the two
    // deadlines land on top of each other and the jitter decides the winner.
    stepDelayMs: input.stepDelayMs ?? 2200,
    stepDelayJitterMs: input.stepDelayJitterMs ?? 250,
    jitterBuckets: input.jitterBuckets ?? 5,
    launchStaggerMs: input.launchStaggerMs ?? 300,
    betweenRoundSleepMs: input.betweenRoundSleepMs ?? 1000,
    reconcileBase: input.reconcileBase ?? 2,
    attrWrites: input.attrWrites ?? 1,
  };
}

export async function stepStormReproWorkflow(
  input: StormInput
): Promise<StormResult> {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const config = normalize(input);
  const ledger: RoundRecord[] = [];

  // A hook the workflow creates but never reads. The driver resumes it on a
  // cadence for the whole run, so every replay is racing a stream of
  // `hook_received` events written with no snapshot behind them — the
  // out-of-band write the guard was built for, and the same shape as a sandbox
  // callback arriving after its watchdog already fired.
  const pokeHook = createHook<WakePayload>({ token: `${input.token}:poke` });

  try {
    for (let round = 0; round < config.rounds; round += 1) {
      // Every branch in the round suspends together, so the round's step creates
      // land in one batch sharing one snapshot, and their completions land within
      // a few milliseconds of each other and of the watchdog wake.
      const branches = await Promise.all(
        Array.from({ length: config.width }, (_, index) =>
          (async (): Promise<BranchRecord> => {
            try {
              const winner = await Promise.race([
                settleStep({
                  attrWrites: config.attrWrites,
                  delayMs: branchDelayMs(
                    round,
                    index,
                    config.stepDelayMs,
                    config.stepDelayJitterMs,
                    config.jitterBuckets
                  ),
                  index,
                  round,
                  runId: metadata.workflowRunId,
                }),
                sleep(config.watchdogMs).then(() => WATCHDOG),
              ]);

              if (winner === WATCHDOG) {
                await recoverStep({
                  index,
                  round,
                  runId: metadata.workflowRunId,
                });
                await finalizeStep({
                  index,
                  round,
                  runId: metadata.workflowRunId,
                  winner: 'watchdog',
                });
                return { index, round, winner: 'watchdog' };
              }

              await finalizeStep({
                index,
                round,
                runId: metadata.workflowRunId,
                winner: 'settled',
              });
              return { index, round, winner: 'settled' };
            } finally {
              await releaseStep({
                index,
                round,
                runId: metadata.workflowRunId,
              });
            }
          })()
        )
      );

      const stragglers = branches.filter(
        (branch) => branch.winner === 'watchdog'
      ).length;
      const reconciled = await Promise.all(
        Array.from({ length: config.reconcileBase + stragglers }, (_, index) =>
          reconcileStep({
            index,
            round,
            runId: metadata.workflowRunId,
            stragglers,
          })
        )
      );

      ledger.push({
        branches,
        reconciled: reconciled.length,
        round,
        stragglers,
      });

      if (config.betweenRoundSleepMs > 0) {
        await sleep(config.betweenRoundSleepMs);
      }
    }
  } finally {
    pokeHook.dispose();
  }

  return {
    ledger,
    rounds: config.rounds,
    runId: metadata.workflowRunId,
    width: config.width,
  };
}

/**
 * The production shape: each branch races an out-of-band hook delivery against
 * a watchdog timer, exactly like a task waiting for a sandbox callback with a
 * timeout. Hook tokens are derived from `(round, index)` so the driver can
 * resume all of a round's hooks in one burst without discovering them
 * individually — every hook in a round is created by the same suspension, so
 * the first one existing implies the rest do.
 *
 * Compared with `stepStormReproWorkflow`, the writes racing the replay are
 * `hook_received` events written by the backend rather than step completions
 * written by a sibling invocation, and each delivery wakes its own invocation.
 */
export async function hookStormReproWorkflow(
  input: StormInput
): Promise<StormResult> {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const config = normalize(input);
  const ledger: RoundRecord[] = [];

  for (let round = 0; round < config.rounds; round += 1) {
    const hooks = Array.from({ length: config.width }, (_, index) =>
      createHook<WakePayload>({
        token: `${input.token}:${round}:${index}`,
      })
    );

    try {
      const branches = await Promise.all(
        hooks.map((hook, index) =>
          (async (): Promise<BranchRecord> => {
            const iterator = hook[Symbol.asyncIterator]();
            try {
              const winner = await Promise.race([
                iterator.next().then(() => 'settled' as const),
                sleep(config.watchdogMs).then(() => WATCHDOG),
              ]);

              if (winner === WATCHDOG) {
                await recoverStep({
                  index,
                  round,
                  runId: metadata.workflowRunId,
                });
                await finalizeStep({
                  index,
                  round,
                  runId: metadata.workflowRunId,
                  winner: 'watchdog',
                });
                return { index, round, winner: 'watchdog' };
              }

              await finalizeStep({
                index,
                round,
                runId: metadata.workflowRunId,
                winner: 'settled',
              });
              return { index, round, winner: 'settled' };
            } finally {
              await releaseStep({
                index,
                round,
                runId: metadata.workflowRunId,
              });
            }
          })()
        )
      );

      const stragglers = branches.filter(
        (branch) => branch.winner === 'watchdog'
      ).length;
      const reconciled = await Promise.all(
        Array.from({ length: config.reconcileBase + stragglers }, (_, index) =>
          reconcileStep({
            index,
            round,
            runId: metadata.workflowRunId,
            stragglers,
          })
        )
      );

      ledger.push({
        branches,
        reconciled: reconciled.length,
        round,
        stragglers,
      });
    } finally {
      for (const hook of hooks) {
        hook.dispose();
      }
    }

    if (config.betweenRoundSleepMs > 0) {
      await sleep(config.betweenRoundSleepMs);
    }
  }

  return {
    ledger,
    rounds: config.rounds,
    runId: metadata.workflowRunId,
    width: config.width,
  };
}

/**
 * The blocked-branch shape: like `hookStormReproWorkflow`, each branch races an
 * out-of-band hook delivery against a watchdog — but only after first parking
 * on a launch step, the way a task launches work and then waits for its
 * completion callback. That pre-race step is the ingredient the other storms
 * lack, and it changes what a concurrent replay can be missing.
 *
 * A replay woken by one branch's `hook_received` can load a log that ends just
 * before a sibling's launch `step_completed`. That sibling is then still parked
 * at its `await` and creates *nothing* — not even the watchdog wait it would
 * enter the race with — so every correlation ID the woken branch mints after
 * that point sits one position earlier in the run's ID sequence than in a
 * replay that saw the completion. The woken branch's `finalizeStep` takes the
 * exact ordinal a fresher writer hands the blocked sibling's wait: one ID, two
 * entity kinds, and the run dies `CORRUPTED_EVENT_LOG` on an unconsumable
 * `step_created`. Unlike the wake-ORDER races the other storms aim at, no
 * delivery-ordering discipline covers this — the missing branch's IDs are
 * absent from the shorter replay, not misordered.
 *
 * The launch durations are staggered per index so the completions commit
 * spread out, and the driver aims its resume burst at the tail of that spread.
 * The watchdog is sized to normally lose to the resumes: its job here is to
 * put a wait entity into the race, not to fire.
 */
export async function blockedBranchReproWorkflow(
  input: StormInput
): Promise<StormResult> {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const config = normalize(input);
  const ledger: RoundRecord[] = [];

  for (let round = 0; round < config.rounds; round += 1) {
    const hooks = Array.from({ length: config.width }, (_, index) =>
      createHook<WakePayload>({
        token: `${input.token}:${round}:${index}`,
      })
    );

    try {
      const branches = await Promise.all(
        hooks.map((hook, index) =>
          (async (): Promise<BranchRecord> => {
            const iterator = hook[Symbol.asyncIterator]();
            try {
              // The launch: the branch is parked here until its own
              // `step_completed` arrives, minting nothing in the meantime.
              // Staggered per index so the round's completions land one by
              // one instead of in a single batch.
              await settleStep({
                attrWrites: config.attrWrites,
                delayMs: config.stepDelayMs + index * config.launchStaggerMs,
                index,
                round,
                runId: metadata.workflowRunId,
              });

              const winner = await Promise.race([
                iterator.next().then(() => 'settled' as const),
                sleep(config.watchdogMs).then(() => WATCHDOG),
              ]);

              if (winner === WATCHDOG) {
                await recoverStep({
                  index,
                  round,
                  runId: metadata.workflowRunId,
                });
                await finalizeStep({
                  index,
                  round,
                  runId: metadata.workflowRunId,
                  winner: 'watchdog',
                });
                return { index, round, winner: 'watchdog' };
              }

              await finalizeStep({
                index,
                round,
                runId: metadata.workflowRunId,
                winner: 'settled',
              });
              return { index, round, winner: 'settled' };
            } finally {
              await releaseStep({
                index,
                round,
                runId: metadata.workflowRunId,
              });
            }
          })()
        )
      );

      const stragglers = branches.filter(
        (branch) => branch.winner === 'watchdog'
      ).length;
      const reconciled = await Promise.all(
        Array.from({ length: config.reconcileBase + stragglers }, (_, index) =>
          reconcileStep({
            index,
            round,
            runId: metadata.workflowRunId,
            stragglers,
          })
        )
      );

      ledger.push({
        branches,
        reconciled: reconciled.length,
        round,
        stragglers,
      });
    } finally {
      for (const hook of hooks) {
        hook.dispose();
      }
    }

    if (config.betweenRoundSleepMs > 0) {
      await sleep(config.betweenRoundSleepMs);
    }
  }

  return {
    ledger,
    rounds: config.rounds,
    runId: metadata.workflowRunId,
    width: config.width,
  };
}

// ---------------------------------------------------------------------------
// wake-loop
// ---------------------------------------------------------------------------

interface WakeLoopInput {
  token: string;
  /** Wakes carrying `fresh: true` to process before returning. */
  wakes?: number;
  /** The heartbeat sleep raced against the hook read. */
  heartbeatMs?: number;
  /** Base duration of the drain step, the long step of each cycle. */
  stepDelayMs?: number;
  /** Deterministic per-cycle spread added to `stepDelayMs`. */
  stepDelayJitterMs?: number;
  /** Bytes every step returns, so each replay pays real hydration per event. */
  stepPayloadBytes?: number;
  /** Every Nth cycle's drain reports more work, so the loop runs another cycle
   *  without racing. 0 disables. */
  continueEvery?: number;
  /** Hard cap on cycles, so a driver that never sends enough fresh wakes still
   *  ends the run. */
  maxCycles?: number;
}

interface WakeLoopPayload {
  seq: number;
  /** Whether this wake has work behind it. A stale wake is consumed without
   *  emitting a single step, which is the step-count amplifier of this shape. */
  fresh: boolean;
  sentAt: number;
}

type WakeLoopCause = 'start' | 'wake' | 'heartbeat' | 'continue';

interface WakeLoopCycle {
  cycle: number;
  cause: WakeLoopCause;
}

interface WakeLoopResult {
  runId: string;
  cycles: number;
  freshWakes: number;
  staleWakes: number;
  heartbeats: number;
  ledger: WakeLoopCycle[];
}

const HEARTBEAT = Symbol.for('event-log-corruption-repro:heartbeat');

function payloadOf(bytes: number, tag: string) {
  return bytes > 0 ? tag.padEnd(bytes, 'x') : tag;
}

/** The short bookkeeping steps of a cycle (two per cycle, plus one before every
 *  heartbeat is armed). */
async function verifyStep(input: {
  runId: string;
  cycle: number;
  phase: string;
  payloadBytes: number;
}) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    runId: input.runId,
    cycle: input.cycle,
    phase: input.phase,
    verifiedAt: Date.now(),
    payload: payloadOf(
      input.payloadBytes,
      `verify:${input.cycle}:${input.phase}`
    ),
  };
}

/**
 * The long step of a cycle. Its duration is what lets a heartbeat completion
 * and a burst of wakes commit while a replay is parked on it, so the events the
 * next replay has to order against each other sit inside one step's span.
 * Whether the loop runs another cycle right away is decided here, from inputs
 * only, so it replays identically.
 */
async function drainStep(input: {
  runId: string;
  cycle: number;
  delayMs: number;
  continueEvery: number;
  payloadBytes: number;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return {
    runId: input.runId,
    cycle: input.cycle,
    more:
      input.continueEvery > 0 &&
      input.cycle % input.continueEvery === input.continueEvery - 1,
    drainedAt: Date.now(),
    payload: payloadOf(input.payloadBytes, `drain:${input.cycle}`),
  };
}

async function syncStep(input: {
  runId: string;
  cycle: number;
  payloadBytes: number;
}) {
  'use step';
  await new Promise((resolve) => setTimeout(resolve, 50));
  return {
    runId: input.runId,
    cycle: input.cycle,
    syncedAt: Date.now(),
    payload: payloadOf(input.payloadBytes, `sync:${input.cycle}`),
  };
}

function normalizeWakeLoop(input: WakeLoopInput) {
  return {
    wakes: input.wakes ?? 12,
    heartbeatMs: input.heartbeatMs ?? 4000,
    stepDelayMs: input.stepDelayMs ?? 600,
    stepDelayJitterMs: input.stepDelayJitterMs ?? 500,
    stepPayloadBytes: input.stepPayloadBytes ?? 8192,
    continueEvery: input.continueEvery ?? 5,
    maxCycles: input.maxCycles ?? 80,
  };
}

/**
 * The wake-loop shape: ONE sequential loop that races a reusable hook read
 * against a heartbeat sleep, the pattern of a long-lived agent loop that is
 * woken by external events and heartbeats in between. It is the shape of a
 * production run that died `CORRUPTED_EVENT_LOG` on an unconsumable
 * `wait_created` after replays of the same immutable prefix diverged
 * non-deterministically: one replay in several observed a hook payload ahead of
 * an earlier heartbeat completion, ran a wake cycle where the committed log
 * recorded a heartbeat, and drew the heartbeat's ordinal for a step.
 *
 * Nothing here fans out. The concurrency comes from outside: every wake the
 * driver sends is its own invocation replaying the run, and the driver sends
 * them in bursts and right around the heartbeat deadline, the two moments the
 * production log showed a `hook_received` landing next to a `wait_completed`.
 *
 * Three properties make an ordering slip fatal rather than benign:
 *  - the hook read is carried across heartbeat wins (a pending `next()` is
 *    never dropped), so whichever of hook and heartbeat the replay sees first
 *    decides the branch;
 *  - a stale wake emits zero steps and a fresh one emits four, so the branch
 *    decision changes the step count;
 *  - the heartbeat is only re-armed (behind a `verify` step) after a heartbeat
 *    win, so a wake mistaken for a heartbeat, or the reverse, moves a
 *    `wait_created` in the correlation-id sequence.
 */
export async function wakeLoopReproWorkflow(
  input: WakeLoopInput
): Promise<WakeLoopResult> {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const config = normalizeWakeLoop(input);
  const runId = metadata.workflowRunId;
  const ledger: WakeLoopCycle[] = [];
  let cycles = 0;
  let freshWakes = 0;
  let staleWakes = 0;
  let heartbeats = 0;

  // A second hook the workflow never reads, as the production run had: it
  // keeps a live consumer with no waiter in the replay.
  const abortHook = createHook<unknown>({ token: `${input.token}:abort` });
  const wake = createHook<WakeLoopPayload>({ token: input.token });
  const iterator = wake[Symbol.asyncIterator]();

  const cycle = async (cause: WakeLoopCause): Promise<boolean> => {
    const index = cycles;
    cycles += 1;
    ledger.push({ cycle: index, cause });
    const payloadBytes = config.stepPayloadBytes;
    await verifyStep({ runId, cycle: index, phase: 'before', payloadBytes });
    const drained = await drainStep({
      runId,
      cycle: index,
      // Deterministic spread: the drain has to be long enough for heartbeat
      // completions and wake bursts to land inside it, and vary so they land
      // at different offsets across cycles.
      delayMs:
        config.stepDelayMs +
        Math.floor(((index * 7) % 10) * (config.stepDelayJitterMs / 10)),
      continueEvery: config.continueEvery,
      payloadBytes,
    });
    await verifyStep({ runId, cycle: index, phase: 'after', payloadBytes });
    await syncStep({ runId, cycle: index, payloadBytes });
    return drained.more;
  };

  try {
    let pendingRead = iterator.next();
    let heartbeat: Promise<typeof HEARTBEAT> | null = null;
    let more = await cycle('start');

    while (freshWakes < config.wakes && cycles < config.maxCycles) {
      while (more && cycles < config.maxCycles) {
        more = await cycle('continue');
      }
      if (cycles >= config.maxCycles) break;

      if (!heartbeat) {
        await verifyStep({
          runId,
          cycle: cycles,
          phase: 'heartbeat',
          payloadBytes: config.stepPayloadBytes,
        });
        heartbeat = sleep(config.heartbeatMs).then(() => HEARTBEAT);
      }

      const winner = await Promise.race([
        pendingRead.then((result) => ({ payload: result.value })),
        heartbeat,
      ]);

      if (winner === HEARTBEAT) {
        heartbeat = null;
        heartbeats += 1;
        more = await cycle('heartbeat');
        continue;
      }

      // The read is consumed only when it wins; a heartbeat win above carries
      // the same pending read into the next race.
      pendingRead = iterator.next();
      const payload = (winner as { payload: WakeLoopPayload | undefined })
        .payload;
      if (payload?.fresh) {
        freshWakes += 1;
        more = await cycle('wake');
      } else {
        staleWakes += 1;
        more = false;
      }
    }
  } finally {
    wake.dispose();
    abortHook.dispose();
  }

  return { runId, cycles, freshWakes, staleWakes, heartbeats, ledger };
}

// ---------------------------------------------------------------------------
// dag-runner
// ---------------------------------------------------------------------------

interface DagRunnerInput {
  token: string;
  /** Nodes in the DAG. Every node runs the same four-step chain. */
  nodes?: number;
  /** Ready-set width: how many nodes are in flight at once. Above the inline
   *  step limit (3), so part of every wave is dispatched to the queue while
   *  the rest runs inline in the orchestrator invocation. */
  width?: number;
  /** Base duration of the node's evaluate step, the long step of the chain. */
  evaluateMs?: number;
  /** Deterministic per-node spread added to `evaluateMs`, so sibling
   *  completions land a few milliseconds to a few seconds apart. */
  evaluateJitterMs?: number;
  /** Duration of the three short bookkeeping steps. */
  shortStepMs?: number;
  /** Every Nth node is a worker node: after its evaluate it binds a hook,
   *  awaits `hook.getConflict()`, enqueues the worker and waits for the
   *  worker's callback (raced against a watchdog). 0 disables. */
  workerEvery?: number;
  /** Worker nodes: how long to wait for the callback before giving up. */
  workerWatchdogMs?: number;
  /** Sequential steps before the DAG, each followed by a bound hook, the way
   *  a runner registers itself before it starts scheduling. */
  preludeBinds?: number;
}

interface DagNodeRecord {
  node: number;
  worker: boolean;
  callback: 'received' | 'watchdog' | 'none';
  order: number;
}

interface DagRunnerResult {
  runId: string;
  nodes: number;
  width: number;
  ledger: DagNodeRecord[];
  bindsConfirmed: number;
}

interface WorkerCallbackPayload {
  node: number;
  sentAt: number;
}

const DAG_WATCHDOG = Symbol.for('event-log-corruption-repro:dag-watchdog');

async function claimNodeStep(input: {
  runId: string;
  node: number;
  delayMs: number;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { runId: input.runId, node: input.node, claimedAt: Date.now() };
}

async function evaluateNodeStep(input: {
  runId: string;
  node: number;
  delayMs: number;
  worker: boolean;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return {
    runId: input.runId,
    node: input.node,
    needsWorker: input.worker,
    evaluatedAt: Date.now(),
  };
}

async function enqueueWorkerStep(input: {
  runId: string;
  node: number;
  delayMs: number;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { runId: input.runId, node: input.node, enqueuedAt: Date.now() };
}

async function finishNodeStep(input: {
  runId: string;
  node: number;
  delayMs: number;
  callback: DagNodeRecord['callback'];
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { runId: input.runId, node: input.node, finishedAt: Date.now() };
}

async function transitionNodeStep(input: {
  runId: string;
  node: number;
  delayMs: number;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { runId: input.runId, node: input.node, transitionedAt: Date.now() };
}

async function preludeStep(input: {
  runId: string;
  index: number;
  delayMs: number;
}) {
  'use step';
  if (input.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, input.delayMs));
  }
  return { runId: input.runId, index: input.index, at: Date.now() };
}

function normalizeDagRunner(input: DagRunnerInput) {
  return {
    nodes: input.nodes ?? 12,
    // Clamped: a width of 0 would leave the scheduler racing an empty set,
    // which never settles, and the run would sit until the harness gave up.
    width: Math.max(1, input.width ?? 5),
    evaluateMs: input.evaluateMs ?? 1500,
    evaluateJitterMs: input.evaluateJitterMs ?? 2500,
    shortStepMs: input.shortStepMs ?? 150,
    workerEvery: input.workerEvery ?? 3,
    workerWatchdogMs: input.workerWatchdogMs ?? 6000,
    preludeBinds: input.preludeBinds ?? 2,
  };
}

/**
 * The DAG-runner shape: a ready-set scheduler keeps `width` nodes in flight
 * and refills a slot as soon as any in-flight node settles (`Promise.race`),
 * every node running the same `claim -> evaluate -> finish -> transition`
 * chain of short steps around one long one. Taken from a production runner
 * that corrupted 90% of its runs on the day it shipped, with no concurrent
 * writer involved: one orchestrator invocation wrote the whole log, and then
 * fresh replays of that log diverged four times in six seconds.
 *
 * Three things distinguish it from the storms above:
 *
 *  - **Nothing outside the run races it.** Sibling steps complete a few
 *    milliseconds apart because they are siblings, not because a driver aims
 *    them; the concurrency is the scheduler's own.
 *  - **The width exceeds the inline step limit**, so every wave is a mix of
 *    steps run inline by the orchestrator (whose completions it observes on
 *    its own next replay pass) and steps dispatched to the queue (whose
 *    completions wake fresh invocations).
 *  - **Worker nodes bind a hook mid-fan-out** and await `hook.getConflict()`
 *    before enqueueing the worker and waiting for its callback. A
 *    `getConflict()` awaiter changes how the runtime handles the suspension
 *    it lands in: nothing in that batch runs inline, every sibling step is
 *    dispatched, and the run is handed back through the queue to resume over
 *    the committed `hook_created`. That is the suspension the production run
 *    died on.
 *
 * The prelude reproduces the runner's registration: sequential steps each
 * followed by a bound hook, so the run crosses several such boundaries
 * before the DAG starts.
 */
export async function dagRunnerReproWorkflow(
  input: DagRunnerInput
): Promise<DagRunnerResult> {
  'use workflow';

  const metadata = getWorkflowMetadata();
  const config = normalizeDagRunner(input);
  const runId = metadata.workflowRunId;
  const ledger: DagNodeRecord[] = [];
  const hooks: { dispose(): void }[] = [];
  let bindsConfirmed = 0;
  let order = 0;

  const bind = async (name: string) => {
    const hook = createHook<WorkerCallbackPayload>({
      token: `${input.token}:${name}`,
    });
    hooks.push(hook);
    const conflict = await hook.getConflict();
    if (conflict === null) bindsConfirmed += 1;
    // Wrapped: a hook is a thenable, and returning it bare from an async
    // function would make the caller's `await` read its first payload.
    return { hook };
  };

  // Deterministic spread of the long step, so sibling completions land at
  // different offsets: some milliseconds apart, some seconds.
  const evaluateDelay = (node: number) =>
    config.evaluateMs +
    Math.floor(((node * 7) % 10) * (config.evaluateJitterMs / 10));

  const runNode = async (node: number): Promise<DagNodeRecord> => {
    // Which nodes are workers. The harness's driver applies the same
    // predicate to know which hooks to answer, and its ledger validator
    // derives the expected bind count from it (`workerNodes` and
    // `validateDagRunnerReturn` in event-log-race-repro.test.ts); change all
    // three together.
    const worker =
      config.workerEvery > 0 &&
      node % config.workerEvery === config.workerEvery - 1;
    await claimNodeStep({ runId, node, delayMs: config.shortStepMs });
    const evaluated = await evaluateNodeStep({
      runId,
      node,
      delayMs: evaluateDelay(node),
      worker,
    });
    let callback: DagNodeRecord['callback'] = 'none';
    if (evaluated.needsWorker) {
      // The bind: a hook whose registration the node waits on before it
      // enqueues the worker, while its siblings keep launching steps.
      const { hook } = await bind(`node:${node}`);
      await enqueueWorkerStep({ runId, node, delayMs: config.shortStepMs });
      const iterator = hook[Symbol.asyncIterator]();
      const winner = await Promise.race([
        iterator.next().then(() => 'received' as const),
        sleep(config.workerWatchdogMs).then(() => DAG_WATCHDOG),
      ]);
      callback = winner === DAG_WATCHDOG ? 'watchdog' : 'received';
    }
    await finishNodeStep({
      runId,
      node,
      delayMs: config.shortStepMs,
      callback,
    });
    await transitionNodeStep({ runId, node, delayMs: config.shortStepMs });
    order += 1;
    return { node, worker, callback, order };
  };

  try {
    for (let index = 0; index < config.preludeBinds; index += 1) {
      await preludeStep({ runId, index, delayMs: config.shortStepMs });
      await bind(`prelude:${index}`);
    }

    // Ready-set scheduler: keep `width` nodes in flight, refill on any
    // settlement. `Promise.race` over the in-flight set is what makes the
    // scheduler's next launch depend on which sibling settled first. Each
    // node records itself as it settles; the race is only the wake signal,
    // since two nodes settling in one turn both leave the set but only one
    // of them is the race's value.
    const inFlight = new Map<number, Promise<void>>();
    let next = 0;
    while (next < config.nodes || inFlight.size > 0) {
      while (next < config.nodes && inFlight.size < config.width) {
        const node = next;
        next += 1;
        inFlight.set(
          node,
          runNode(node).then((record) => {
            inFlight.delete(node);
            ledger.push(record);
          })
        );
      }
      await Promise.race(inFlight.values());
    }
  } finally {
    for (const hook of hooks) hook.dispose();
  }

  return {
    runId,
    nodes: config.nodes,
    width: config.width,
    ledger,
    bindsConfirmed,
  };
}
