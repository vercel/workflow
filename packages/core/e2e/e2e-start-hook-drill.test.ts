import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  HookConflictError,
  HookReservedError,
  ThrottleError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import type { World } from '@workflow/world';
import { decode } from '@workflow/world-vercel/run-id';
import { decodeTime } from 'ulid';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import type { Run } from '../src/runtime';
import {
  getRun,
  getWorld,
  start as rawStart,
  resumeHook,
} from '../src/runtime';
import {
  getWorkflowMetadata,
  isLocalDeployment,
  setupRunTracking,
  setupWorld,
  trackRun,
} from './utils';

/**
 * start({ hook }) chaos drill. Opt-in (`WORKFLOW_E2E_START_HOOK_DRILL=1`),
 * never part of the default e2e.
 *
 * Runs real start Hook traffic against a workflow-server deployment whose
 * start Hook faults are on (workflow-server `lib/chaos/start-hook-faults.ts`):
 * a fault applies only to tokens that name it (`chaos-drill-<fault>-…`, or
 * `chaos-drill-mix-…` for every rate fault), decided per candidate runId.
 * Starts are mostly cross region (`sfo1`/`fra1` against the iad1 hooks home),
 * so the split admission path runs.
 *
 * For every token it checks, from event logs and run listings:
 * - exactly one run exists, and every caller resolved to it;
 * - no refused candidate has a run, events, or a side effect;
 * - the owner's log has one `run_created` and replays to completion.
 *
 * It ends with a per-fault report (candidates, predicted injections, tokens
 * recovered or not) on stdout and in `e2e-start-hook-drill-report.json`. The
 * server logs each injection as `[chaos] start hook fault`, the source of
 * truth for injected counts.
 *
 * Requires the multi-region nextjs-turbopack workbench (iad1 + sfo1 + fra1).
 */

const DRILL = process.env.WORKFLOW_E2E_START_HOOK_DRILL === '1';
/**
 * `dry`: no chaos tokens, only a few plain cross-region keyed starts (claim,
 * refusal, adoption, close), to check a deployment before a full drill.
 */
const DRY = process.env.WORKFLOW_E2E_START_HOOK_DRILL === 'dry';
const deploymentUrl = process.env.DEPLOYMENT_URL ?? '';

/** Mirrors the drill preview's `CHAOS_START_HOOK_FAULTS`. */
const RATES = {
  'throttle-admission': 0.5,
  'delay-direct': 0.5,
  'die-after-home': 0.5,
  'lose-response': 0.3,
  orphan: 1,
  redeliver: 1,
} as const;
type Fault = keyof typeof RATES;
type FaultClass = Fault | 'mix';
const MIX_FAULTS: Fault[] = [
  'throttle-admission',
  'delay-direct',
  'die-after-home',
  'lose-response',
];
/** Mirrors `CHAOS_START_HOOK_ORPHAN_WINDOW_MS` plus the 5s fence margin. */
const ORPHAN_RELEASE_AFTER_MS = 60_000 + 5_000;
/** Mirrors `REDELIVER_PHASE_MS`, and world-vercel's 429 budget. */
const REDELIVER_PHASE_MS = 45_000;
const THROTTLE_RETRY_BUDGET_MS = 30_000;

const CROSS_REGIONS = ['sfo1', 'fra1'] as const;
const nonce = Math.random().toString(36).slice(2, 8);
const tokenFor = (faultClass: FaultClass, name: string) =>
  `chaos-drill-${faultClass}-${nonce}-${name}`;

/** workflow-server's `faultRoll`: FNV-1a 32 over `${fault}:${runId}`. */
function faultRoll(fault: Fault, runId: string): number {
  let hash = 0x811c9dc5;
  const text = `${fault}:${runId}`;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 2 ** 32;
}

function predictedFaults(faultClass: FaultClass, runId: string): Fault[] {
  const faults = faultClass === 'mix' ? MIX_FAULTS : [faultClass];
  return faults.filter((fault) => faultRoll(fault, runId) < RATES[fault]);
}

/** Mint time of a (region-tagged) runId. */
function mintedAt(runId: string): number {
  return decodeTime(decode(runId.slice('wrun_'.length)).ulid);
}

