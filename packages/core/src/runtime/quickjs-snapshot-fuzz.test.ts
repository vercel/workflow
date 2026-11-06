/**
 * Differential fuzz of VM snapshot/restore against a live VM and a full
 * replay. One random schedule of parallel, sequential and raced steps is
 * driven three ways:
 *
 * - live: one VM fed each burst of events as it lands;
 * - snapshot: the same, but at random points the VM is snapshotted,
 *   dropped, and restored from a random saved snapshot (sometimes an older
 *   one), fed from a lagging position that re-feeds consumed events, with
 *   the burst split across the restore;
 * - full replay: one fresh VM given the final log.
 *
 * All three must agree on every step's correlation id and input, and on the
 * result. The schedule is drawn only from the step ids the VM produces, so
 * any divergence in id generation changes the schedule and fails the test.
 *
 * Knobs: `FUZZ_TRIALS` (seeds), `FUZZ_STEPS` (loop iterations per
 * workflow). The nightly QuickJS snapshot fuzz workflow runs it with larger
 * values. `FUZZ_MUTATE=rng` (off-by-one `rngDraws`) or `FUZZ_MUTATE=ulid`
 * (dropped `lastUlid`) corrupt the restore state to confirm the test fails.
 */
import type { Event, SnapshotMetadata } from '@workflow/world';
import seedrandom from 'seedrandom';
import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import {
  type QuickJSRuntimeResult,
  startQuickJSWorkflow,
} from './quickjs-runtime.js';

const run = {
  runId: 'wrun_01JXT21Q00AAAAAAAAAAAAAAAA',
  deploymentId: 'dpl_test',
  workflowName: 'w',
  input: undefined,
  status: 'running' as const,
  output: undefined,
  error: undefined,
  completedAt: undefined,
  startedAt: new Date('2025-01-01T00:00:00Z'),
  createdAt: new Date('2025-01-01T00:00:00Z'),
  updatedAt: new Date('2025-01-01T00:00:00Z'),
  specVersion: 2,
};
const TRIALS = Number(process.env.FUZZ_TRIALS ?? 20);
const STEPS = Number(process.env.FUZZ_STEPS ?? 30);
const MUTATE = process.env.FUZZ_MUTATE;

const workflowCode = `
  var s = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step//test//s");
  async function workflow() {
    var acc = [];
    for (var i = 0; i < ${STEPS}; i++) {
      if (i % 5 === 0) {
        var xs = await Promise.all([s(i, 0), s(i, 1), s(i, 2)]);
        acc.push(xs.join('+'));
      } else if (i % 7 === 0) {
        var w = await Promise.race([s(i, 'a'), s(i, 'b')]);
        acc.push('race:' + w);
      } else {
        acc.push(await s(i, Math.random()));
      }
    }
    return { acc: acc, t: Date.now(), r: Math.random() };
  }
  workflow.workflowId = "workflow//test//workflow";
  globalThis.__private_workflows.set("workflow//test//workflow", workflow);
`;
const options = {
  workflowCode,
  workflowId: 'workflow//test//workflow',
  workflowRun: run,
};
const hex = (u?: Uint8Array) => (u ? Buffer.from(u).toString('hex') : '');

interface PendingStepOp {
  type: string;
  correlationId: string;
  input?: Uint8Array;
}
interface SavedSnapshot {
  data: Uint8Array;
  metadata: SnapshotMetadata;
  /** How much of the log the snapshotted VM had consumed. */
  frontier: number;
}

const at = (seconds: number) => new Date(Date.UTC(2025, 0, 1, 0, 0, seconds));

function stepOps(result: QuickJSRuntimeResult): PendingStepOp[] {
  return (result.suspended?.pendingOperations ?? []).filter(
    (op) => op.type === 'step'
  ) as PendingStepOp[];
}

