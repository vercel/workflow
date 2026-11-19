/**
 * node:vm against QuickJS on spec 9 runs: time to first step, time to resume
 * and per-step overhead, through the real delivery loop on the in-memory
 * World. The findings it produced are in `../quickjs-performance.md`. Opt-in,
 * since a timing is not a pass/fail signal on a shared runner:
 *
 *   WORKFLOW_ENGINE_BENCH=1 pnpm vitest run src/runtime/spec9/engine-latency.bench.runtime.test.ts
 *
 * Knobs (all optional):
 *
 * - `BENCH_ENGINES`: `node,quickjs` (default) or one of them.
 * - `BENCH_RTT_MS`: latency added to every World call (default 0, which
 *   isolates CPU). The bench reports how many World calls each path made, so
 *   a round trip's cost on a remote World is `calls x RTT` either way.
 * - `BENCH_BUNDLE`: path to a workflow bundle (the `workflowCode` a build
 *   embeds in the flow route) to load alongside the scenario workflows, so
 *   the VM pays the cost of a realistic bundle. Default: none.
 * - `BENCH_ITERATIONS`: samples per scenario (default 7, after one warm-up).
 * - `BENCH_LOG_SIZES`: prefix lengths for the resume scenarios (default
 *   `0,10,100,500,1000,2000`).
 * - `BENCH_SNAPSHOTS=1`: give the World an in-memory `experimental_snapshots`
 *   store, so QuickJS saves and restores VM snapshots past its threshold.
 * - `BENCH_RESUME_DELAY_MS`: wait this long between a hook-resume scenario's
 *   suspension and its `resumeHook()` (default 0), so a QuickJS snapshot save
 *   that runs after the delivery returns can finish first.
 * - `BENCH_OUT`: write the raw results as JSON to this path.
 */
import fs from 'node:fs';
import { HookNotFoundError } from '@workflow/errors';
import {
  type Hook,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import {
  AppendOnlyWorld,
  type HeldMessage,
} from '../../test-support/append-only-world.js';
import { resumeHook } from '../resume-hook.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const ENABLED = process.env.WORKFLOW_ENGINE_BENCH === '1';
const ENGINES = (process.env.BENCH_ENGINES ?? 'node,quickjs').split(',') as (
  | 'node'
  | 'quickjs'
)[];
const RTT_MS = Number(process.env.BENCH_RTT_MS ?? 0);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 7);
const LOG_SIZES = (process.env.BENCH_LOG_SIZES ?? '0,10,100,500,1000,2000')
  .split(',')
  .map(Number);
const BUNDLE = process.env.BENCH_BUNDLE
  ? fs.readFileSync(process.env.BENCH_BUNDLE, 'utf8')
  : '';

const SNAPSHOTS = process.env.BENCH_SNAPSHOTS === '1';
const RESUME_DELAY_MS = Number(process.env.BENCH_RESUME_DELAY_MS ?? 0);

const QUEUE = '__wkf_workflow_workflow';

/** `performance.now()` at each step body's entry, by label. */
const bodyStarts = new Map<string, number>();
const bodyStarted = (label: string) => {
  if (!bodyStarts.has(label)) bodyStarts.set(label, performance.now());
};
registerStepFunction('eb_step', async (label: string) => {
  bodyStarted(label);
  return label;
});

const prelude = `${BUNDLE}
  ;if (!globalThis.__private_workflows) globalThis.__private_workflows = new Map();
  const __eb_useStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const __eb_createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const __eb_sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const __eb_step = __eb_useStep("eb_step");`;
// Registered as `workflow`, the name every seeded run uses.
const register = (fn: string) =>
  `;globalThis.__private_workflows.set("workflow", ${fn});`;

const ONE_STEP = `${prelude}
  async function __eb_workflow() { return await __eb_step("first"); }${register('__eb_workflow')}`;

const SEQUENTIAL = `${prelude}
  async function __eb_workflow(n) {
    for (let i = 0; i < n; i++) await __eb_step("s" + i);
    return n;
  }${register('__eb_workflow')}`;

const FAN_OUT = `${prelude}
  async function __eb_workflow(n) {
    return (await Promise.all(Array.from({ length: n }, (_, i) => __eb_step("f" + i)))).length;
  }${register('__eb_workflow')}`;

