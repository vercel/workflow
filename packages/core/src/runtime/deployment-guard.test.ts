import {
  RUN_ERROR_CODES,
  WorkflowDeploymentMismatchError,
} from '@workflow/errors';
import type { WorkflowRun, World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hydrateRunError } from '../serialization.js';
import { guardDeploymentAffinity } from './deployment-guard.js';

const run = {
  runId: 'wrun_test',
  deploymentId: 'dpl_pinned',
  specVersion: 5,
} satisfies Pick<WorkflowRun, 'runId' | 'deploymentId' | 'specVersion'>;

function createWorld(currentDeploymentId: string) {
  const eventsCreate = vi.fn().mockResolvedValue({ event: {} });
  const getEncryptionKeyForRun = vi.fn().mockResolvedValue(undefined);
  const world = {
    // Declares atomic, immutable deployments (as world-vercel does). Worlds
    // that leave it unset (local/postgres) skip the guard entirely.
    capabilities: { deploymentAffinity: true },
    getDeploymentId: vi.fn().mockResolvedValue(currentDeploymentId),
    getEncryptionKeyForRun,
    events: { create: eventsCreate },
  } as unknown as World;
  return { world, eventsCreate, getEncryptionKeyForRun };
}

/** Reads back the persisted `run_failed` payload as a live error. */
async function hydrateFailure(eventsCreate: ReturnType<typeof vi.fn>) {
  const failedEvent = eventsCreate.mock.calls[0][1];
  expect(failedEvent.eventType).toBe('run_failed');
  expect(failedEvent.eventData.errorCode).toBe(
    RUN_ERROR_CODES.DEPLOYMENT_MISMATCH
  );
  return await hydrateRunError(
    failedEvent.eventData.error,
    'wrun_test',
    undefined
  );
}

afterEach(() => {
  delete process.env.WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES;
});