// =============================================================================
// Bookkeeping
// =============================================================================

interface Candidate {
  runId: string;
  region: string;
  outcome: string;
  predicted: Fault[];
}

interface TokenRecord {
  token: string;
  faultClass: FaultClass;
  scenario: string;
  candidates: Candidate[];
  owner?: string;
  callers: { caller: string; resolvedTo?: string; via?: string }[];
  failures: string[];
}

const records: TokenRecord[] = [];

function newRecord(
  faultClass: FaultClass,
  scenario: string,
  name: string
): TokenRecord {
  const record: TokenRecord = {
    token: tokenFor(faultClass, name),
    faultClass,
    scenario,
    candidates: [],
    callers: [],
    failures: [],
  };
  records.push(record);
  return record;
}

/** A world whose first `queue()` per start reports the candidate runId. */
function capturingWorld(world: World, onRunId: (runId: string) => void) {
  let seen = false;
  return {
    ...world,
    queue: (async (...args: Parameters<World['queue']>) => {
      const runId = (args[1] as { runId?: string }).runId;
      if (!seen && runId) {
        seen = true;
        onRunId(runId);
      }
      return world.queue(...args);
    }) as World['queue'],
  } as World;
}

const describeError = (error: unknown) =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const isRetryableStartError = (error: unknown) =>
  WorkflowStartError.is(error) ||
  ThrottleError.is(error) ||
  (WorkflowWorldError.is(error) &&
    (error.status === undefined || error.status >= 500));

async function runExists(world: World, runId: string): Promise<boolean> {
  try {
    await world.runs.get(runId, { resolveData: 'none' });
    return true;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || /not ?found/i.test(describeError(error))) {
      return false;
    }
    throw error;
  }
}

async function eventCount(world: World, runId: string): Promise<number> {
  try {
    const { data } = await world.events.list({ runId });
    return data.length;
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404 || /not ?found/i.test(describeError(error))) return 0;
    throw error;
  }
}

// =============================================================================
// Callers
// =============================================================================

type DrillWorkflow = Awaited<ReturnType<typeof getWorkflowMetadata>>;

interface ChildResult {
  childRunId: string;
  attempt: number;
  via: 'started' | 'conflict';
}

interface OwnerResult {
  runId: string;
  conflictRunId: string | null;
  sideEffectRunId: string | null;
  messages: string[];
}

/** One `start()` of a candidate for `record`, recorded. */
async function startCandidate(
  record: TokenRecord,
  workflow: DrillWorkflow,
  region: string,
  options: { minRetention?: number } = {}
): Promise<Run<OwnerResult>> {
  const world = await getWorld();
  const candidate: Candidate = {
    runId: '',
    region,
    outcome: 'pending',
    predicted: [],
  };
  record.candidates.push(candidate);
  try {
    const run = await rawStart<[string], OwnerResult>(
      workflow,
      [record.token],
      {
        world: capturingWorld(world, (runId) => {
          candidate.runId = runId;
          candidate.predicted = predictedFaults(record.faultClass, runId);
        }),
        region,
        attributes: { drillToken: record.token },
        hook: {
          token: record.token,
          ...(options.minRetention !== undefined && {
            experimental_minRetention: options.minRetention,
          }),
        },
      }
    );
    trackRun(run);
    candidate.outcome = 'admitted';
    return run;
  } catch (error) {
    candidate.outcome = HookConflictError.is(error)
      ? `refused:${error.conflictingRunId}`
      : describeError(error);
    if (WorkflowStartError.is(error) && !candidate.runId) {
      candidate.runId = error.runId;
    }
    throw error;
  }
}

/** Resume the owner; the token is reserved, not missing, until it adopts. */
async function routeToOwner(token: string, message: string) {
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      return await resumeHook(token, { message });
    } catch (error) {
      if (
        Date.now() > deadline ||
        !(HookReservedError.is(error) || ThrottleError.is(error))
      ) {
        throw error;
      }
      const retryAfter = (error as { retryAfter?: number }).retryAfter ?? 1;
      await sleep(retryAfter * 1000);
    }
  }
}

/**
 * Start or route to the owner, retrying an uncertain start with a new
 * candidate (the documented contract for `WorkflowStartError`).
 */
