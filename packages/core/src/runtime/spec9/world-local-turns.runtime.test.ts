/**
 * A session-style spec 9 run on world-local: a workflow that loops on a hook
 * and runs one inline step per payload, as a chat agent does per message.
 * Each payload is resumed as soon as the previous turn's step completes (a
 * client sending its next message right away), or after a short pause.
 *
 * The tests check that with world-local's live event feed
 * (`events.subscribe`), a session's next message continues on the retained
 * VM instead of replaying the workflow from the log, whether it arrives after
 * a pause or while the previous turn is finishing. The opt-in
 * benchmark compares turn latency and replays with and without the feed,
 * since a timing is not a pass/fail signal on a shared runner:
 *
 *   WORKFLOW_LOCAL_TURNS_BENCH=1 pnpm vitest run src/runtime/spec9/world-local-turns.runtime.test.ts
 *
 * `WORKFLOW_LOCAL_TURNS_BENCH_TURNS` sets the benchmark's turns (default 100).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SPEC_VERSION_SINGLE_ORCHESTRATOR, type World } from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../../logger.js';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { resumeHook } from '../resume-hook.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const BENCH_TURNS = Number(process.env.WORKFLOW_LOCAL_TURNS_BENCH_TURNS) || 100;
const TOKEN = 'world-local-turns-bench';
// Long enough for the delivery to finish its turn and start lingering, well
// inside the 5 s hook-only linger.
const BENCH_PAUSE_MS = 20;

// The session grows by one message a turn and is passed back in, as a chat
// agent's history is, so a replay costs more as the conversation grows.
registerStepFunction(
  'world_local_turns_reply',
  async (history: string[], message: string) => [
    ...history,
    message,
    `reply to ${message}`,
  ]
);

const code = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const reply = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("world_local_turns_reply");
  async function workflow(turns) {
    const hook = createHook({ token: ${JSON.stringify(TOKEN)} });
    let history = [];
    for await (const message of hook) {
      history = await reply(history, message);
      if (history.length === turns * 2) break;
    }
    return history.length;
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

interface TurnsResult {
  ms: number[];
  replays: number;
  retained: number;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
const median = (values: number[]) => percentile(values, 0.5);

describe('session-style turns on world-local (spec 9, node engine)', () => {
  let dataDir: string | undefined;
  let world: LocalWorld | undefined;

  afterEach(async () => {
    setWorld(undefined);
    await world?.close();
    world = undefined;
    if (dataDir) {
      await rm(dataDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
    vi.restoreAllMocks();
  });

  async function runTurns(
    turns: number,
    liveFeed: boolean,
    pauseMs: number
  ): Promise<TurnsResult> {
    // A dev server's port is found once and cached; with nothing listening
    // here, every replay and step would look it up again (`lsof` on macOS).
    vi.stubEnv('PORT', '3000');
    dataDir = await mkdtemp(join(tmpdir(), 'wf-local-turns-'));
    const local = createWorld({ dataDir });
    world = local;
    if (!liveFeed) delete local.events.subscribe;
    local.registerHandler('__wkf_workflow_', workflowEntrypoint(code));

    // Resolves each turn when its step outcome commits.
    let turnDone: (() => void) | undefined;
    const create = local.events.create.bind(local.events);
    local.events.create = (async (...args: Parameters<typeof create>) => {
      const result = await create(...args);
      if (args[1].eventType === 'step_completed') turnDone?.();
      return result;
    }) as typeof create;
    setWorld(local as unknown as World);
    await local.start();

    const debug = vi.spyOn(runtimeLogger, 'debug');
    debug.mockClear();

    const created = await local.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      eventData: {
        deploymentId: 'dpl_local_turns',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments(
          [turns],
          'wrun_',
          undefined,
          []
        ),
      },
    });
    const runId = created.run?.runId as string;
    await local.queue('__wkf_workflow_workflow', {
      runId,
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    await vi.waitFor(
      async () => {
        const { data } = await local.hooks.list({ runId });
        expect(data).toHaveLength(1);
      },
      { timeout: 10_000, interval: 5 }
    );

    const ms: number[] = [];
    for (let turn = 0; turn < turns; turn++) {
      if (pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
      const done = new Promise<void>((resolve) => {
        turnDone = resolve;
      });
      const startedAt = performance.now();
      await resumeHook(TOKEN, `message ${turn}`);
      await done;
      ms.push(performance.now() - startedAt);
    }
    await vi.waitFor(
      async () => {
        const run = await local.runs.get(runId);
        expect(run.status).toBe('completed');
      },
      { timeout: 30_000, interval: 10 }
    );
    const modes = debug.mock.calls
      .filter(([message]) => message === 'Starting workflow execution')
      .map(([, fields]) => (fields as { executionMode: string }).executionMode);
    return {
      ms,
      replays: modes.filter((mode) => mode === 'replay').length,
      retained: modes.filter((mode) => mode === 'retained').length,
    };
  }

  const report = (label: string, result: TurnsResult) => {
    const { ms } = result;
    const early = median(ms.slice(1, 11));
    const late = median(ms.slice(-10));
    process.stderr.write(
      `[world-local turns] ${label.padEnd(26)} ${ms.length} turns: p50 ${median(ms).toFixed(1)} ms, p95 ${percentile(ms, 0.95).toFixed(1)} ms, turns 2-11 ${early.toFixed(1)} ms, last 10 ${late.toFixed(1)} ms; passes: ${result.replays} replayed, ${result.retained} on the retained VM\n`
    );
  };

  const closeWorld = async () => {
    setWorld(undefined);
    await world?.close();
    world = undefined;
  };

  it('continues a paused session on the retained VM with the live feed', async () => {
    const turns = 10;
    const polling = await runTurns(turns, false, 100);
    await closeWorld();
    const feed = await runTurns(turns, true, 100);
    // Without a feed every message starts a new delivery, which replays.
    expect(polling.replays).toBeGreaterThanOrEqual(turns);
    // With it, only the run's first delivery replays: each message reaches
    // the lingering delivery, which continues on its retained VM.
    expect(feed.replays).toBe(1);
  }, 60_000);

  it('continues back-to-back messages on the retained VM', async () => {
    // Each message lands while the previous turn is finishing, after the VM
    // decided: the extra pass continues on the retained VM, and a message
    // that lands after the delivery suspended reaches it on the feed. The
    // run's first delivery replays; one more is slack for timing, against
    // one replay per message without the retained VM.
    const { replays } = await runTurns(20, true, 0);
    expect(replays).toBeLessThanOrEqual(2);
  }, 60_000);

  it.runIf(process.env.WORKFLOW_LOCAL_TURNS_BENCH === '1')(
    'measures turns with and without the live feed',
    async () => {
      const results: [string, TurnsResult][] = [];
      for (const [label, pauseMs] of [
        ['back-to-back', 0],
        [`${BENCH_PAUSE_MS} ms pause`, BENCH_PAUSE_MS],
      ] as const) {
        for (const liveFeed of [false, true]) {
          results.push([
            `${label}, ${liveFeed ? 'live feed' : 'no feed'}`,
            await runTurns(BENCH_TURNS, liveFeed, pauseMs),
          ]);
          await closeWorld();
        }
      }
      for (const [label, result] of results) report(label, result);
    },
    600_000
  );
});
