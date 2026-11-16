/**
 * A spec 9 fan-out on world-local, end to end: each background step's outcome
 * sends the run's orchestrator a wake, and the wakes that queue behind the
 * run's running delivery are coalesced into it (a re-run of that delivery)
 * instead of each being delivered in turn.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowInvokePayload,
  type World,
} from '@workflow/world';
import { createWorld, type LocalWorld } from '@workflow/world-local';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

const STEP_NAME = 'coalesceSlowAdd';
registerStepFunction(STEP_NAME, async (i: number) => {
  // Staggered, so the outcomes' wakes land while the orchestrator runs.
  await new Promise((resolve) => setTimeout(resolve, 20 + i * 5));
  return i;
});

const BRANCHES = 12;
const WORKFLOW_CODE = `
  const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")](${JSON.stringify(STEP_NAME)});
  async function workflow() {
    const values = await Promise.all(
      Array.from({ length: ${BRANCHES} }, (_, i) => add(i))
    );
    return values.reduce((sum, value) => sum + value, 0);
  }
  ;globalThis.__private_workflows = new Map();
  globalThis.__private_workflows.set("workflow", workflow);`;

describe('coalescing a spec 9 fan-out’s wakes on world-local', () => {
  let dataDir: string;
  let world: LocalWorld | undefined;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'wf-local-coalesce-'));
    // Every step runs from its own message, so each outcome sends a wake.
    vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '0');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    setWorld(undefined);
    await world?.close();
    world = undefined;
    await rm(dataDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  });

  it('delivers fewer orchestrator messages than the wakes it was sent, and completes', async () => {
    const local = createWorld({ dataDir });
    world = local;
    const entrypoint = workflowEntrypoint(WORKFLOW_CODE);
    /** Orchestrator deliveries that reached the handler, by message id. */
    const delivered = new Map<string, number[]>();
    local.registerHandler('__wkf_workflow_', async (request) => {
      const body = (await request.clone().json()) as WorkflowInvokePayload;
      if (body.stepId === undefined) {
        const id = request.headers.get('x-vqs-message-id') ?? '';
        const count = Number(
          request.headers.get('x-vqs-message-delivery-count')
        );
        delivered.set(id, [...(delivered.get(id) ?? []), count]);
      }
      return entrypoint(request);
    });
    /** Orchestrator wakes the run's step outcomes sent. */
    let wakes = 0;
    const queue = local.queue.bind(local);
    local.queue = ((queueName, payload, opts) => {
      const message = payload as WorkflowInvokePayload;
      if (
        queueName.startsWith('__wkf_workflow_') &&
        message.stepId === undefined &&
        !message.waitContinuation
      ) {
        wakes++;
      }
      return queue(queueName, payload, opts);
    }) as typeof local.queue;
    setWorld(local as unknown as World);
    await local.start();
    const created = await local.events.create(null, {
      eventType: 'run_created',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
      eventData: {
        deploymentId: 'dpl_local_coalesce',
        workflowName: 'workflow',
        input: await dehydrateWorkflowArguments([], 'wrun_', undefined, []),
      },
    });
    const runId = created.run?.runId as string;
    await queue('__wkf_workflow_workflow', {
      runId,
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    await vi.waitFor(
      async () => {
        const run = await local.runs.get(runId);
        expect(run.status).toBe('completed');
      },
      { timeout: 30_000, interval: 50 }
    );
    expect((await local.runs.get(runId)).output).toBeDefined();
    // Let every wake still queued be delivered (or coalesced) before counting.
    let settled = -1;
    while (settled !== delivered.size) {
      settled = delivered.size;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // One wake per background step's outcome.
    expect(wakes).toBeGreaterThanOrEqual(BRANCHES);
    // Without coalescing every wake is its own delivery (wakes + the start).
    expect(delivered.size).toBeLessThan(wakes + 1);
    // Some delivery covered queued wakes with a re-run: the same message,
    // delivered again with the next delivery count.
    const reruns = [...delivered.values()].filter(
      (counts) => counts.length > 1
    );
    expect(reruns.length).toBeGreaterThan(0);
    for (const counts of reruns) {
      expect(counts).toEqual(counts.map((_, i) => counts[0]! + i));
    }
  }, 60_000);
});