const HOOK_AFTER_PREFIX = `${prelude}
  async function __eb_workflow(n, token) {
    for (let i = 0; i < n; i++) await __eb_step("p" + i);
    const hook = __eb_createHook({ token });
    const payload = await hook;
    await __eb_step("after-hook");
    return payload;
  }${register('__eb_workflow')}`;

const SLEEP_AFTER_PREFIX = `${prelude}
  async function __eb_workflow(n) {
    for (let i = 0; i < n; i++) await __eb_step("p" + i);
    await __eb_sleep("1s");
    await __eb_step("after-sleep");
    return n;
  }${register('__eb_workflow')}`;

interface WorldCall {
  name: string;
  start: number;
  end: number;
}

const LOCAL_CALLS = new Set(['getEncryptionKeyForRun', 'getDeploymentId']);

/** Every World call, with `RTT_MS` added before it reaches the fake. */
function instrument(world: World, calls: WorldCall[]): World {
  const wrap = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        if (typeof value !== 'function' || typeof key !== 'string') {
          return value;
        }
        if (key === 'subscribe' || key === 'createQueueHandler') {
          return value.bind(obj);
        }
        return async (...args: unknown[]) => {
          const call = {
            name: `${prefix}${key}`,
            start: performance.now(),
            end: 0,
          };
          calls.push(call);
          // Key derivation and the deployment id are local on world-vercel.
          if (RTT_MS > 0 && !LOCAL_CALLS.has(key)) {
            await new Promise((r) => setTimeout(r, RTT_MS));
          }
          try {
            return await value.apply(obj, args);
          } finally {
            call.end = performance.now();
          }
        };
      },
    });
  const out = wrap(world, '') as World & Record<string, unknown>;
  const events = wrap(world.events, 'events.');
  const runs = wrap(world.runs, 'runs.');
  const hooks = (world as { hooks?: object }).hooks;
  const snapshots = (world as { experimental_snapshots?: object })
    .experimental_snapshots;
  const wrappedSnapshots = snapshots && wrap(snapshots, 'snapshots.');
  return new Proxy(out, {
    get(obj, key, receiver) {
      if (key === 'events') return events;
      if (key === 'runs') return runs;
      if (key === 'experimental_snapshots') return wrappedSnapshots;
      if (key === 'hooks' && hooks) return wrap(hooks, 'hooks.');
      return Reflect.get(obj, key, receiver);
    },
  });
}

/** `hooks.getByToken` over the fake's log, for `resumeHook()`. */
function withHooks(world: AppendOnlyWorld, runId: string): World {
  const base = world.asWorld();
  (base as { hooks: unknown }).hooks = {
    async getByToken(token: string): Promise<Hook> {
      const created = world.events.find(
        (e) =>
          e.eventType === 'hook_created' &&
          (e as { eventData?: { token?: string } }).eventData?.token === token
      );
      if (!created) throw new HookNotFoundError(token);
      return {
        runId,
        hookId: created.correlationId as string,
        token,
        ownerId: 'owner_test',
        projectId: 'project_test',
        environment: 'production',
        createdAt: created.createdAt,
        specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        resumeContext: {
          deploymentId: 'dpl_test',
          workflowName: 'workflow',
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          workflowCoreVersion: '5.0.0',
        },
      } as Hook;
    },
  };
  if (SNAPSHOTS) {
    // An in-memory snapshot store, as a World with `experimental_snapshots`.
    const store = new Map<string, { data: Uint8Array; metadata: unknown }>();
    (base as { experimental_snapshots: unknown }).experimental_snapshots = {
      async save(id: string, data: Uint8Array, metadata: unknown) {
        store.set(id, { data, metadata });
      },
      async load(id: string) {
        return store.get(id) ?? null;
      },
      async delete(id: string) {
        store.delete(id);
      },
    };
  }
  return base;
}

async function setup(
  code: string,
  args: unknown[],
  engine: 'node' | 'quickjs',
  options: ConstructorParameters<typeof AppendOnlyWorld>[0] = {},
  /** Carry `runInput` on the start message, as `start()` does: turbo. */
  turbo = false
) {
  const runId = `wrun_eb_${Math.random().toString(36).slice(2)}`;
  const world = new AppendOnlyWorld(options);
  const input = await dehydrateWorkflowArguments(args, runId, undefined, []);
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    executionContext: { workflowVm: engine },
    input,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  const calls: WorldCall[] = [];
  setWorld(instrument(withHooks(world, runId), calls));
  // Registers the queue handler on this World.
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const start = world.enqueue(QUEUE, {
    runId,
    requestedAt: new Date(),
    ...(turbo
      ? {
          runInput: {
            deploymentId: 'dpl_test',
            workflowName: 'workflow',
            input,
            executionContext: { workflowVm: engine },
            specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
          },
        }
      : {}),
  });
  return { world, runId, start, calls };
}

