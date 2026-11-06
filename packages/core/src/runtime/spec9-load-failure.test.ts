import { SPEC_VERSION_SINGLE_ORCHESTRATOR, type World } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { getMaxQueueDeliveries } from './constants.js';
import { setWorld } from './world.js';

// A deployment whose spec 9 chunk cannot load: the dynamic import rejects.
vi.mock('./spec9/delivery.js', () => {
  throw new Error('spec 9 chunk failed to load');
});

const runId = 'wrun_spec9_load_failure';
const create = vi.fn().mockResolvedValue({});

function installWorld(attempt: number) {
  setWorld({
    capabilities: { inBandFence: true },
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    events: {
      create,
      list: async () => ({ data: [], hasMore: false, cursor: null }),
    },
    createQueueHandler: (_prefix, handler) => async () => {
      await handler(
        {
          runId,
          requestedAt: new Date(),
          runSpecVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
        },
        {
          requestId: 'req_test',
          attempt,
          queueName: '__wkf_workflow_workflow',
          messageId: 'msg_test',
        }
      );
      return new Response(null, { status: 204 });
    },
  } as World);
}

const errorLog = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  const runLogger = runtimeLogger.forRun(runId);
  vi.spyOn(runtimeLogger, 'forRun').mockReturnValue({
    ...runLogger,
    error: errorLog,
  });
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
});

const run = () => workflowEntrypoint('')(new Request('http://localhost/'));

it('redelivers a spec 9 delivery whose orchestrator fails to load, within the delivery cap', async () => {
  installWorld(getMaxQueueDeliveries());
  await expect(run()).rejects.toThrow();
  expect(create).not.toHaveBeenCalled();
  expect(errorLog).toHaveBeenCalledOnce();
  expect(errorLog.mock.calls[0][0]).toContain('retrying via queue redelivery');
  expect(errorLog.mock.calls[0][1]).toMatchObject({
    attempt: getMaxQueueDeliveries(),
    specVersion: SPEC_VERSION_SINGLE_ORCHESTRATOR,
    errorMessage: expect.any(String),
  });
});

it('acknowledges a spec 9 delivery whose orchestrator fails to load once past the delivery cap', async () => {
  installWorld(getMaxQueueDeliveries() + 1);
  expect((await run()).status).toBe(204);
  expect(create).not.toHaveBeenCalled();
  expect(errorLog).toHaveBeenCalledOnce();
  expect(errorLog.mock.calls[0][0]).toContain('acknowledged');
});