describe('guardDeploymentAffinity', () => {
  it('continues when the run is pinned to the current deployment', async () => {
    const { world, eventsCreate, getEncryptionKeyForRun } =
      createWorld('dpl_pinned');
    const reenqueue = vi.fn();

    await expect(
      guardDeploymentAffinity({ world, run, reenqueue })
    ).resolves.toMatchObject({ outcome: 'continue' });
    expect(reenqueue).not.toHaveBeenCalled();
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
  });

  it('skips worlds that do not declare deploymentAffinity', async () => {
    const { world, eventsCreate } = createWorld('dpl_current');
    (world as { capabilities?: unknown }).capabilities = {};
    const reenqueue = vi.fn();

    await expect(
      guardDeploymentAffinity({ world, run, reenqueue })
    ).resolves.toMatchObject({ outcome: 'continue' });
    expect(reenqueue).not.toHaveBeenCalled();
    expect(eventsCreate).not.toHaveBeenCalled();
  });

  it('re-routes a misrouted delivery to the deployment the run is pinned to', async () => {
    const { world, eventsCreate } = createWorld('dpl_current');
    const reenqueue = vi.fn();

    await expect(
      guardDeploymentAffinity({ world, run, reenqueue, requestId: 'req_test' })
    ).resolves.toMatchObject({ outcome: 'rerouted' });

    expect(reenqueue).toHaveBeenCalledWith({
      deploymentId: 'dpl_pinned',
      specVersion: 5,
      deploymentMismatchRetryCount: 1,
      delaySeconds: 1,
    });
    expect(eventsCreate).not.toHaveBeenCalled();
  });

  it('increments the count and backs off exponentially across attempts', async () => {
    const sent: { count: number; delay: number }[] = [];
    for (const retryCount of [0, 1, 2]) {
      const { world } = createWorld('dpl_current');
      await expect(
        guardDeploymentAffinity({
          world,
          run,
          retryCount,
          reenqueue: async ({ deploymentMismatchRetryCount, delaySeconds }) => {
            sent.push({
              count: deploymentMismatchRetryCount,
              delay: delaySeconds,
            });
          },
        })
      ).resolves.toMatchObject({ outcome: 'rerouted' });
    }
    expect(sent).toEqual([
      { count: 1, delay: 1 },
      { count: 2, delay: 2 },
      { count: 3, delay: 4 },
    ]);
  });

  it('fails the run once the re-route budget is spent', async () => {
    const { world, eventsCreate, getEncryptionKeyForRun } =
      createWorld('dpl_current');
    const reenqueue = vi.fn();

    // Default budget is 3, so a message arriving with 3 attempts is out.
    await expect(
      guardDeploymentAffinity({
        world,
        run,
        retryCount: 3,
        reenqueue,
        requestId: 'req_test',
      })
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(reenqueue).not.toHaveBeenCalled();

    // The failure must be recordable without the pinned deployment's key,
    // which is often gone once a run outlives its deployment.
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(eventsCreate).toHaveBeenCalledWith(
      'wrun_test',
      expect.objectContaining({
        eventType: 'run_failed',
        eventData: expect.objectContaining({
          errorCode: RUN_ERROR_CODES.DEPLOYMENT_MISMATCH,
        }),
      }),
      { requestId: 'req_test' }
    );

    const error = await hydrateFailure(eventsCreate);
    expect(WorkflowDeploymentMismatchError.is(error)).toBe(true);
    expect((error as Error).message).toContain(
      'is pinned to deployment "dpl_pinned", but was received by deployment "dpl_current"'
    );
    expect((error as Error).message).toContain(
      're-routed the message to "dpl_pinned" 3 times'
    );
    expect((error as Error).message).toContain(
      "Verify that the run's deployment is still available"
    );
    // Carries the docs link built from the DEPLOYMENT_MISMATCH slug.
    expect((error as Error).message).toContain('/err/deployment-mismatch');
  });

  it('fails immediately when the World confirms the pinned deployment is unavailable', async () => {
    // Deleted or aged-out deployment: the pinned target is unroutable.
    const { world, eventsCreate } = createWorld('dpl_current');
    const enqueueError = new Error('deployment not found');
    const reenqueue = vi.fn().mockRejectedValue(enqueueError);

    await expect(
      guardDeploymentAffinity({
        world,
        run,
        reenqueue,
        isDeploymentUnavailableError: (error) => error === enqueueError,
      })
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(reenqueue).toHaveBeenCalledTimes(1);

    const error = await hydrateFailure(eventsCreate);
    expect(WorkflowDeploymentMismatchError.is(error)).toBe(true);
    // No re-route succeeded, so the message must not claim any.
    expect((error as Error).message).not.toContain('re-routed the message');
  });

  it('rethrows an unclassified re-enqueue failure for queue redelivery', async () => {
    const { world, eventsCreate } = createWorld('dpl_current');
    const enqueueError = new Error('transient VQS failure');
    const reenqueue = vi.fn().mockRejectedValue(enqueueError);

    await expect(
      guardDeploymentAffinity({
        world,
        run,
        reenqueue,
        isDeploymentUnavailableError: () => false,
      })
    ).rejects.toBe(enqueueError);
    expect(reenqueue).toHaveBeenCalledTimes(1);
    expect(eventsCreate).not.toHaveBeenCalled();
  });

  it('fails fast when no re-enqueue is possible', async () => {
    const { world, eventsCreate } = createWorld('dpl_current');

    await expect(
      guardDeploymentAffinity({ world, run })
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(eventsCreate).toHaveBeenCalledTimes(1);
  });

  it('honours WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES=0 as fail-fast', async () => {
    process.env.WORKFLOW_DEPLOYMENT_MISMATCH_MAX_RETRIES = '0';
    const { world, eventsCreate } = createWorld('dpl_current');
    const reenqueue = vi.fn();

    await expect(
      guardDeploymentAffinity({ world, run, reenqueue })
    ).resolves.toMatchObject({ outcome: 'failed' });
    expect(reenqueue).not.toHaveBeenCalled();
    expect(eventsCreate).toHaveBeenCalledTimes(1);
  });

  it('awaits the ordering barrier before stopping, on both outcomes', async () => {
    for (const retryCount of [0, 3]) {
      const { world } = createWorld('dpl_current');
      const order: string[] = [];
      const beforeStop = vi.fn(async () => {
        order.push('barrier');
      });
      await guardDeploymentAffinity({
        world,
        run,
        retryCount,
        beforeStop,
        reenqueue: async () => {
          order.push('reenqueue');
        },
      });
      expect(beforeStop).toHaveBeenCalledTimes(1);
      expect(order[0]).toBe('barrier');
    }
  });

  it('guards a run pinned to a deployment other than its creator', async () => {
    // `start({ deploymentId })` (and `'latest'`) pin a run to a deployment that
    // did not create it: such a run executes normally on its target...
    const target = createWorld('dpl_explicit_target');
    await expect(
      guardDeploymentAffinity({
        world: target.world,
        run: { ...run, deploymentId: 'dpl_explicit_target' },
      })
    ).resolves.toMatchObject({ outcome: 'continue' });
    expect(target.eventsCreate).not.toHaveBeenCalled();

    // ...and is still re-routed if delivery lands on its creator instead.
    const creator = createWorld('dpl_creator');
    const reenqueue = vi.fn();
    await expect(
      guardDeploymentAffinity({
        world: creator.world,
        run: { ...run, deploymentId: 'dpl_explicit_target' },
        reenqueue,
      })
    ).resolves.toMatchObject({ outcome: 'rerouted' });
    expect(reenqueue).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: 'dpl_explicit_target' })
    );
  });
});
