import {
  RUN_ERROR_CODES,
  WorkflowDeploymentMismatchError,
} from '@workflow/errors';
import type { WorkflowRun, World } from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { hydrateRunError } from '../serialization.js';
import { failRunIfDeploymentMismatch } from './deployment-guard.js';

const run = {
  runId: 'wrun_test',
  deploymentId: 'dpl_origin',
  specVersion: 5,
} satisfies Pick<WorkflowRun, 'runId' | 'deploymentId' | 'specVersion'>;

function createWorld(currentDeploymentId: string) {
  const eventsCreate = vi.fn().mockResolvedValue({ event: {} });
  const getEncryptionKeyForRun = vi.fn().mockResolvedValue(undefined);
  const world = {
    getDeploymentId: vi.fn().mockResolvedValue(currentDeploymentId),
    getEncryptionKeyForRun,
    events: { create: eventsCreate },
  } as unknown as World;
  return { world, eventsCreate, getEncryptionKeyForRun };
}

describe('failRunIfDeploymentMismatch', () => {
  it('continues when the run belongs to the current deployment', async () => {
    const { world, eventsCreate, getEncryptionKeyForRun } =
      createWorld('dpl_origin');

    await expect(failRunIfDeploymentMismatch({ world, run })).resolves.toBe(
      false
    );
    expect(eventsCreate).not.toHaveBeenCalled();
    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
  });

  it('fails the run with an actionable error on another deployment', async () => {
    const { world, eventsCreate, getEncryptionKeyForRun } =
      createWorld('dpl_current');

    const stopped = await failRunIfDeploymentMismatch({
      world,
      run,
      requestId: 'req_test',
    });
    expect(stopped).toBe(true);

    // The failure must be recordable without the origin deployment's key,
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

    const failedEvent = eventsCreate.mock.calls[0][1];
    const error = await hydrateRunError(
      failedEvent.eventData.error,
      'wrun_test',
      undefined
    );
    expect(WorkflowDeploymentMismatchError.is(error)).toBe(true);
    expect((error as Error).message).toContain(
      'belongs to deployment "dpl_origin", but was received by deployment "dpl_current"'
    );
    expect((error as Error).message).toContain(
      'stopped to protect against code-skew errors'
    );
    expect((error as Error).message).toContain(
      'Verify that the original deployment is still available'
    );
  });
});
