import { EntityConflictError, RunExpiredError } from '@workflow/errors';
import {
  type CreateEventRequest,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  dehydrateRunError,
  encodeWithFormatPrefix,
  hydrateRunError,
  maybeDecrypt,
  SerializationFormat,
} from '../serialization.js';
import { dispatchRunFailedHooks } from './lifecycle-hooks.js';
import { runWorkflowWithQuickJS } from './quickjs-entrypoint.js';
import { startQuickJSWorkflow } from './quickjs-runtime.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({ getPortLazy: async () => 3000 }));
vi.mock('./quickjs-runtime.js', () => ({ startQuickJSWorkflow: vi.fn() }));
vi.mock('./lifecycle-hooks.js', () => ({
  dispatchRunFailedHooks: vi.fn(),
  dispatchRunCompletedHooks: vi.fn(),
}));
vi.mock('../serialization.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../serialization.js')>();
  return { ...actual, dehydrateRunError: vi.fn(actual.dehydrateRunError) };
});

const runId = 'wrun_quickjs_lifecycle';
const workflowName = 'workflow';
const now = new Date('2026-05-19T12:00:00.000Z');
const workflowRun: WorkflowRun = {
  runId,
  workflowName,
  status: 'running',
  input: [],
  deploymentId: 'dpl_quickjs_lifecycle',
  specVersion: SPEC_VERSION_CURRENT,
  startedAt: now,
  createdAt: now,
  updatedAt: now,
};
const createEvent = vi.fn(
  async (_runId: string, request: CreateEventRequest) => ({
    event: { ...request, runId, eventId: 'evnt_failed' },
  })
);
const failed: { name: string; message: string; valueBytes?: Uint8Array } = {
  name: 'Error',
  message: 'VM failure',
};
const run = () =>
  runWorkflowWithQuickJS({ workflowCode: '', workflowName, workflowRun });

beforeEach(() => {
  vi.clearAllMocks();
  delete failed.valueBytes;
  vi.mocked(startQuickJSWorkflow).mockResolvedValue({
    result: { failed },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  });
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: async () => ({ data: [], cursor: null, hasMore: false }),
      create: createEvent,
    },
    getEncryptionKeyForRun: async () => new Uint8Array(32).fill(7),
  } as unknown as World);
});

afterEach(() => setWorld(undefined));

it.each([
  'unknown class',
  'secondary dehydration',
])('dispatches the exact persisted bytes and key after the %s fallback write succeeds', async (fallback) => {
  if (fallback === 'unknown class') {
    // A valid VM Instance descriptor whose class is not registered on the host.
    failed.valueBytes = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      new TextEncoder().encode(
        '[["Instance",1],{"classId":2,"data":3},"quickjs-only-error",{}]'
      )
    ) as Uint8Array;
    await expect(
      hydrateRunError(failed.valueBytes, runId, undefined)
    ).rejects.toThrow('Class "quickjs-only-error" not found');
  } else {
    vi.mocked(dehydrateRunError).mockRejectedValueOnce(
      new Error('first dehydration failed')
    );
  }
  let finishWrite!: () => void;
  const pendingWrite = new Promise<void>((resolve) => {
    finishWrite = resolve;
  });
  createEvent.mockImplementationOnce(async (_id, request) => {
    await pendingWrite;
    return { event: { ...request, runId, eventId: 'evnt_failed' } };
  });
  const execution = run();
  await vi.waitFor(() => expect(createEvent).toHaveBeenCalledTimes(1));
  expect(dispatchRunFailedHooks).not.toHaveBeenCalled();
  finishWrite();
  await execution;

  const [, request] = createEvent.mock.calls[0];
  expect(request.eventType).toBe('run_failed');
  if (request.eventType !== 'run_failed') throw new Error('Expected failure');
  const key = vi.mocked(startQuickJSWorkflow).mock.calls[0][0].encryptionKey;
  expect(key).toBeDefined();
  expect(dispatchRunFailedHooks).toHaveBeenCalledExactlyOnceWith(
    runId,
    workflowName,
    request.eventData.error,
    key,
    'USER_ERROR'
  );
  expect(vi.mocked(dispatchRunFailedHooks).mock.calls[0][2]).toBe(
    request.eventData.error
  );
  expect(vi.mocked(dispatchRunFailedHooks).mock.calls[0][3]).toBe(key);
  if (fallback === 'unknown class') {
    expect(await maybeDecrypt(request.eventData.error, key)).toEqual(
      failed.valueBytes
    );
    expect(dehydrateRunError).not.toHaveBeenCalled();
  } else {
    expect(dehydrateRunError).toHaveBeenCalledTimes(2);
    expect(request.eventData.error).toBe(
      await vi.mocked(dehydrateRunError).mock.results[1].value
    );
    expect(
      await hydrateRunError(request.eventData.error, runId, key)
    ).toMatchObject({
      name: 'Error',
      message: 'VM failure',
    });
  }
});

it.each([
  new EntityConflictError('already finished'),
  new RunExpiredError('expired'),
  new Error('write failed'),
])('does not dispatch when run_failed is rejected: %s', async (error) => {
  createEvent.mockRejectedValueOnce(error);
  if (EntityConflictError.is(error) || RunExpiredError.is(error)) {
    await expect(run()).resolves.toBeUndefined();
  } else {
    await expect(run()).rejects.toBe(error);
  }
  expect(createEvent).toHaveBeenCalledTimes(1);
  expect(dispatchRunFailedHooks).not.toHaveBeenCalled();
});
