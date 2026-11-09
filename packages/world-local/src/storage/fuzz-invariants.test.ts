/**
 * Seeded property test: random sequences of World writes (valid, invalid,
 * replayed, conflicting, fenced) never leave the SQLite Local World in a
 * state its event log cannot explain.
 *
 * Each case drives one to three runs (spec 8 and spec 9) through step, hook,
 * wait, attribute and lifecycle writes picked from small id pools, so
 * duplicates, replays, token contention, forced claims, terminal-run writes
 * and stale in-band counts are common. After every write and at the end it
 * checks:
 *
 * - a refused write changes nothing in its run's log or in-band count;
 * - every log is dense (positions 1..seq) and `snapshot.seq` is its length;
 * - `seqInBand` is the run's creation plus every accepted in-band position;
 * - every step's status and attempt are what its own events say;
 * - every listed hook has its `hook_created` and no later `hook_disposed`,
 *   no two hooks hold one token, and a live run's hook resolves by token;
 * - every run's status is what its lifecycle events say, and nothing is
 *   created on it once it has ended.
 *
 * `WORKFLOW_LOCAL_FUZZ_SEEDS` raises the number of cases (default 150).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Event } from '@workflow/world';
import { eventIdToSlot } from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databaseFor } from '../db/index.js';
import { createStorage } from '../storage.js';

const SEEDS = Number(process.env.WORKFLOW_LOCAL_FUZZ_SEEDS ?? 150);
const OPS_PER_CASE = 90;

const ulid = monotonicFactory();

type Op =
  | {
      kind: 'create';
      run: number;
      data: Record<string, unknown>;
      params?: Record<string, unknown>;
      inBand?: { skew: number };
    }
  | { kind: 'getByToken'; token: string };

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(next() * items.length)];
  return { next, pick };
}

const bytes = (n: number) => new Uint8Array([n, 7, 9]);

/** One case: runs, then a sequence of writes biased toward conflicts. */
function generate(seed: number) {
  const { next, pick } = rng(seed);
  const runs = Array.from({ length: 1 + Math.floor(next() * 3) }, () => ({
    runId: `wrun_${ulid()}`,
    spec: next() < 0.5 ? 8 : 9,
  }));
  const tokens = ['tok-1', 'tok-2', 'tok-3'];
  // A hook id keeps one token, as the runtime's do; tokens are shared
  // across runs, so creations contend for them.
  const tokenOf = new Map<string, string>();
  const token = (hookId: string) => {
    if (!tokenOf.has(hookId)) tokenOf.set(hookId, pick(tokens));
    return tokenOf.get(hookId)!;
  };
  const ops: Op[] = [];
  for (let i = 0; i < OPS_PER_CASE; i++) {
    const run = Math.floor(next() * runs.length);
    const specVersion = runs[run].spec;
    const step = pick(['step_a', 'step_b', 'step_c']);
    const hook = `${pick(['hook_a', 'hook_b'])}${run}`;
    const wait = pick(['wait_a', 'wait_b']);
    const x = next();
    let data: Record<string, unknown>;
    let params: Record<string, unknown> | undefined;
    if (x < 0.07) data = { eventType: 'run_started' };
    else if (x < 0.1) {
      const t = pick(['run_completed', 'run_failed', 'run_cancelled']);
      data = {
        eventType: t,
        ...(t === 'run_completed' && { eventData: { output: bytes(2) } }),
        ...(t === 'run_failed' && { eventData: { error: bytes(3) } }),
      };
    } else if (x < 0.2)
      data = {
        eventType: 'step_created',
        correlationId: step,
        eventData: { stepName: 's', input: bytes(4) },
      };
    else if (x < 0.3)
      data = {
        eventType: 'step_started',
        correlationId: step,
        ...(next() < 0.5 && { eventData: { stepName: 's', input: bytes(5) } }),
      };
    else if (x < 0.36)
      data = {
        eventType: 'step_completed',
        correlationId: step,
        eventData: { result: bytes(6) },
      };
    else if (x < 0.4)
      data = {
        eventType: 'step_failed',
        correlationId: step,
        eventData: { error: bytes(7) },
      };
    else if (x < 0.45)
      data = {
        eventType: 'step_retrying',
        correlationId: step,
        eventData: {
          error: bytes(8),
          ...(next() < 0.5 && {
            retryAfter: new Date(
              Date.now() + (next() < 0.5 ? -60_000 : 3_600_000)
            ),
          }),
        },
      };
    else if (x < 0.55)
      data = {
        eventType: 'hook_created',
        correlationId: hook,
        eventData: {
          token: token(hook),
          ...(next() < 0.25 && { force: true }),
        },
      };
    else if (x < 0.63) {
      data = {
        eventType: 'hook_received',
        correlationId: hook,
        eventData: { payload: bytes(9), token: token(hook) },
      };
      if (next() < 0.6) params = { resumeId: `res_${hook}_${pick([1, 2])}` };
    } else if (x < 0.67)
      data = { eventType: 'hook_disposed', correlationId: hook };
    else if (x < 0.73)
      data = {
        eventType: 'wait_created',
        correlationId: wait,
        eventData: { resumeAt: new Date(Date.now() + 60_000) },
      };
    else if (x < 0.77)
      data = { eventType: 'wait_completed', correlationId: wait };
    else if (x < 0.85)
      data = {
        eventType: 'attr_set',
        ...(next() < 0.5 && { correlationId: pick(['attr_1', 'attr_2']) }),
        eventData: {
          changes: [{ key: pick(['a', 'b', 'c']), value: pick(['1', null]) }],
          writer: { type: 'workflow' },
        },
      };
    else {
      ops.push({ kind: 'getByToken', token: pick(tokens) });
      continue;
    }
    const inBand =
      specVersion === 9 && data.eventType !== 'run_cancelled' && next() < 0.35
        ? { skew: next() < 0.1 ? pick([-1, 1]) : 0 }
        : undefined;
    ops.push({
      kind: 'create',
      run,
      data: { specVersion, ...data },
      params,
      inBand,
    });
  }
  return { runs, ops };
}