async function startOrRoute(
  record: TokenRecord,
  workflow: DrillWorkflow,
  caller: string
): Promise<void> {
  const entry: TokenRecord['callers'][number] = { caller };
  record.callers.push(entry);
  for (let attempt = 0; attempt < 10; attempt++) {
    const region =
      Math.random() < 0.2
        ? 'iad1'
        : CROSS_REGIONS[Math.floor(Math.random() * CROSS_REGIONS.length)];
    try {
      const run = await startCandidate(record, workflow, region);
      entry.resolvedTo = run.runId;
      entry.via = 'started';
      return;
    } catch (error) {
      if (HookConflictError.is(error)) {
        const hook = await routeToOwner(record.token, caller);
        entry.resolvedTo = error.conflictingRunId;
        entry.via = 'routed';
        if (hook.runId !== error.conflictingRunId) {
          record.failures.push(
            `${caller} was refused naming ${error.conflictingRunId} but resumed ${hook.runId}`
          );
        }
        return;
      }
      if (!isRetryableStartError(error)) {
        record.failures.push(`${caller}: ${describeError(error)}`);
        return;
      }
      await sleep(200 + Math.random() * 1_500);
    }
  }
  record.failures.push(`${caller} never resolved after 10 starts`);
}

/**
 * The checks every token gets once its callers are done: one owner, every
 * caller on it, refused candidates left no trace, the owner's log replays.
 */
async function settle(record: TokenRecord, owner?: string): Promise<void> {
  const world = await getWorld();
  const resolved = new Set(
    record.callers.map((c) => c.resolvedTo).filter(Boolean)
  );
  if (record.callers.some((c) => !c.resolvedTo)) {
    record.failures.push('a caller did not resolve');
  }
  if (resolved.size > 1) {
    record.failures.push(`callers resolved to ${[...resolved].join(', ')}`);
  }
  record.owner = owner ?? [...resolved][0];
  if (!record.owner) {
    record.failures.push('no owner');
    return;
  }
  if (!(await runExists(world, record.owner))) {
    record.failures.push(`owner ${record.owner} has no run`);
    return;
  }

  for (const candidate of record.candidates) {
    if (!candidate.runId || candidate.runId === record.owner) continue;
    if (await runExists(world, candidate.runId)) {
      record.failures.push(
        `refused candidate ${candidate.runId} (${candidate.outcome}) has a run`
      );
    } else if ((await eventCount(world, candidate.runId)) > 0) {
      record.failures.push(
        `refused candidate ${candidate.runId} (${candidate.outcome}) has events`
      );
    }
  }

  await routeToOwner(record.token, 'stop');
  const result = await getRun<OwnerResult>(record.owner).returnValue;
  const routed = record.callers
    .filter((c) => c.via === 'routed')
    .map((c) => c.caller)
    .sort();
  if (result.runId !== record.owner || result.conflictRunId !== null) {
    record.failures.push(`owner returned ${JSON.stringify(result)}`);
  }
  if (result.sideEffectRunId !== record.owner) {
    record.failures.push(`side effect recorded by ${result.sideEffectRunId}`);
  }
  if (JSON.stringify([...result.messages].sort()) !== JSON.stringify(routed)) {
    record.failures.push(
      `owner got ${JSON.stringify(result.messages)}, routed ${JSON.stringify(routed)}`
    );
  }

  const { data: events } = await world.events.list({ runId: record.owner });
  const created = events.filter((e) => e.eventType === 'run_created').length;
  if (created !== 1) record.failures.push(`${created} run_created events`);
  const steps = events.filter((e) => e.eventType === 'step_completed').length;
  if (steps !== 1) record.failures.push(`${steps} step_completed events`);
  const run = await world.runs.get(record.owner);
  if (run.status !== 'completed') {
    record.failures.push(`owner ended ${run.status}`);
  }
  if (run.attributes?.drillSideEffect !== record.owner) {
    record.failures.push(
      `owner attributes ${JSON.stringify(run.attributes ?? {})}`
    );
  }
}

