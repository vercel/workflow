/**
 * Property tests for running a run's orchestrator delivery in the process
 * that sent it, which `start()` and `resumeHook()` do by default on a World
 * that can hold queue messages, through a held send
 * (`QueueOptions.experimental_hold`).
 *
 * Each case is a seed. It picks a workflow, a spec version, and one fault to
 * inject at a random world call the held delivery makes:
 *
 * - `lapse`: the hold lapses while the sender keeps running, so the queue
 *   redelivers the same message alongside it (a held run racing a
 *   redelivery). Only the in-band fence keeps the two apart on a spec 9 run.
 * - `crash`: the sender dies there, before or after the call's effect: the
 *   call and every later one never return, and the queue redelivers.
 * - `resume`: a hook resume (itself inline) arrives while the held delivery
 *   is in that call.
 * - `none`: a control.
 *
 * Every case must end with the run `completed` and its expected output, each
 * step with exactly one committed outcome, one terminal run event, no
 * invariant violation, and a log a cold replay re-derives (`runScenario`
 * checks the last two). Step bodies may run more than once after a lapse or a
 * crash (steps are at least once), but never commit twice.
 */

import { workflowEntrypoint } from '@workflow/core/runtime';
import type { Event } from '@workflow/world';
import { afterAll, describe, expect, it } from 'vitest';
import { heldDeliveryContext } from './queue.js';
import { renderScenario } from './report.js';
import { runScenario, type ScenarioResult } from './scenario.js';
import type { CallMatch, ScenarioScript } from './types.js';

// ---------------------------------------------------------------------------
// Workflows: VM code and step bodies, as a build would register them.
// ---------------------------------------------------------------------------

type StepFn = ((...args: unknown[]) => Promise<unknown>) & { stepId?: string };
const STEPS_KEY = Symbol.for('@workflow/core//registeredSteps');
const globalSteps = globalThis as typeof globalThis & {
  [STEPS_KEY]?: Map<string, StepFn>;
};
globalSteps[STEPS_KEY] ??= new Map();
const steps = globalSteps[STEPS_KEY];

/** Step body executions, by step name. Reset per case. */
const executions = new Map<string, number>();
function registerStep(name: string, body: (...args: number[]) => number) {
  const fn: StepFn = async (...args) => {
    executions.set(name, (executions.get(name) ?? 0) + 1);
    return body(...(args as number[]));
  };
  fn.stepId = name;
  steps.set(name, fn);
}
registerStep('inline_fuzz_a', (x) => x + 1);
registerStep('inline_fuzz_b', (x) => x * 2);
registerStep('inline_fuzz_c', (x) => x * 3);

const useStep = (name: string) =>
  `globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(name)})`;
const register = (name: string) =>
  `;globalThis.__private_workflows = new Map([[${JSON.stringify(name)}, workflow]]);`;

const HOOK_TOKEN = 'inline-fuzz-hook';

const WORKFLOWS = {
  /** A step, then two in parallel: 1 → 2 → (4, 6) = 12 for input 1. */
  steps: {
    code: `const a = ${useStep('inline_fuzz_a')};
      const b = ${useStep('inline_fuzz_b')};
      const c = ${useStep('inline_fuzz_c')};
      async function workflow(x) {
        const one = await a(x);
        const [two, three] = await Promise.all([b(one), c(one)]);
        return one + two + three;
      }${register('inline_fuzz_steps')}`,
    name: 'inline_fuzz_steps',
    input: [1],
    output: 12,
    stepCount: 3,
  },
  /** A step, a hook, a step: (1 + 1 + 5) * 2 = 14 for input 1, n = 5. */
  hook: {
    code: `const a = ${useStep('inline_fuzz_a')};
      const b = ${useStep('inline_fuzz_b')};
      const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow(x) {
        const one = await a(x);
        const hook = createHook({ token: ${JSON.stringify(HOOK_TOKEN)} });
        const { n } = await hook;
        return await b(one + n);
      }${register('inline_fuzz_hook')}`,
    name: 'inline_fuzz_hook',
    input: [1],
    output: 14,
    stepCount: 2,
  },
} as const;

type WorkflowKey = keyof typeof WORKFLOWS;
type Fault = 'none' | 'lapse' | 'crash' | 'resume';

// ---------------------------------------------------------------------------
// Seeded choices
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    // xorshift32
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

interface Case {
  seed: number;
  workflow: WorkflowKey;
  specVersion: 8 | 9;
  fault: Fault;
  /** The fault lands on the held delivery's `ordinal`-th matching call. */
  ordinal: number;
  phase: 'before' | 'after';
  /** `WORKFLOW_INLINE_DELIVERY=0`: everything is queued, as before. */
  killSwitch?: boolean;
}