const STEP_STATUS: Record<string, string> = {
  step_created: 'pending',
  step_started: 'running',
  step_completed: 'completed',
  step_failed: 'failed',
  step_retrying: 'pending',
};
const RUN_STATUS: Record<string, string> = {
  run_created: 'pending',
  run_started: 'running',
  run_completed: 'completed',
  run_failed: 'failed',
  run_cancelled: 'cancelled',
};

let testDir: string;

beforeEach(async () => {
  testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-fuzz-'));
});

afterEach(async () => {
  databaseFor(testDir).close();
  await fs.rm(testDir, { recursive: true, force: true });
});

describe('random write sequences (world-local)', () => {
  it(`keep every run explainable by its own log (${SEEDS} seeded cases)`, async () => {
    let refused = 0;
    let accepted = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = path.join(testDir, String(seed));
      const storage = createStorage(dir);
      const { runs, ops } = generate(seed);
      const inBandAccepted = new Map<string, number>();
      const fail = (message: string) => {
        throw new Error(`seed ${seed}: ${message}`);
      };
      const snapshotOf = async (runId: string) =>
        (await storage.events.list({ runId, pagination: { limit: 1 } }))
          .snapshot!;

      for (const { runId, spec } of runs) {
        await storage.events.create(runId, {
          eventType: 'run_created',
          specVersion: spec,
          eventData: {
            deploymentId: 'dpl',
            workflowName: 'wf',
            input: bytes(1),
          },
        } as never);
        inBandAccepted.set(runId, 0);
      }

      for (const [index, op] of ops.entries()) {
        if (op.kind === 'getByToken') {
          await storage.hooks.getByToken(op.token).then(
            (hook) => {
              if (hook.token !== op.token)
                fail(
                  `op ${index}: token ${op.token} resolved to a hook holding ${hook.token}`
                );
            },
            () => {}
          );
          continue;
        }
        const { runId } = runs[op.run];
        const before = await snapshotOf(runId);
        const params: Record<string, unknown> = { ...op.params };
        if (op.inBand) {
          params.inBand = true;
          params.expectedSeqInBand = before.seqInBand + op.inBand.skew;
        }
        const outcome = await storage.events
          .create(runId, op.data as never, params as never)
          .then(
            (result) => ({ result }),
            (error: unknown) => ({ error })
          );
        const after = await snapshotOf(runId);
        const what = `op ${index} (${String(op.data.eventType)}${op.inBand ? ', in-band' : ''})`;
        if ('error' in outcome) {
          refused++;
          if (after.seq !== before.seq || after.seqInBand !== before.seqInBand)
            fail(
              `${what} was refused but moved its run from ${JSON.stringify(before)} to ${JSON.stringify(after)}`
            );
          continue;
        }
        accepted++;
        if (op.inBand) {
          const allocated = (outcome.result as { allocated?: number })
            .allocated;
          // Independent of what the World reports: a write allocated a
          // position exactly when its run's log grew.
          const grew = after.seq > before.seq ? 1 : 0;
          if (allocated !== grew)
            fail(
              `${what} reported allocated ${allocated}, but the log ${grew ? 'grew' : 'did not grow'}`
            );
          inBandAccepted.set(runId, inBandAccepted.get(runId)! + grew);
        } else if (after.seqInBand !== before.seqInBand) {
          fail(`${what} is out-of-band but moved seqInBand`);
        }
      }

      const liveTokens = new Map<string, string>();
      for (const { runId } of runs) {
        const events: Event[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = await storage.events.list({
            runId,
            pagination: { limit: 50, cursor },
          });
          events.push(...page.data);
          if (!page.hasMore) break;
          cursor = page.cursor ?? undefined;
        }
        const { seq, seqInBand } = await snapshotOf(runId);

        // Dense log, and the counters agree with it.
        events.forEach((event, i) => {
          if (eventIdToSlot(event.eventId) !== i + 1)
            fail(`run ${runId}: event ${i} is at slot ${event.eventId}`);
        });
        expect(seq, `seed ${seed}: seq`).toBe(events.length);
        expect(seqInBand, `seed ${seed}: seqInBand`).toBe(
          1 + inBandAccepted.get(runId)!
        );

        // Nothing is created on a run once it has ended.
        const ended = events.findIndex((e) =>
          ['run_completed', 'run_failed', 'run_cancelled'].includes(e.eventType)
        );
        if (ended >= 0) {
          const late = events
            .slice(ended + 1)
            .find((e) =>
              ['step_created', 'hook_created', 'wait_created'].includes(
                e.eventType
              )
            );
          if (late) fail(`run ${runId}: ${late.eventType} after the run ended`);
        }

        // The run's status is what its lifecycle events say.
        const run = await storage.runs.get(runId);
        const lastLifecycle = events
          .filter((e) => e.eventType in RUN_STATUS)
          .at(-1)!;
        expect(run.status, `seed ${seed}: run status`).toBe(
          RUN_STATUS[lastLifecycle.eventType]
        );

        // Each step is what its own events say.
        const steps = (
          await storage.steps.list({ runId, pagination: { limit: 100 } })
        ).data;
        for (const step of steps) {
          const own = events.filter(
            (e) => e.correlationId === step.stepId && e.eventType in STEP_STATUS
          );
          if (own.length === 0) fail(`step ${step.stepId} has no events`);
          expect(step.status, `seed ${seed}: ${step.stepId} status`).toBe(
            STEP_STATUS[own.at(-1)!.eventType]
          );
          expect(step.attempt, `seed ${seed}: ${step.stepId} attempt`).toBe(
            own.filter((e) => e.eventType === 'step_started').length
          );
        }

        // Each hook was created, not disposed since, and owns its token.
        const hooks = (
          await storage.hooks.list({ runId, pagination: { limit: 100 } })
        ).data;
        for (const hook of hooks) {
          const own = events.filter((e) => e.correlationId === hook.hookId);
          const created = own.findLastIndex(
            (e) => e.eventType === 'hook_created'
          );
          if (created < 0) fail(`hook ${hook.hookId} has no hook_created`);
          if (own.slice(created).some((e) => e.eventType === 'hook_disposed'))
            fail(`hook ${hook.hookId} is listed after its hook_disposed`);
          if (run.status === 'pending' || run.status === 'running') {
            const holder = liveTokens.get(hook.token);
            if (holder && holder !== hook.hookId)
              fail(
                `token ${hook.token} is held by ${holder} and ${hook.hookId}`
              );
            liveTokens.set(hook.token, hook.hookId);
            const byToken = await storage.hooks.getByToken(hook.token);
            expect(byToken.hookId, `seed ${seed}: ${hook.token}`).toBe(
              hook.hookId
            );
          }
        }
      }
      databaseFor(dir).close();
    }
    // The generator must keep exercising both outcomes.
    expect(accepted).toBeGreaterThan(SEEDS * 10);
    expect(refused).toBeGreaterThan(SEEDS * 10);
  }, 120_000);
});