/** Run listing: exactly one run of the drill workflow per token. */
async function checkListing(workflowId: string, since: number) {
  const world = await getWorld();
  const wanted = records.filter((r) => r.owner);
  const deadline = Date.now() + 120_000;
  for (;;) {
    const byToken = new Map<string, string[]>();
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const listed = await world.runs.list({
        workflowName: workflowId,
        resolveData: 'none',
        pagination: { limit: 100, ...(cursor && { cursor }) },
      });
      let older = false;
      for (const run of listed.data) {
        if (new Date(run.createdAt).getTime() < since) older = true;
        const token = run.attributes?.drillToken;
        if (typeof token === 'string' && token.includes(nonce)) {
          byToken.set(token, [...(byToken.get(token) ?? []), run.runId]);
        }
      }
      cursor = listed.cursor ?? undefined;
      if (older || !listed.hasMore || !cursor) break;
    }
    const missing = wanted.filter((r) => !byToken.has(r.token));
    if (missing.length === 0 || Date.now() > deadline) {
      for (const record of wanted) {
        const runs = byToken.get(record.token) ?? [];
        if (runs.length !== 1) {
          record.failures.push(`listing has ${runs.length} runs: ${runs}`);
        }
      }
      return;
    }
    await sleep(5_000);
  }
}

// =============================================================================
// The drill
// =============================================================================