function caseFor(seed: number): Case {
  const next = prng(seed * 2654435761);
  const pick = <T>(of: readonly T[]): T =>
    of[Math.floor(next() * of.length)] as T;
  const workflow = pick(['steps', 'hook'] as const);
  return {
    seed,
    workflow,
    specVersion: pick([8, 9] as const),
    fault: pick(
      workflow === 'hook'
        ? (['none', 'lapse', 'crash', 'resume'] as const)
        : (['none', 'lapse', 'crash'] as const)
    ),
    ordinal: 1 + Math.floor(next() * 12),
    phase: pick(['before', 'after'] as const),
    killSwitch: next() < 0.1,
  };
}

// ---------------------------------------------------------------------------
// Playing a case
// ---------------------------------------------------------------------------

/** The world calls a held delivery makes that a fault can land on. */
const FAULT_CALLS: CallMatch['call'] = [
  'events.create',
  'events.list',
  'runs.get',
  'queue',
];

/** Whether a call is one a fault of case `c` may land on. */
function faultPoint(
  c: Case,
  sim: Parameters<ScenarioScript>[0],
  world: Parameters<NonNullable<CallMatch['where']>>[1]
): boolean {
  const held = heldDeliveryContext.getStore();
  if (!held || held.lapsed) return false;
  if (c.fault === 'resume') {
    // While the start's own held delivery runs and its hook exists.
    const payload = held.message.payload as { runInput?: unknown };
    if (payload.runInput === undefined) return false;
    if (world.hooks(sim.runId).length === 0) return false;
  }
  return true;
}

/** Delivers the hook once it exists (inline, see `queueHold`). */
async function deliverHookWhenCreated(sim: Parameters<ScenarioScript>[0]) {
  if (sim.world.hooks(sim.runId).length === 0) {
    await sim.until({ eventType: 'hook_created' }, 'hook');
  }
  await sim.deliverHook(HOOK_TOKEN, { n: 5 });
}

/**
 * A script that counts the calls a fault of `c` could land on, into
 * `counter`, without injecting anything. Its scenario plays the same prefix a
 * faulted one does up to the fault, so an ordinal at most the count is
 * reached.
 */
function countingScriptFor(
  c: Case,
  counter: { calls: number }
): ScenarioScript {
  return async (sim) => {
    void sim
      .park(
        {
          call: FAULT_CALLS,
          phase: c.phase,
          where: (_ctx, world) => {
            if (faultPoint(c, sim, world)) counter.calls++;
            return false;
          },
        },
        'count'
      )
      .catch(() => {});
    // A resume fault's run gets its hook only from the fault.
    if (c.workflow === 'hook' && c.fault !== 'resume') {
      await deliverHookWhenCreated(sim);
    }
  };
}

function scriptFor(c: Case): ScenarioScript {
  return async (sim) => {
    const jobs: Promise<void>[] = [];
    if (c.workflow === 'hook' && c.fault !== 'resume') {
      jobs.push(deliverHookWhenCreated(sim));
    }
    if (c.fault !== 'none') {
      jobs.push(
        (async () => {
          let seen = 0;
          const parked = await sim.park(
            {
              call: FAULT_CALLS,
              phase: c.phase,
              where: (_ctx, world) =>
                faultPoint(c, sim, world) && ++seen === c.ordinal,
            },
            'fault'
          );
          sim.note(`fault ${c.fault} at held call #${c.ordinal} (${c.phase})`);
          if (c.fault === 'lapse') sim.lapseHeldDeliveries();
          if (c.fault === 'crash') sim.lapseHeldDeliveries({ crash: true });
          if (c.fault === 'resume') {
            await sim.deliverHook(HOOK_TOKEN, { n: 5 });
          }
          parked.release();
        })()
      );
    }
    await Promise.all(jobs);
  };
}

/** Committed outcomes per step, and terminal run events, from the log. */
function outcomes(events: Event[]) {
  const perStep = new Map<string, string[]>();
  for (const event of events) {
    if (
      event.eventType === 'step_completed' ||
      event.eventType === 'step_failed'
    ) {
      const id = event.correlationId ?? '?';
      perStep.set(id, [...(perStep.get(id) ?? []), event.eventType]);
    }
  }
  const terminal = events.filter(
    (e) =>
      e.eventType === 'run_completed' ||
      e.eventType === 'run_failed' ||
      e.eventType === 'run_cancelled'
  );
  return { perStep, terminal };
}

