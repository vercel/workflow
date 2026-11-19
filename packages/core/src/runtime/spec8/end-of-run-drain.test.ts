import type { WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dehydrateWorkflowArguments } from '../../serialization.js';
import { runWorkflow } from '../../workflow.js';
import { getWorld, setWorld } from '../world.js';
import { SPEC8_EVENT_SPEC_VERSION } from './constants.js';
import { pendingQueueDrain } from './suspension-handler.js';

const noEncryptionKey = undefined;
const getWorkflowTransformCode = (workflowName: string) =>
  `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;

describe('spec 8 end-of-run drain gates writes on the turbo runReadyBarrier', () => {
  // A workflow that creates a fire-and-forget hook and then returns
  // synchronously never suspends, so its `hook_created` event is committed by
  // the end-of-run drain inside runWorkflow — *before* the runtime's terminal
  // `awaitRunReady()`. In turbo (`run_started` backgrounded), that write must
  // still be ordered after the run exists, so runWorkflow threads the barrier
  // into the drain. These tests pin that gating.
  const FIRE_AND_FORGET_HOOK = `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    async function workflow() {
      createHook({ token: 'fire-and-forget' });
      return 'done';
    }`;

  // `void sleep(...)` is the wait equivalent: it enqueues a wait_created the
  // workflow never awaits, drained the same way as the hook above.
  const FIRE_AND_FORGET_WAIT = `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
    async function workflow() {
      void sleep('1d');
      return 'done';
    }`;

  async function makeRun(): Promise<WorkflowRun> {
    const ops: Promise<any>[] = [];
    return {
      runId: 'wrun_drain_turbo',
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments(
        [],
        'wrun_drain_turbo',
        noEncryptionKey,
        ops
      ),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
  }

  afterEach(() => {
    setWorld(undefined);
  });

  it('does not write hook_created until the runReadyBarrier resolves', async () => {
    let releaseBarrier: () => void = () => {};
    const runReadyBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const create = vi.fn(async () => ({
      event: { eventType: 'hook_created' as const },
    }));
    setWorld({
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      events: { create },
      streams: { write: vi.fn(), close: vi.fn() },
    } as any);

    const runPromise = runWorkflow(
      `${FIRE_AND_FORGET_HOOK}${getWorkflowTransformCode('workflow')}`,
      await makeRun(),
      [],
      noEncryptionKey,
      undefined,
      pendingQueueDrain(await getWorld(), runReadyBarrier)
    ).then(() => 'completed' as const);

    // The body returns synchronously, but the drain's hook_created write — and
    // therefore runWorkflow's own completion — must stay blocked behind the
    // still-pending backgrounded run_started. A fixed-time race (not a fixed
    // wait-then-assert) makes this robust to VM setup latency: the window only
    // has to exceed the drain's own work, never a calibrated guess at it.
    const winner = await Promise.race([
      runPromise,
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), 250)
      ),
    ]);
    expect(winner).toBe('pending');
    expect(create).not.toHaveBeenCalled();

    // Once run_started lands, the drain proceeds and runWorkflow resolves.
    releaseBarrier();
    expect(await runPromise).toBe('completed');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toMatchObject({
      eventType: 'hook_created',
    });
  });

  it('does not write wait_created until the runReadyBarrier resolves', async () => {
    let releaseBarrier: () => void = () => {};
    const runReadyBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const create = vi.fn(async () => ({
      event: { eventType: 'wait_created' as const },
    }));
    setWorld({
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      events: { create },
      streams: { write: vi.fn(), close: vi.fn() },
    } as any);

    const runPromise = runWorkflow(
      `${FIRE_AND_FORGET_WAIT}${getWorkflowTransformCode('workflow')}`,
      await makeRun(),
      [],
      noEncryptionKey,
      undefined,
      pendingQueueDrain(await getWorld(), runReadyBarrier)
    ).then(() => 'completed' as const);

    // Same gating as the hook case: a fire-and-forget wait drained at
    // completion must not write wait_created before the backgrounded
    // run_started lands.
    const winner = await Promise.race([
      runPromise,
      new Promise<'pending'>((resolve) =>
        setTimeout(() => resolve('pending'), 250)
      ),
    ]);
    expect(winner).toBe('pending');
    expect(create).not.toHaveBeenCalled();

    releaseBarrier();
    expect(await runPromise).toBe('completed');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toMatchObject({
      eventType: 'wait_created',
    });
  });

  it('still writes hook_created when the runReadyBarrier rejects (ordering only)', async () => {
    const create = vi.fn(async () => ({
      event: { eventType: 'hook_created' as const },
    }));
    setWorld({
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      events: { create },
      streams: { write: vi.fn(), close: vi.fn() },
    } as any);

    // A rejected barrier is swallowed for ordering: if run_started truly
    // failed, the run does not exist and the write itself surfaces the error.
    const rejected = Promise.reject(new Error('run_started failed'));
    rejected.catch(() => {});

    await runWorkflow(
      `${FIRE_AND_FORGET_HOOK}${getWorkflowTransformCode('workflow')}`,
      await makeRun(),
      [],
      noEncryptionKey,
      undefined,
      pendingQueueDrain(await getWorld(), rejected)
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1]).toMatchObject({
      eventType: 'hook_created',
    });
  });

  it('writes hook_created without blocking when no barrier (non-turbo)', async () => {
    const create = vi.fn(async () => ({
      event: { eventType: 'hook_created' as const },
    }));
    setWorld({
      specVersion: SPEC8_EVENT_SPEC_VERSION,
      events: { create },
      streams: { write: vi.fn(), close: vi.fn() },
    } as any);

    // No barrier (the await path already awaited run_started up front): the
    // drain writes immediately.
    await runWorkflow(
      `${FIRE_AND_FORGET_HOOK}${getWorkflowTransformCode('workflow')}`,
      await makeRun(),
      [],
      noEncryptionKey,
      undefined,
      pendingQueueDrain(await getWorld())
    );

    expect(create).toHaveBeenCalledTimes(1);
  });
});
