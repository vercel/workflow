/**
 * End-to-end check of the experimental input delta (WORKFLOW_INPUT_DELTA=1) on
 * the spec 8 runtime with world-local: an Eve-shaped session loop (hook
 * delivers a user message, a turn step receives the whole history and returns
 * the messages it appended, the workflow applies them copy-on-write).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '@workflow/world';
import { createWorld as createLocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { resumeHook } from '../resume-hook.js';
import { setWorld } from '../world.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepArguments,
} from '../../serialization.js';
import { SPEC8_EVENT_SPEC_VERSION } from './constants.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

function rnd(seed: number, len: number): string {
  let x = (seed * 2654435761) >>> 0;
  let out = '';
  while (out.length < len) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out += x.toString(36);
  }
  return out.slice(0, len);
}
const seen: unknown[][] = [];
registerStepFunction(
  'idt_turn',
  async (input: { history: unknown[]; message: string; trace: string }) => {
    seen.push(input.history);
    const n = input.history.length;
    return {
      appended: [
        { role: 'user', content: input.message },
        {
          role: 'assistant',
          content: rnd(n + 7, 3000),
          tool: {
            results: Array.from({ length: 5 }, (_, i) =>
              rnd(n * 10 + i + 100, 1500)
            ),
          },
        },
      ],
      trace: input.trace + rnd(n + 500, 400),
    };
  }
);

const TURNS = 12;
const code = `
  var useStep = globalThis[Symbol.for('WORKFLOW_USE_STEP')];
  var createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
  var turn = useStep('idt_turn');
  async function workflow() {
    var hook = createHook({ token: 'idt-inbox' });
    var history = [];
    var trace = '';
    for (var i = 0; i < ${TURNS}; i++) {
      var delivery = await hook;
      var out = await turn({ history: history, message: delivery.message, trace: trace });
      history = history.concat(out.appended);
      trace = out.trace;
    }
    return history.length;
  }
  globalThis.__private_workflows = new Map([['workflow', workflow]]);
`;

interface Held {
  queueName: string;
  message: unknown;
}

async function drive(maxInline: string) {
  vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', maxInline);
  const dir = await mkdtemp(join(tmpdir(), 'input-delta-'));
  const local = createLocalWorld({ dataDir: dir });
  const held: Held[] = [];
  let handler:
    | ((m: unknown, meta: Record<string, unknown>) => Promise<unknown>)
    | undefined;
  let n = 0;
  const counts = { stepsGet: 0 };
  const world = {
    ...local,
    steps: {
      ...local.steps,
      get: (...args: Parameters<typeof local.steps.get>) => {
        counts.stepsGet++;
        return (local.steps.get as any)(...args);
      },
    },
    async queue(queueName: string, message: unknown) {
      held.push({ queueName, message });
      return { messageId: `msg_${++n}` };
    },
    createQueueHandler(_prefix: string, h: typeof handler) {
      handler = h;
      return async () => new Response(null, { status: 204 });
    },
  } as unknown as World;
  setWorld(world);
  await workflowEntrypoint(code)(new Request('https://example.test'));
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC8_EVENT_SPEC_VERSION,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'workflow',
      input: await dehydrateWorkflowArguments([], 'run', undefined, []),
    },
  } as any);
  const runId = created.run!.runId;
  await world.queue('__wkf_workflow_workflow', {
    runId,
    requestedAt: new Date(),
  } as any);
  let deliveries = 0;
  const pump = async () => {
    while (held.length) {
      const next = held.shift()!;
      deliveries++;
      if (deliveries > 500) throw new Error('runaway');
      await handler!(next.message, {
        attempt: 1,
        deliveryCount: 1,
        createdAt: new Date(),
        messageId: `m${deliveries}`,
        queueName: next.queueName,
        requestId: `req_${deliveries}`,
      });
    }
  };
  await pump();
  for (let i = 0; i < TURNS; i++) {
    await resumeHook('idt-inbox', { message: `question ${i}` });
    await pump();
  }
  const run = await world.runs.get(runId);
  const events = (
    await world.events.list({
      runId,
      pagination: { sortOrder: 'asc', limit: 1000 },
    })
  ).data;
  return { world, run, events, dir, stepsGetDuringRun: counts.stepsGet };
}

describe.each([
  '20',
  '0',
])('input delta end to end (WORKFLOW_MAX_INLINE_STEPS=%s)', (maxInline) => {
  let dir: string | undefined;
  beforeEach(() => {
    seen.length = 0;
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    setWorld(undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it.each([
    '0',
    '1',
  ])('WORKFLOW_INPUT_DELTA=%s completes with identical step inputs', async (flag) => {
    vi.stubEnv('WORKFLOW_INPUT_DELTA', flag);
    const result = await drive(maxInline);
    dir = result.dir;
    expect(result.run.status).toBe('completed');
    expect(seen).toHaveLength(TURNS);
    seen.forEach((history, i) => expect(history).toHaveLength(2 * i));
    // Every step's persisted input decodes (cold, from storage) to the
    // arguments the step actually received.
    const inputs = result.events.filter(
      (e) =>
        (e.eventType === 'step_created' || e.eventType === 'step_started') &&
        (e as any).eventData?.input
    );
    expect(inputs.length).toBe(TURNS);
    const sizes: number[] = [];
    let deltas = 0;
    const map = (globalThis as any)[
      Symbol.for('__workflowInputDeltaFullPayloads/v1')
    ] as Map<string, Uint8Array> | undefined;
    map?.clear();
    for (const [i, e] of inputs.entries()) {
      const input = (e as any).eventData.input as Uint8Array;
      sizes.push(input.byteLength);
      const stats = { memoryHits: 0, recoveryFetches: 0, patchesApplied: 0 };
      const value = await hydrateStepArguments(
        input,
        result.run.runId,
        undefined,
        [],
        globalThis,
        {},
        undefined,
        undefined,
        undefined,
        { world: result.world, stats }
      );
      expect(value.args[0].history).toStrictEqual(seen[i]);
      if (stats.recoveryFetches > 0) deltas++;
    }
    if (flag === '1' && maxInline !== '0') {
      // Inline steps hydrate from this process's memory: no recovery reads.
      expect(result.stepsGetDuringRun).toBe(0);
    }
    if (flag === '0') expect(deltas).toBe(0);
    if (flag === '1') {
      // Once the history outweighs one turn's additions, inputs become deltas
      // and stay roughly one turn in size while the history keeps growing.
      expect(deltas).toBeGreaterThanOrEqual(TURNS - 4);
      const last = sizes.at(-1)!;
      expect(last).toBeLessThan(20_000);
    }
    console.log(
      `maxInline=${maxInline} delta=${flag} input bytes`,
      sizes.join(',')
    );
  }, 60_000);
});