describe.skipIf(!DRILL || isLocalDeployment())(
  'start({ hook }) chaos drill',
  () => {
    let owner: DrillWorkflow;
    let parent: DrillWorkflow;
    const since = Date.now() - 60_000;

    beforeAll(async () => {
      setupWorld(deploymentUrl);
      owner = await getWorkflowMetadata(
        deploymentUrl,
        'workflows/99_e2e.ts',
        'startHookDrillOwnerWorkflow'
      );
      parent = await getWorkflowMetadata(
        deploymentUrl,
        'workflows/99_e2e.ts',
        'startHookDrillParentWorkflow'
      );
    });

    beforeEach((ctx) => {
      setupRunTracking(ctx.task.name);
    });

    afterAll(async () => {
      if (records.some((r) => r.owner)) {
        await checkListing(owner.workflowId, since).catch((error) => {
          console.error('[drill] listing check failed', error);
        });
      }
      const byClass = new Map<
        FaultClass,
        {
          tokens: number;
          recovered: number;
          candidates: number;
          predicted: Partial<Record<Fault, number>>;
        }
      >();
      for (const record of records) {
        const row = byClass.get(record.faultClass) ?? {
          tokens: 0,
          recovered: 0,
          candidates: 0,
          predicted: {},
        };
        row.tokens++;
        if (record.failures.length === 0) row.recovered++;
        row.candidates += record.candidates.length;
        for (const candidate of record.candidates) {
          for (const fault of candidate.predicted) {
            row.predicted[fault] = (row.predicted[fault] ?? 0) + 1;
          }
        }
        byClass.set(record.faultClass, row);
      }
      const report = {
        nonce,
        summary: Object.fromEntries(byClass),
        unrecovered: records.filter((r) => r.failures.length > 0),
        records,
      };
      console.log(`[drill] report ${JSON.stringify(report, null, 2)}`);
      fs.writeFileSync(
        'e2e-start-hook-drill-report.json',
        JSON.stringify(report, null, 2)
      );
    }, 300_000);

    const expectRecovered = (scenario: string) => {
      const failed = records
        .filter((r) => r.scenario === scenario && r.failures.length > 0)
        .map((r) => `${r.token}: ${r.failures.join('; ')}`);
      expect(failed, failed.join('\n')).toEqual([]);
    };

    test(
      'concurrent starts per fault: one owner per token, every caller resolves to it',
      { timeout: 600_000, retry: 0 },
      async () => {
        const K = 3;
        const N = 4;
        const classes: FaultClass[] = [...MIX_FAULTS, 'mix'];
        const tokens = classes.flatMap((faultClass) =>
          Array.from({ length: K }, (_, k) =>
            newRecord(faultClass, 'concurrent', `c${k}`)
          )
        );
        await Promise.all(
          tokens.map(async (record) => {
            await Promise.all(
              Array.from({ length: N }, (_, n) =>
                startOrRoute(record, owner, `caller-${n}`)
              )
            );
            await settle(record).catch((error) => {
              record.failures.push(`settle: ${describeError(error)}`);
            });
          })
        );
        expectRecovered('concurrent');
      }
    );

    test(
      'an in-step start retried by its step is refused naming its own child',
      { timeout: 300_000, retry: 0 },
      async () => {
        const runs = await Promise.all(
          Array.from({ length: 3 }, async (_, k) => {
            const record = newRecord('mix', 'in-step', `step${k}`);
            const region = CROSS_REGIONS[k % CROSS_REGIONS.length];
            const run = await rawStart<[string, string], ChildResult>(parent, [
              record.token,
              region,
            ]);
            trackRun(run);
            return { record, run };
          })
        );
        await Promise.all(
          runs.map(async ({ record, run }) => {
            try {
              const result = await run.returnValue;
              record.callers.push({
                caller: 'parent-step',
                resolvedTo: result.childRunId,
                via: 'started',
              });
              record.candidates.push({
                runId: result.childRunId,
                region: 'in-step',
                outcome: `${result.via}@attempt${result.attempt}`,
                predicted: predictedFaults('mix', result.childRunId),
              });
              // `started` on a later attempt means the first attempts never
              // admitted a child (an uncertain start), so the forced retry was
              // not reached; the step's first success is always retried.
              if (result.via === 'started' && result.attempt === 1) {
                record.failures.push('the forced step retry did not happen');
              }
              await settle(record, result.childRunId);
            } catch (error) {
              record.failures.push(`parent: ${describeError(error)}`);
            }
          })
        );
        expectRecovered('in-step');
      }
    );

    test(
      'the token stays held for the default retention after its owner ends',
      { timeout: 300_000, retry: 0 },
      async () => {
        const record = newRecord('mix', 'retention', 'r0');
        await startOrRoute(record, owner, 'first');
        await settle(record);
        for (let n = 0; n < 3; n++) {
          const later = await startCandidate(
            record,
            owner,
            CROSS_REGIONS[n % CROSS_REGIONS.length]
          ).catch((error: unknown) => error);
          // An uncertain answer is retried as a caller would; anything but a
          // refusal naming the ended owner is a failure.
          let answer = later;
          for (
            let retry = 0;
            isRetryableStartError(answer) && retry < 5;
            retry++
          ) {
            await sleep(1_000);
            answer = await startCandidate(record, owner, 'sfo1').catch(
              (error: unknown) => error
            );
          }
          if (
            !HookConflictError.is(answer) ||
            answer.conflictingRunId !== record.owner
          ) {
            record.failures.push(
              `a start after the owner ended answered ${describeError(answer)}`
            );
          }
        }
        expectRecovered('retention');
      }
    );

    test(
      'an orphaned candidate holds the token for its window, then a contender fences and releases it',
      { timeout: 300_000, retry: 0 },
      async () => {
        const record = newRecord('orphan', 'orphan', 'o0');
        const world = await getWorld();
        const first = await startCandidate(record, owner, 'sfo1').catch(
          (error: unknown) => error
        );
        const orphan = record.candidates[0]?.runId;
        if (!WorkflowStartError.is(first) || !orphan) {
          record.failures.push(
            `the orphan's start answered ${describeError(first)}`
          );
          expectRecovered('orphan');
          return;
        }

        // Inside its window the orphan still holds the token, though it has no
        // run: a same-region contender is refused naming it.
        const early = await startCandidate(record, owner, 'iad1').catch(
          (error: unknown) => error
        );
        if (!HookConflictError.is(early) || early.conflictingRunId !== orphan) {
          record.failures.push(
            `inside the window a contender answered ${describeError(early)}`
          );
        }
        const reserved = await resumeHook(record.token, { message: 'x' }).catch(
          (error: unknown) => error
        );
        if (!HookReservedError.is(reserved)) {
          record.failures.push(
            `resuming the orphan's token answered ${describeError(reserved)}`
          );
        }

        await sleep(
          Math.max(
            0,
            mintedAt(orphan) + ORPHAN_RELEASE_AFTER_MS + 5_000 - Date.now()
          )
        );
        let contender: unknown;
        for (let attempt = 0; attempt < 6; attempt++) {
          contender = await startCandidate(record, owner, 'iad1').catch(
            (error: unknown) => error
          );
          if (!isRetryableStartError(contender)) break;
          await sleep(2_000);
        }
        if (HookConflictError.is(contender) || contender instanceof Error) {
          record.failures.push(
            `past the window the contender answered ${describeError(contender)}`
          );
          expectRecovered('orphan');
          return;
        }
        const run = contender as Run<OwnerResult>;
        record.callers.push({
          caller: 'contender',
          resolvedTo: run.runId,
          via: 'started',
        });
        await settle(record, run.runId);
        if (await runExists(world, orphan)) {
          record.failures.push(
            `the orphan ${orphan} was created after release`
          );
        }
        expectRecovered('orphan');
      }
    );

    test(
      'a queued copy throttled past its in-process budget is admitted by a redelivery',
      { timeout: 420_000, retry: 0 },
      async () => {
        const record = newRecord('redeliver', 'redeliver', 'q0');
        const world = await getWorld();
        const first = await startCandidate(record, owner, 'sfo1').catch(
          (error: unknown) => error
        );
        const runId = record.candidates[0]?.runId;
        if (!WorkflowStartError.is(first) || !runId) {
          record.failures.push(
            `the dropped direct start answered ${describeError(first)}`
          );
          expectRecovered('redeliver');
          return;
        }
        const deadline = Date.now() + 360_000;
        while (!(await runExists(world, runId))) {
          if (Date.now() > deadline) {
            record.failures.push(`${runId} was never admitted by a redelivery`);
            expectRecovered('redeliver');
            return;
          }
          await sleep(2_000);
        }
        const run = await world.runs.get(runId, { resolveData: 'none' });
        const createdAfterMs =
          new Date(run.createdAt).getTime() - mintedAt(runId);
        record.candidates[0].outcome = `admitted ${Math.round(createdAfterMs / 1000)}s after mint`;
        if (createdAfterMs < THROTTLE_RETRY_BUDGET_MS) {
          record.failures.push(
            `${runId} was created ${createdAfterMs}ms after its mint, inside the first delivery's 429 budget`
          );
        }
        if (createdAfterMs < REDELIVER_PHASE_MS - 1_000) {
          record.failures.push(
            `${runId} was created ${createdAfterMs}ms after its mint, inside the throttle phase`
          );
        }
        record.callers.push({
          caller: 'first',
          resolvedTo: runId,
          via: 'started',
        });
        await settle(record, runId);
        expectRecovered('redeliver');
      }
    );
  }
);