const callsBetween = (calls: WorldCall[], from: number, to: number) =>
  calls.filter((c) => c.start >= from && c.start < to).map((c) => c.name);

type Sample = Record<string, number | string>;
const results: { scenario: string; engine: string; samples: Sample[] }[] = [];

function record(scenario: string, engine: string, samples: Sample[]) {
  results.push({ scenario, engine, samples });
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : Number.NaN;
};
const p90 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length
    ? s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]!
    : Number.NaN;
};

function report() {
  const lines: string[] = [];
  lines.push(
    `[engine-bench] rtt=${RTT_MS}ms bundle=${BUNDLE.length} chars iterations=${ITERATIONS} snapshots=${SNAPSHOTS}`
  );
  for (const { scenario, engine, samples } of results) {
    const keys = Object.keys(samples[0] ?? {}).filter(
      (k) => typeof samples[0]![k] === 'number'
    );
    const cells = keys.map((k) => {
      const xs = samples.map((s) => s[k] as number);
      return `${k}=${median(xs).toFixed(2)} (p90 ${p90(xs).toFixed(2)})`;
    });
    const path = samples[0]?.calls ? ` calls=[${samples[0].calls}]` : '';
    lines.push(
      `${scenario.padEnd(28)} ${engine.padEnd(8)} ${cells.join('  ')}${path}`
    );
  }
  process.stderr.write(`${lines.join('\n')}\n`);
  if (process.env.BENCH_OUT) {
    fs.writeFileSync(
      process.env.BENCH_OUT,
      JSON.stringify(
        {
          rttMs: RTT_MS,
          bundleChars: BUNDLE.length,
          snapshots: SNAPSHOTS,
          results,
        },
        null,
        2
      )
    );
  }
}

function quietEnv() {
  // Exit as soon as the run suspends, so a resume is a new delivery; the
  // linger scenario turns it back on.
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_WAIT_LINGER_MS', '0');
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', String(60 * 60_000));
  vi.stubEnv('WORKFLOW_REPLAY_TIMEOUT_MS', String(60 * 60_000));
}

function nextHeld(world: AppendOnlyWorld): HeldMessage {
  const held = world.held.find((h) => h.queueName === QUEUE);
  if (!held) throw new Error('no held orchestrator message');
  return held;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setWorld(undefined);
});

afterAll(() => {
  if (ENABLED) report();
});

