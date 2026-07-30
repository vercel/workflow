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
