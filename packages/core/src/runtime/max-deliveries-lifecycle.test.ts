import { EntityConflictError, RunExpiredError } from '@workflow/errors';
import { withResolvers } from '@workflow/utils';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { dispatchRunFailedHooks } from './lifecycle-hooks.js';
import { setWorld } from './world.js';

vi.mock('./lifecycle-hooks.js', () => ({
  dispatchRunFailedHooks: vi.fn(),
  dispatchRunCompletedHooks: vi.fn(),
}));

const runId = 'wrun_max_deliveries_lifecycle';
const create = vi.fn().mockResolvedValue({});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('WORKFLOW_MAX_QUEUE_DELIVERIES', '1');
  vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    events: { create },
    createQueueHandler: (_prefix, handler) => async () => {
      await handler(
        { runId, requestedAt: new Date() },
        {
          requestId: 'req_test',
          attempt: 2,
          queueName: '__wkf_workflow_workflow',
          messageId: 'msg_test',
        }
      );
      return new Response(null, { status: 204 });
    },
  } as World);
});

afterEach(() => {
  setWorld(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const run = () => workflowEntrypoint('')(new Request('http://localhost/'));

it('dispatches max-deliveries failure only after its terminal write lands', async () => {
  const persisted = withResolvers<void>();
  create.mockReturnValueOnce(persisted.promise);
  const execution = run();
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  expect(dispatchRunFailedHooks).not.toHaveBeenCalled();
  persisted.resolve();
  expect((await execution).status).toBe(204);
  expect(dispatchRunFailedHooks).toHaveBeenCalledExactlyOnceWith(
    runId,
    'workflow',
    create.mock.calls[0][1].eventData.error,
    undefined,
    'MAX_DELIVERIES_EXCEEDED'
  );
});

it.each([
  new EntityConflictError('already finished'),
  new RunExpiredError('expired'),
  new Error('write failed'),
])('does not dispatch when the terminal write is rejected: %s', async (error) => {
  create.mockRejectedValueOnce(error);
  expect((await run()).status).toBe(204);
  expect(create).toHaveBeenCalledOnce();
  expect(dispatchRunFailedHooks).not.toHaveBeenCalled();
});