describe.runIf(ENABLED)('engine latency (spec 9)', () => {
  for (const engine of ENGINES) {
    it(`${engine}: time to first step, first run in the process`, async () => {
      quietEnv();
      bodyStarts.clear();
      const { world, start, calls } = await setup(ONE_STEP, [], engine);
      const t0 = performance.now();
      await world.deliver(start);
      const t1 = performance.now();
      const body = bodyStarts.get('first')!;
      record('ttfs.cold-process', engine, [
        {
          ttfsMs: body - t0,
          deliveryMs: t1 - t0,
          worldCallsBeforeBody: callsBetween(calls, t0, body).length,
          calls: callsBetween(calls, t0, body).join(','),
        },
      ]);
    }, 120_000);

    for (const turbo of [false, true]) {
      it(`${engine}: time to first step, warm process${turbo ? ', turbo' : ''}`, async () => {
        quietEnv();
        const samples: Sample[] = [];
        for (let i = 0; i <= ITERATIONS; i++) {
          bodyStarts.clear();
          const { world, start, calls } = await setup(
            ONE_STEP,
            [],
            engine,
            {},
            turbo
          );
          const t0 = performance.now();
          await world.deliver(start);
          const t1 = performance.now();
          const body = bodyStarts.get('first')!;
          if (i === 0) continue;
          samples.push({
            ttfsMs: body - t0,
            deliveryMs: t1 - t0,
            worldCallsBeforeBody: callsBetween(calls, t0, body).length,
            calls: callsBetween(calls, t0, body).join(','),
          });
        }
        record(turbo ? 'ttfs.warm.turbo' : 'ttfs.warm', engine, samples);
      }, 300_000);
    }

    for (const n of [200, 2000]) {
      it(`${engine}: per-step overhead, ${n} sequential inline steps`, async () => {
        quietEnv();
        const samples: Sample[] = [];
        for (let i = 0; i <= (n > 500 ? 1 : Math.min(ITERATIONS, 3)); i++) {
          bodyStarts.clear();
          const { world, start, calls } = await setup(SEQUENTIAL, [n], engine);
          const t0 = performance.now();
          await world.deliver(start);
          const t1 = performance.now();
          if (i === 0) continue;
          const gaps: number[] = [];
          for (let s = 1; s < n; s++) {
            gaps.push(bodyStarts.get(`s${s}`)! - bodyStarts.get(`s${s - 1}`)!);
          }
          samples.push({
            stepGapMedianMs: median(gaps),
            stepGapP90Ms: p90(gaps),
            firstHalfGapMs: median(gaps.slice(0, n / 2)),
            secondHalfGapMs: median(gaps.slice(n / 2)),
            firstTenthGapMs: median(gaps.slice(0, n / 10)),
            lastTenthGapMs: median(gaps.slice(-n / 10)),
            deliveryMs: t1 - t0,
            worldCallsPerStep: calls.length / n,
          });
        }
        record(`sequential.${n}`, engine, samples);
      }, 600_000);
    }

    it(`${engine}: fan-out of 100`, async () => {
      quietEnv();
      const n = 100;
      const samples: Sample[] = [];
      for (let i = 0; i <= Math.min(ITERATIONS, 5); i++) {
        bodyStarts.clear();
        const { world, start, calls } = await setup(FAN_OUT, [n], engine);
        const t0 = performance.now();
        await world.deliver(start);
        const tFirstDelivery = performance.now();
        // Background steps and the wakes they send, until the run ends.
        await world.runUntilIdle(1000);
        const t1 = performance.now();
        if (i === 0) continue;
        const starts = [...bodyStarts.values()];
        samples.push({
          firstBodyMs: Math.min(...starts) - t0,
          lastInlineOrBgBodyMs: Math.max(...starts) - t0,
          firstDeliveryMs: tFirstDelivery - t0,
          totalMs: t1 - t0,
          worldCalls: calls.length,
        });
        expect(world.events.some((e) => e.eventType === 'run_completed')).toBe(
          true
        );
      }
      record('fanout.100', engine, samples);
    }, 600_000);

    for (const prefix of LOG_SIZES) {
      it(`${engine}: resume after a hook, ${prefix}-step prefix (new delivery)`, async () => {
        quietEnv();
        const samples: Sample[] = [];
        const iterations =
          prefix >= 1000 ? Math.min(ITERATIONS, 3) : ITERATIONS;
        for (let i = 0; i <= iterations; i++) {
          bodyStarts.clear();
          const token = `eb-${Math.random().toString(36).slice(2)}`;
          const { world, start, calls } = await setup(
            HOOK_AFTER_PREFIX,
            [prefix, token],
            engine
          );
          await world.deliver(start);
          expect(world.events.some((e) => e.eventType === 'hook_created')).toBe(
            true
          );
          const logLength = world.events.length;
          // Lets work the delivery left running (a QuickJS snapshot save)
          // finish before the resume, as a later user reply would.
          if (RESUME_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, RESUME_DELAY_MS));
          }
          const t0 = performance.now();
          await resumeHook(token, { ok: true });
          const tResumed = performance.now();
          const wake = nextHeld(world);
          const tDeliver = performance.now();
          await world.deliver(wake);
          const t1 = performance.now();
          const body = bodyStarts.get('after-hook');
          expect(body).toBeDefined();
          if (i === 0 && iterations > 1) continue;
          samples.push({
            resumeHookMs: tResumed - t0,
            wakeToBodyMs: body! - tDeliver,
            wakeDeliveryMs: t1 - tDeliver,
            logEvents: logLength,
            worldCallsBeforeBody: callsBetween(calls, tDeliver, body!).length,
            calls: callsBetween(calls, tDeliver, body!).join(','),
          });
        }
        record(`resume.hook.prefix${prefix}`, engine, samples);
      }, 1_200_000);
    }

    for (const prefix of [0, 100, 1000]) {
      if (!LOG_SIZES.includes(prefix)) continue;
      it(`${engine}: resume after a sleep, ${prefix}-step prefix (timer delivery)`, async () => {
        quietEnv();
        const samples: Sample[] = [];
        const iterations =
          prefix >= 1000 ? Math.min(ITERATIONS, 3) : Math.min(ITERATIONS, 5);
        for (let i = 0; i <= iterations; i++) {
          bodyStarts.clear();
          const { world, start, calls } = await setup(
            SLEEP_AFTER_PREFIX,
            [prefix],
            engine
          );
          await world.deliver(start);
          const timer = nextHeld(world);
          const wait = (timer.dueAtMs ?? Date.now()) - Date.now();
          if (wait > 0) await new Promise((r) => setTimeout(r, wait + 5));
          const tDeliver = performance.now();
          await world.deliver(timer);
          // A timer that came due early hands off; deliver until the body runs.
          for (let k = 0; k < 5 && !bodyStarts.has('after-sleep'); k++) {
            const next = world.held.find((h) => h.queueName === QUEUE);
            if (!next) break;
            await new Promise((r) => setTimeout(r, 5));
            await world.deliver(next);
          }
          const body = bodyStarts.get('after-sleep');
          expect(body).toBeDefined();
          if (i === 0) continue;
          samples.push({
            timerToBodyMs: body! - tDeliver,
            worldCallsBeforeBody: callsBetween(calls, tDeliver, body!).length,
            calls: callsBetween(calls, tDeliver, body!).join(','),
          });
        }
        record(`resume.sleep.prefix${prefix}`, engine, samples);
      }, 1_200_000);
    }

    it(`${engine}: a wake with nothing new (no-op delivery), 100-step prefix`, async () => {
      quietEnv();
      const samples: Sample[] = [];
      for (let i = 0; i <= Math.min(ITERATIONS, 5); i++) {
        bodyStarts.clear();
        const token = `eb-${Math.random().toString(36).slice(2)}`;
        const { world, runId, calls } = await setup(
          HOOK_AFTER_PREFIX,
          [100, token],
          engine
        ).then(async (ctx) => {
          await ctx.world.deliver(ctx.start);
          return ctx;
        });
        const eventsBefore = world.events.length;
        const wake = world.enqueue(QUEUE, { runId, requestedAt: new Date() });
        const t0 = performance.now();
        await world.deliver(wake);
        const t1 = performance.now();
        if (i === 0) continue;
        samples.push({
          noopDeliveryMs: t1 - t0,
          eventsWritten: world.events.length - eventsBefore,
          worldCalls: callsBetween(calls, t0, t1).length,
          calls: callsBetween(calls, t0, t1).join(','),
        });
      }
      record('noop.wake.prefix100', engine, samples);
    }, 600_000);

    it(`${engine}: resume after a hook while the orchestrator lingers (live feed)`, async () => {
      quietEnv();
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_HOOK_LINGER_MS', '2000');
      vi.stubEnv('WORKFLOW_ORCHESTRATOR_LINGER_MS', '2000');
      const samples: Sample[] = [];
      for (let i = 0; i <= Math.min(ITERATIONS, 5); i++) {
        bodyStarts.clear();
        const token = `eb-${Math.random().toString(36).slice(2)}`;
        const { world, start } = await setup(
          HOOK_AFTER_PREFIX,
          [10, token],
          engine,
          { subscribe: true }
        );
        const delivery = world.deliver(start);
        // Wait for the hook to be created, then resume while the delivery lingers.
        for (let k = 0; k < 2000; k++) {
          if (world.events.some((e) => e.eventType === 'hook_created')) break;
          await new Promise((r) => setTimeout(r, 1));
        }
        await new Promise((r) => setTimeout(r, 20));
        const t0 = performance.now();
        await resumeHook(token, { ok: true });
        await delivery;
        const body = bodyStarts.get('after-hook');
        const newDeliveries = world.held.filter((h) => h.queueName === QUEUE);
        // Deliver any wake left over if the linger did not pick it up.
        for (const held of newDeliveries) await world.deliver(held);
        const bodyAfter = bodyStarts.get('after-hook');
        if (i === 0) continue;
        samples.push({
          resumeToBodyMs: (body ?? bodyAfter ?? Number.NaN) - t0,
          servedByLinger: body !== undefined ? 1 : 0,
        });
      }
      record('resume.hook.linger', engine, samples);
    }, 600_000);
  }
});
