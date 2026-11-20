/**
 * Generated workflows against an append-only World, as a property test of
 * the spec 9 orchestrator: whatever the timing, a run completes, and a cold
 * replay of its committed log decides the same way without running a step
 * again.
 *
 * Every step of a generated workflow has its own name, so two chains that
 * draw each other's correlation ids (a step outcome taken in out of slot
 * order) are a replay divergence rather than a silent swap. Each seed fixes
 * the workflow and the World's timing: how late a write's answer is, how
 * late the live feed's push is, how many steps run inline, how deep
 * run-ahead goes, whether deliveries coalesce.
 *
 * The default seeds are a small fixed smoke set (see `DEFAULT_SEEDS`).
 * `WORKFLOW_FUZZ_SEEDS=1-400` runs a range, about a second a seed, and a
 * scheduled workflow runs a new range every night.
 */
import type { Event } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  dehydrateStepReturnValue,
  hydrateRunError,
} from '../../serialization.js';
import {
  AppendOnlyWorld,
  type HeldMessage,
} from '../../test-support/append-only-world.js';
import {
  dataOf,
  eventsOf,
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

function hash(...parts: unknown[]): number {
  let h = 2166136261;
  for (const c of JSON.stringify(parts)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A deterministic generator: `next(n)` is in `[0, n)`. */
function seeded(seed: number): (n: number) => number {
  // The product is a float, so it is inexact above 2^53 (seeds past a few
  // million, and every configuration seed). It is still the same on every
  // machine, which is all a seed has to be: do not "fix" it, or every seed
  // generates a different run than it did.
  let s = (seed * 2654435761) >>> 0 || 1;
  return (n) => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s % n;
  };
}

/** One of `values`, as the generator picks it. */
const pick = <T>(values: readonly T[], next: (n: number) => number): T =>
  values[next(values.length)] as T;

const MAX_CHAINS = 5;
const MAX_POSITIONS = 14;
let currentSeed = 0;
/** One step in `slowEvery` takes 15 to 60 ms; the rest under 6 ms. */
let slowEvery = 4;
for (let chain = 0; chain < MAX_CHAINS; chain++) {
  for (let position = 0; position < MAX_POSITIONS; position++) {
    for (const branch of ['a', 'b']) {
      const name = `gw_${chain}_${position}_${branch}`;
      registerStepFunction(name, async () => {
        const h = hash(currentSeed, name);
        const ms = h % slowEvery === 0 ? 15 + (h % 45) : h % 6;
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
        return name;
      });
    }
  }
}

/** The statements of one position of a chain (see {@link generate}). */
function positionLines(
  seed: number,
  chain: number,
  position: number,
  next: (n: number) => number,
  hooks: { count: number }
): string[] {
  const a = `S("gw_${chain}_${position}_a")()`;
  const b = `S("gw_${chain}_${position}_b")()`;
  const kind = next(20);
  if (kind < 12) return [`out.push(await ${a});`];
  if (kind < 15) return [`out.push(...(await Promise.all([${a}, ${b}])));`];
  if (kind < 17) {
    return [`await sleep("${5 + next(40)}ms");`, `out.push(await ${a});`];
  }
  if (kind < 18) {
    return [
      `out.push(await Promise.race([${a}, sleep("${5 + next(30)}ms").then(() => "slept")]));`,
    ];
  }
  if (kind < 19 && hooks.count < 2) {
    const token = `gw-hook-${seed}-${hooks.count++}`;
    return [
      `{ const h = createHook({ token: "${token}" }); const got = await Promise.race([h.then((v) => v.tag), sleep("${20 + next(60)}ms").then(() => "timeout")]); h.dispose(); out.push(got); }`,
      `out.push(await ${a});`,
    ];
  }
  return [`out.push(await ${a});`, `out.push(await ${b});`];
}

/**
 * A workflow of two to five concurrent chains. Each position of a chain is
 * a step, two parallel steps, a sleep then a step, a step raced against a
 * sleep, a hook raced against a sleep, or two steps in a row.
 */
function generate(seed: number): string {
  const next = seeded(seed);
  const chains = 2 + next(MAX_CHAINS - 1);
  const hooks = { count: 0 };
  const bodies: string[] = [];
  for (let chain = 0; chain < chains; chain++) {
    const length = 3 + next(MAX_POSITIONS - 3);
    const lines = ['const out = [];'];
    for (let position = 0; position < length; position++) {
      lines.push(...positionLines(seed, chain, position, next, hooks));
    }
    lines.push('return out;');
    bodies.push(`(async () => { ${lines.join(' ')} })()`);
  }
  return `const S = globalThis[Symbol.for("WORKFLOW_USE_STEP")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  async function workflow() {
    return await Promise.all([${bodies.join(',\n')}]);
  }${registerWorkflow()}`;
}

const isTerminal = (world: AppendOnlyWorld) =>
  world.events.some(
    (event) =>
      event.eventType === 'run_completed' || event.eventType === 'run_failed'
  );

/** The run's failure, as `CODE: message`, or `undefined`. */
async function failureOf(world: AppendOnlyWorld): Promise<string | undefined> {
  const failed = eventsOf(world, 'run_failed')[0];
  if (!failed) return undefined;
  const error = await hydrateRunError(
    dataOf(failed)?.error as Uint8Array,
    failed.runId,
    undefined,
    [],
    globalThis
  ).catch((reason: unknown) => reason);
  const message = String((error as Error | undefined)?.message ?? error);
  return `${String(dataOf(failed)?.errorCode)}: ${message.slice(0, 400)}`;
}

/**
 * Delivers held messages the way a queue does until the run is terminal or
 * nothing is left: step messages concurrently, one orchestrator delivery of
 * the run at a time (a message that comes due while one runs is coalesced
 * into it where the World coalesces, and waits for it otherwise), and a
 * delayed message no earlier than its delay. Delays are shortened to a
 * tenth, which is still longer than any sleep a generated workflow takes: a
 * queue never delivers a timer before its wait is due.
 */
async function pump(world: AppendOnlyWorld, seed: number, budgetMs: number) {
  const inFlight = new Set<Promise<unknown>>();
  const dueAt = new Map<HeldMessage, number>();
  const deadline = Date.now() + budgetMs;
  let orchestratorActive = false;
  let sent = 0;
  const deliver = (held: HeldMessage, orchestrator: boolean): void => {
    world.held.splice(world.held.indexOf(held), 1);
    if (orchestrator) orchestratorActive = true;
    const jitterMs = hash(seed, 'deliver', sent++) % 6;
    const delivery = new Promise((resolve) => setTimeout(resolve, jitterMs))
      .then(() => world.deliver(held))
      .catch(() => undefined)
      .finally(() => {
        if (orchestrator) orchestratorActive = false;
        inFlight.delete(delivery);
      });
    inFlight.add(delivery);
  };
  while (Date.now() < deadline) {
    const now = Date.now();
    for (const held of [...world.held]) {
      if (held.dueAtMs !== undefined && !dueAt.has(held)) {
        dueAt.set(held, now + Math.max(0, held.dueAtMs - now) / 10);
      }
      if ((dueAt.get(held) ?? 0) > now) continue;
      const orchestrator =
        (held.message as { stepId?: string }).stepId === undefined;
      if (orchestrator && orchestratorActive) world.comeDue(held);
      else deliver(held, orchestrator);
    }
    if (inFlight.size === 0 && (isTerminal(world) || world.held.length === 0)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * A smoke set, not the regression guard. These seeds failed without the
 * placement fixes on the machine that found them (a replay divergence, a
 * log reported as holding a hole, a run that never completed). But a seed
 * fixes only the workflow and its delays, and the delays run on real timers:
 * which interleaving a seed produces depends on the machine, and elsewhere
 * most of them pass with or without the fixes.
 *
 * The rules are pinned by tests whose order is fixed
 * (`in-band-writer.test.ts`, `speculative-placement.test.ts`,
 * `run-ahead-placement.runtime.test.ts`). What this suite checks is a
 * range: the "Spec 9 Generated Workflows Fuzz" workflow runs a new one every
 * night, and `WORKFLOW_FUZZ_SEEDS` runs one locally.
 */
const DEFAULT_SEEDS = [251, 370, 393, 602, 713, 789, 977, 1036];

function seedsToRun(): number[] {
  const range = process.env.WORKFLOW_FUZZ_SEEDS?.match(/^(\d+)-(\d+)$/);
  if (!range) return DEFAULT_SEEDS;
  const from = Number(range[1]);
  const to = Number(range[2]);
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
}

beforeEach(() => {
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  vi.stubEnv('VERCEL_URL', 'generated.example.test');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setWorld(undefined);
});

describe('generated workflows on a single-orchestrator run (node engine)', () => {
  it.each(
    seedsToRun()
  )('seed %i completes, and its log replays the same way from cold', async (seed) => {
    currentSeed = seed;
    const next = seeded(seed ^ 0x5bd1e995);
    const code = generate(seed);
    const maxInline = pick([1, 2, 3, 3, 4], next);
    const runAheadDepth = pick([10, 10, 10, 2, 1], next);
    const subscribe = next(4) !== 0;
    const createDelayMs = pick([0, 2, 8, 20], next);
    const requestDelayMs = pick([1, 6, 15, 30], next);
    slowEvery = pick([2, 4, 8], next);
    const shortDeadline = next(6) === 0;
    const subscribeDelayMs = pick([undefined, undefined, 3, 12, 30], next);
    const coalesce = next(2) === 0;
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', String(maxInline));
    vi.stubEnv('WORKFLOW_RUN_AHEAD_DEPTH', String(runAheadDepth));
    if (shortDeadline) {
      // Past the margin a delivery creates background steps and hands off.
      vi.stubEnv('WORKFLOW_V2_TIMEOUT_MS', String(120 + next(200)));
      vi.stubEnv(
        'WORKFLOW_INLINE_STEP_DEADLINE_MARGIN_MS',
        String(40 + next(120))
      );
    }
    const config = JSON.stringify({
      seed,
      maxInline,
      runAheadDepth,
      subscribe,
      subscribeDelayMs,
      createDelayMs,
      requestDelayMs,
      slowEvery,
      shortDeadline,
      coalesce,
    });

    const { world, runId } = await setupOrchestratorRun(code, [], {
      subscribe,
      ...(subscribeDelayMs !== undefined ? { subscribeDelayMs } : {}),
      createDelayMs,
      coalesce,
      maxCoalescedReruns: 6,
      async beforeCreate(data) {
        const ms =
          hash(
            seed,
            data.eventType,
            (data as { correlationId?: string }).correlationId,
            world.events.length
          ) % requestDelayMs;
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });

    // Two hooks in three are resumed, at a moment the seed fixes.
    const seen = new Set<string>();
    const resumer = setInterval(() => {
      for (const created of eventsOf(world, 'hook_created')) {
        if (seen.has(created.eventId)) continue;
        seen.add(created.eventId);
        if (hash(seed, created.eventId) % 3 === 0) continue;
        setTimeout(
          async () => {
            const disposed = eventsOf(world, 'hook_disposed').some(
              (event) => event.correlationId === created.correlationId
            );
            if (disposed || isTerminal(world)) return;
            world.appendOutOfBand({
              eventType: 'hook_received',
              correlationId: created.correlationId,
              eventData: {
                token: dataOf(created)?.token,
                payload: await dehydrateStepReturnValue(
                  { tag: 'resumed' },
                  runId,
                  undefined
                ),
              },
            } as Partial<Event>);
            world.enqueue(ORCHESTRATOR_QUEUE, { runId });
          },
          hash(seed, created.eventId, 'delay') % 70
        );
      }
    }, 2);
    try {
      await pump(world, seed, 20_000);
    } finally {
      clearInterval(resumer);
    }

    expect(await failureOf(world), `live run, ${config}`).toBeUndefined();
    const completed = world.events.findIndex(
      (event) => event.eventType === 'run_completed'
    );
    expect(completed, `the live run completes, ${config}`).toBeGreaterThan(0);
    const result = await runResult(world);

    // The next delivery of the run, on a World that never saw it.
    const cold = new AppendOnlyWorld();
    const run = await world.asWorld().runs.get(runId);
    cold.seedLog(
      { ...run, status: 'running' },
      world.events.slice(0, completed)
    );
    setWorld(cold.asWorld());
    await workflowEntrypoint(code)(new Request('https://example.test'));
    cold.enqueue(ORCHESTRATOR_QUEUE, { runId });
    await pump(cold, seed + 1, 10_000);

    expect(await failureOf(cold), `cold replay, ${config}`).toBeUndefined();
    expect(await runResult(cold), `cold replay, ${config}`).toEqual(result);
    // Every outcome is in the log: the replay runs no step again.
    expect(eventsOf(cold, 'step_started')).toHaveLength(
      eventsOf(world, 'step_started').length
    );
  }, 60_000);
});
