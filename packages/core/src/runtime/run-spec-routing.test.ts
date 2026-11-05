import { WorkflowRunNotFoundError } from '@workflow/errors';
import {
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
  type WorkflowInvokePayload,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOffToRunOrchestrator } from './delivery.js';
import { resolveRunSpec } from './run-spec-routing.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

let runCounter = 0;
const freshRunId = () => `wrun_routing_${Date.now()}_${runCounter++}`;

function worldWithRun(specVersion: number) {
  const get = vi.fn(async (runId: string) => ({
    runId,
    specVersion,
    deploymentId: 'dpl_routing',
    status: 'running',
  }));
  const queue = vi.fn(async () => ({ messageId: 'msg_1' }));
  const world = {
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    runs: { get },
    queue,
  } as unknown as World;
  setWorld(world);
  return { world, get, queue };
}

afterEach(() => {
  setWorld(undefined);
});

describe('resolveRunSpec', () => {
  const route = (runId: string, message: Partial<WorkflowInvokePayload>) =>
    resolveRunSpec({ runId, ...message } as WorkflowInvokePayload);

  it('routes a stamped message by its stamp, without reading the run', async () => {
    const { get } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    const stamps: Partial<WorkflowInvokePayload>[] = [
      { runInput: { specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM } },
      { runContext: { specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM } },
      { runSpecVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM },
    ] as Partial<WorkflowInvokePayload>[];
    for (const stamp of stamps) {
      await expect(route(runId, stamp)).resolves.toEqual({
        specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM,
      });
    }
    expect(get).not.toHaveBeenCalled();
  });

  it('prefers a run identity stamp over the hint', async () => {
    worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    const runContext = { specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR };
    await expect(
      route(runId, {
        runContext,
        runSpecVersion: SPEC_VERSION_LEGACY,
      } as Partial<WorkflowInvokePayload>)
    ).resolves.toEqual({ specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR });
  });

  it('reads the run once per unstamped message, and hands the run on', async () => {
    const { get } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    for (let i = 1; i <= 2; i++) {
      const spec = await route(runId, {});
      expect(spec.specVersion).toBe(SPEC_VERSION_SINGLE_ORCHESTRATOR);
      expect(spec.run?.runId).toBe(runId);
      // Nothing is remembered between messages.
      expect(get).toHaveBeenCalledTimes(i);
    }
    // A stamped message after them still reads nothing.
    await route(runId, { runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR });
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('routes a run that records no version as legacy', async () => {
    const { get } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    get.mockResolvedValueOnce({
      runId: 'x',
      deploymentId: 'dpl_routing',
      status: 'running',
    } as never);
    await expect(route(freshRunId(), {})).resolves.toMatchObject({
      specVersion: SPEC_VERSION_LEGACY,
    });
  });

  it("routes a run that cannot be found by the World's own version", async () => {
    const { world, get } = worldWithRun(SPEC_VERSION_LEGACY);
    get.mockRejectedValueOnce(new WorkflowRunNotFoundError('wrun_missing'));
    await expect(route(freshRunId(), {})).resolves.toEqual({
      specVersion: world.specVersion,
    });
  });
});

describe('handOffToRunOrchestrator', () => {
  const metadata = { queueName: '__wkf_workflow_w' } as never;
  const run = (specVersion: number, runId: string) =>
    ({
      runId,
      specVersion,
      deploymentId: 'dpl_routing',
      status: 'running',
    }) as WorkflowRun;

  it('re-sends a misrouted message with its run version', async () => {
    const { world, queue } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    const message = {
      runId,
      runSpecVersion: SPEC_VERSION_LEGACY,
    } as WorkflowInvokePayload;
    // A wrong hint routes the first delivery to the spec 8 orchestrator...
    expect((await resolveRunSpec(message)).specVersion).toBe(
      SPEC_VERSION_LEGACY
    );
    // ...which hands it on once it loads the run.
    await expect(
      handOffToRunOrchestrator({
        world,
        message,
        metadata,
        run: run(SPEC_VERSION_SINGLE_ORCHESTRATOR, runId),
        singleOrchestrator: false,
      })
    ).resolves.toBe(true);
    expect(queue).toHaveBeenCalledTimes(1);
    const [queueName, sent, opts] = queue.mock.calls[0] as unknown as [
      string,
      WorkflowInvokePayload,
      { deploymentId: string; specVersion: number },
    ];
    expect(queueName).toBe('__wkf_workflow_w');
    expect(sent).toMatchObject({
      runId,
      runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    expect(opts).toMatchObject({
      deploymentId: 'dpl_routing',
      specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    });
    // The re-sent message routes to the run's orchestrator.
    expect((await resolveRunSpec(sent)).specVersion).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
  });

  it('leaves a correctly routed message, and a first delivery, alone', async () => {
    const { world, queue } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    await expect(
      handOffToRunOrchestrator({
        world,
        message: { runId } as WorkflowInvokePayload,
        metadata,
        run: run(SPEC_VERSION_SINGLE_ORCHESTRATOR, runId),
        singleOrchestrator: true,
      })
    ).resolves.toBe(false);
    await expect(
      handOffToRunOrchestrator({
        world,
        message: { runId } as WorkflowInvokePayload,
        metadata,
        run: run(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM, runId),
        singleOrchestrator: false,
      })
    ).resolves.toBe(false);
    await expect(
      handOffToRunOrchestrator({
        world,
        message: {
          runId,
          runInput: { specVersion: SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM },
        } as WorkflowInvokePayload,
        metadata,
        run: run(SPEC_VERSION_SINGLE_ORCHESTRATOR, runId),
        singleOrchestrator: false,
      })
    ).resolves.toBe(false);
    await expect(
      handOffToRunOrchestrator({
        world,
        message: { runId } as WorkflowInvokePayload,
        metadata,
        run: { ...run(SPEC_VERSION_LEGACY, runId), specVersion: undefined },
        singleOrchestrator: true,
      })
    ).resolves.toBe(false);
    expect(queue).not.toHaveBeenCalled();
  });
});