async function drive(seed: string, mode: 'live' | 'snapshot') {
  // Schedule decisions: identical across modes as long as the ids agree.
  const schedule = seedrandom(seed);
  // Snapshot-driver-only decisions.
  const chaos = seedrandom(`${seed}:chaos`);
  const log: Event[] = [
    {
      eventId: 'e_rc',
      runId: run.runId,
      eventType: 'run_created',
      eventData: { input: serialize([]) },
      createdAt: at(0),
    } as unknown as Event,
  ];
  const trace: string[] = [];
  const created = new Set<string>();
  const completed = new Set<string>();
  const snapshots: SavedSnapshot[] = [];
  let seconds = 1;
  let restores = 0;
  let session = await startQuickJSWorkflow({ ...options, events: [...log] });
  let frontier = log.length;
  let result = session.result;

  for (let round = 0; round < 10_000 && result.suspended; round++) {
    for (const op of stepOps(result)) {
      if (!created.has(op.correlationId)) {
        trace.push(`${op.correlationId}|${hex(op.input)}`);
      }
    }
    // Complete a random-size burst of the pending steps, in random order.
    const pending = stepOps(result).filter(
      (op) => !completed.has(op.correlationId)
    );
    if (pending.length === 0) {
      throw new Error('stuck: suspended with nothing to complete');
    }
    const burst = 1 + Math.floor(schedule() * pending.length);
    const order = pending
      .slice()
      .sort(() => schedule() - 0.5)
      .slice(0, burst);
    for (const op of pending) {
      if (created.has(op.correlationId)) continue;
      created.add(op.correlationId);
      log.push({
        eventId: `c_${op.correlationId}`,
        runId: run.runId,
        eventType: 'step_created',
        correlationId: op.correlationId,
        eventData: { stepName: 'step//test//s' },
        createdAt: at(seconds++),
      } as unknown as Event);
    }
    for (const op of order) {
      completed.add(op.correlationId);
      log.push({
        eventId: `d_${op.correlationId}`,
        runId: run.runId,
        eventType: 'step_completed',
        correlationId: op.correlationId,
        eventData: { result: `R(${op.correlationId.slice(-4)})` },
        createdAt: at(seconds++),
      } as unknown as Event);
    }

    if (mode === 'snapshot' && chaos() < 0.5) {
      // Snapshot the live VM at its current frontier, drop it, and restore
      // from a random saved snapshot (possibly older), fed from a lagging
      // position that re-feeds consumed events.
      const captured = session.snapshot();
      snapshots.push({
        data: captured.data,
        frontier,
        metadata: {
          eventsCursor: 'x',
          createdAt: new Date(),
          rngDraws: captured.rngDraws + (MUTATE === 'rng' ? 1 : 0),
          lastUlid: MUTATE === 'ulid' ? undefined : captured.lastUlid,
          serdeRootPtr: captured.serdeRootPtr,
          clockMs: captured.clockMs,
          engineVersion: captured.engineVersion,
        },
      });
      session.dispose();
      const pick = snapshots[Math.floor(chaos() * snapshots.length)];
      const lag = Math.floor(chaos() * 6);
      const delta = log.slice(Math.max(1, pick.frontier - lag));
      // Split the burst: restore with part of the delta, continue with the
      // rest.
      const cut = Math.floor(chaos() * (delta.length + 1));
      session = await startQuickJSWorkflow({
        ...options,
        events: delta.slice(0, cut),
        existingSnapshot: { data: pick.data, metadata: pick.metadata },
      });
      restores++;
      result = session.result;
      if (result.suspended && cut < delta.length) {
        result = await session.continueWithEvents(delta.slice(cut));
      }
    } else {
      result = await session.continueWithEvents(log.slice(frontier));
    }
    frontier = log.length;
  }
  if (!result.completed) {
    throw new Error(`did not complete: ${Object.keys(result).join(',')}`);
  }
  const out = deserialize(result.completed.result);
  session.dispose();
  return { out, trace, log, restores };
}

describe('snapshot differential fuzz', () => {
  it(
    `${TRIALS} seeds x ${STEPS} steps: snapshot driver == live driver == full replay`,
    async () => {
      let totalRestores = 0;
      for (let i = 0; i < TRIALS; i++) {
        const seed = `seed-${i}`;
        const live = await drive(seed, 'live');
        const snapshot = await drive(seed, 'snapshot');
        totalRestores += snapshot.restores;
        expect(snapshot.trace, seed).toEqual(live.trace);
        expect(snapshot.out, seed).toEqual(live.out);
        // Oracle: one fresh full replay of the final log.
        const full = await startQuickJSWorkflow({
          ...options,
          events: snapshot.log,
        });
        try {
          expect(full.result.completed, seed).toBeDefined();
          expect(
            deserialize(full.result.completed?.result as Uint8Array),
            seed
          ).toEqual(snapshot.out);
        } finally {
          full.dispose();
        }
      }
      // The schedule must actually exercise restores.
      expect(totalRestores).toBeGreaterThan(TRIALS);
    },
    Math.max(600_000, TRIALS * STEPS * 1000)
  );
});