describe.skipIf(!DRY || isLocalDeployment())(
  'start({ hook }) chaos drill: dry check',
  () => {
    beforeAll(() => {
      setupWorld(deploymentUrl);
    });
    beforeEach((ctx) => {
      setupRunTracking(ctx.task.name);
    });

    test(
      'plain cross-region keyed starts: admit, refuse a duplicate, adopt, close',
      { timeout: 300_000, retry: 0 },
      async () => {
        const owner = await getWorkflowMetadata(
          deploymentUrl,
          'workflows/99_e2e.ts',
          'startHookDrillOwnerWorkflow'
        );
        const regions = ['sfo1', 'fra1', 'sfo1'] as const;
        await Promise.all(
          regions.map(async (region, n) => {
            // Not a chaos-drill token: no fault applies.
            const token = `start-hook-dry-${nonce}-${n}`;
            const run = await rawStart<[string], OwnerResult>(owner, [token], {
              region,
              hook: { token },
            });
            trackRun(run);
            const duplicate = await rawStart<[string], OwnerResult>(
              owner,
              [token],
              { region: region === 'sfo1' ? 'fra1' : 'sfo1', hook: { token } }
            ).catch((error: unknown) => error);
            expect(HookConflictError.is(duplicate)).toBe(true);
            expect(duplicate).toMatchObject({ conflictingRunId: run.runId });
            await routeToOwner(token, 'stop');
            const result = await run.returnValue;
            expect(result).toMatchObject({
              runId: run.runId,
              conflictRunId: null,
              sideEffectRunId: run.runId,
              messages: [],
            });
            console.log(`[drill] dry check ${region} ${token} -> ${run.runId}`);
          })
        );
      }
    );
  }
);
