import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../../private.js';
import { workflowEntrypoint } from '../../runtime.js';
import {
  eventsOf,
  registerWorkflow,
  runResult,
  setupOrchestratorRun,
} from '../../test-support/orchestrator-harness.js';
import { setWorld } from '../world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

let executed = 0;
registerStepFunction('startup_retry_step', async () => ++executed);
const code = `const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("startup_retry_step");
async function workflow() { return await step(); }${registerWorkflow()}`;

beforeEach(() => {
  executed = 0;
  vi.stubEnv('WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS', '0');
});
afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

describe.each([
  'node',
  'quickjs',
] as const)('startup history retry (%s engine)', (engine) => {
  it.each([
    'http',
    'typed',
  ] as const)('recovers a %s not-found in the same delivery, using the loaded fence', async (kind) => {
    let reads = 0;
    const { world, start } = await setupOrchestratorRun(
      code,
      [],
      {
        beforeList: () => {
          if (++reads === 1) {
            throw kind === 'http'
              ? new WorkflowWorldError('Run not found', { status: 404 })
              : new WorkflowRunNotFoundError('startup');
          }
        },
      },
      engine
    );
    await world.deliver(start);
    await world.runUntilIdle();

    expect(await runResult(world)).toBe(1);
    expect(executed).toBe(1);
    expect(world.deliveries).toHaveLength(1);
    expect(reads).toBeGreaterThanOrEqual(2);
    // The seeded run_created occupies slot 1. An invented empty fence
    // would be refused by this World's in-band writer.
    expect(world.creates[0]?.params?.eventCount).toBe(1);
    expect(eventsOf(world, 'run_started')).toHaveLength(1);
  });

  it('bounds a persistent not-found to one reload before redelivery', async () => {
    let reads = 0;
    const { world, start } = await setupOrchestratorRun(
      code,
      [],
      {
        beforeList: () => {
          reads++;
          throw new WorkflowWorldError('Run not found', { status: 404 });
        },
      },
      engine
    );
    await expect(world.deliver(start)).rejects.toMatchObject({ status: 404 });
    expect(reads).toBe(2);
    expect(world.held).toContainEqual(
      expect.objectContaining({ deliveryCount: 2 })
    );
    expect(world.creates).toHaveLength(0);
    expect(executed).toBe(0);
  });

  it('does not retry authorization failures', async () => {
    let reads = 0;
    const { world, start } = await setupOrchestratorRun(
      code,
      [],
      {
        beforeList: () => {
          reads++;
          throw new WorkflowWorldError('Forbidden', { status: 403 });
        },
      },
      engine
    );
    await expect(world.deliver(start)).rejects.toMatchObject({ status: 403 });
    expect(reads).toBe(1);
    expect(executed).toBe(0);
  });

  it('does not reload history when the run lookup also fails', async () => {
    let reads = 0;
    const { world, start, runId } = await setupOrchestratorRun(
      code,
      [],
      {
        beforeList: () => {
          reads++;
          throw new WorkflowWorldError('Run not found', { status: 404 });
        },
      },
      engine
    );
    const missing = new WorkflowRunNotFoundError(runId);
    const api = world.asWorld();
    api.runs.get = vi.fn().mockRejectedValue(missing);
    setWorld(api);
    await workflowEntrypoint(code)(new Request('https://example.test'));

    await expect(world.deliver(start)).rejects.toBe(missing);
    expect(reads).toBe(1);
    expect(world.creates).toHaveLength(0);
    expect(executed).toBe(0);
  });

  it('refuses a recovered history without a fence snapshot', async () => {
    const { world, start } = await setupOrchestratorRun(code, [], {}, engine);
    const api = world.asWorld();
    const list = api.events.list.bind(api.events);
    let reads = 0;
    api.events.list = async (params) => {
      if (++reads === 1) {
        throw new WorkflowWorldError('Run not found', { status: 404 });
      }
      return { ...(await list(params)), snapshot: undefined };
    };
    setWorld(api);
    await workflowEntrypoint(code)(new Request('https://example.test'));

    await world.deliver(start);
    expect(reads).toBe(2);
    expect(eventsOf(world, 'run_failed')).toHaveLength(1);
    expect(eventsOf(world, 'run_started')).toHaveLength(0);
    expect(executed).toBe(0);
  });
});