function scenarioFor(c: Case, script: ScenarioScript) {
  const wf = WORKFLOWS[c.workflow];
  return runScenario(
    {
      id: `inline-fuzz-${c.seed}`,
      name: `inline ${c.workflow} spec ${c.specVersion} ${c.fault}@${c.ordinal}/${c.phase}`,
      workflow: { workflowId: wf.name },
      input: [...wf.input],
      // A World that can hold: start() and resumeHook() inline by default.
      queueHold: true,
      startOptions: { specVersion: c.specVersion },
      script,
      expect: { status: 'completed', output: wf.output },
      limits: { maxWallMs: 20_000 },
      // No tail poll: the held delivery sees a redelivery's writes only on
      // its own next write, which is the overlap the fence must handle.
      env: {
        WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS: '0',
        ...(c.killSwitch && { WORKFLOW_INLINE_DELIVERY: '0' }),
      },
    },
    { handler: workflowEntrypoint(wf.code) }
  );
}

/**
 * Plays case `c`: first without the fault, counting the calls it could land
 * on, then with it at an ordinal that is reached. A case with no such call
 * (the run never offers one) plays as a control.
 */
async function play(c: Case): Promise<{ c: Case; result: ScenarioResult }> {
  let played = c;
  if (c.fault !== 'none') {
    const counter = { calls: 0 };
    await scenarioFor(c, countingScriptFor(c, counter));
    played =
      counter.calls === 0
        ? { ...c, fault: 'none' }
        : { ...c, ordinal: 1 + ((c.ordinal - 1) % counter.calls) };
  }
  executions.clear();
  return { c: played, result: await scenarioFor(played, scriptFor(played)) };
}

function describeFailure(c: Case, result: ScenarioResult): string {
  return [
    `case ${JSON.stringify(c)}`,
    `outcome ${result.outcome}`,
    ...result.problems.map((p) => `problem: ${p}`),
    ...result.violations.map((v) => `violation ${v.rule}: ${v.message}`),
    'log:',
    ...result.events.map((e) =>
      `  ${e.eventType} ${e.correlationId ?? ''}`.trimEnd()
    ),
  ].join('\n');
}

const SEEDS = Number(process.env.WORLD_SIM_INLINE_FUZZ_SEEDS ?? 60);
/** Replay one seed (`WORLD_SIM_INLINE_FUZZ_SEED=17`), printing its trace. */
const ONLY_SEED = process.env.WORLD_SIM_INLINE_FUZZ_SEED;

describe('inline orchestrator delivery under faults', () => {
  it('a held start runs in the sender with no queue delivery', async () => {
    const c: Case = {
      seed: 0,
      workflow: 'steps',
      specVersion: 9,
      fault: 'none',
      ordinal: 1,
      phase: 'after',
    };
    const { result } = await play(c);
    expect(result.ok, describeFailure(c, result)).toBe(true);
    // The whole run was the held delivery: the loop never delivered an
    // orchestrator message.
    expect(result.deliveries).toBe(0);
    expect(result.trace.some((t) => t.kind === 'delivery')).toBe(false);
  });

  /** Cases played, by workflow, spec and the fault that actually landed. */
  const summary = new Map<string, number>();
  afterAll(() => {
    console.info(
      '[inline-fuzz] cases played',
      JSON.stringify(Object.fromEntries([...summary].sort()), null, 1)
    );
  });
  it.each(
    ONLY_SEED
      ? [Number(ONLY_SEED)]
      : Array.from({ length: SEEDS }, (_, i) => i + 1)
  )('seed %i', async (seed) => {
    const { c, result } = await play(caseFor(seed));
    if (ONLY_SEED) console.log(renderScenario(result));
    const detail = describeFailure(c, result);
    expect(result.ok, detail).toBe(true);
    expect(result.outcome, detail).toBe('completed');

    const { perStep, terminal } = outcomes(result.events);
    expect(
      terminal.map((e) => e.eventType),
      detail
    ).toEqual(['run_completed']);
    const wf = WORKFLOWS[c.workflow];
    expect(perStep.size, detail).toBe(wf.stepCount);
    for (const [id, committed] of perStep) {
      expect(committed, `${id}\n${detail}`).toEqual(['step_completed']);
    }
    // Without a lapse or a crash, nothing runs twice.
    if (c.fault === 'none' || c.fault === 'resume') {
      for (const [name, count] of executions) {
        expect(count, `${name}\n${detail}`).toBe(1);
      }
    }
    const key = `${c.workflow}/spec${c.specVersion}/${c.fault}`;
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }, 30_000);
});
