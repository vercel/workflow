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
import { rememberRunSpecVersion, resolveRunSpec } from './run-spec-routing.js';
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
  it('lets a later hint replace a wrong one', async () => {
    const { get } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    const route = (message: Partial<WorkflowInvokePayload>) =>
      resolveRunSpec({ runId, ...message } as WorkflowInvokePayload);

    expect(
      (await route({ runSpecVersion: SPEC_VERSION_LEGACY })).specVersion
    ).toBe(SPEC_VERSION_LEGACY);
    expect(
      (await route({ runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR }))
        .specVersion
    ).toBe(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    // The unstamped message after it follows the corrected hint.
    expect((await route({})).specVersion).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    expect(get).not.toHaveBeenCalled();
  });

  it('prefers a version read from the run over any hint', async () => {
    const { get } = worldWithRun(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    const runId = freshRunId();
    const route = (message: Partial<WorkflowInvokePayload>) =>
      resolveRunSpec({ runId, ...message } as WorkflowInvokePayload);

    expect((await route({})).specVersion).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(
      (await route({ runSpecVersion: SPEC_VERSION_LEGACY })).specVersion
    ).toBe(SPEC_VERSION_SINGLE_ORCHESTRATOR);
    expect((await route({})).specVersion).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('never lets a hint replace an authoritative version', () => {
    const runId = freshRunId();
    rememberRunSpecVersion(runId, SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
    rememberRunSpecVersion(runId, SPEC_VERSION_LEGACY, {
      authoritative: false,
    });
    return expect(
      resolveRunSpec({ runId } as WorkflowInvokePayload).then(
        (r) => r.specVersion
      )
    ).resolves.toBe(SPEC_VERSION_SUPPORTS_HOOK_FORCE_CLAIM);
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

  it('re-sends a misrouted message with its run version, and routing then follows the run', async () => {
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
    // The process now routes the run, and the original wrong hint, by it.
    expect((await resolveRunSpec(message)).specVersion).toBe(
      SPEC_VERSION_SINGLE_ORCHESTRATOR
    );
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
