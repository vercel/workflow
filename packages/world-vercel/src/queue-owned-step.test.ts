import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  invoke: vi.fn(),
  open: vi.fn(async () => () => {}),
  execute: vi.fn(async (_runId, work) => work()),
  singleOwner: vi.fn(async () => true),
  deliverStep: vi.fn(async () => ({ messageId: 'direct_step' })),
  callback: undefined as
    | undefined
    | ((message: unknown, metadata: unknown) => Promise<unknown>),
}));
vi.mock('@vercel/queue', () => ({
  ConsumerDiscoveryError: class extends Error {},
  QueueClient: class {
    handleCallback(callback: typeof mocks.callback) {
      mocks.callback = callback;
      return async () => new Response();
    }
  },
}));
vi.mock('./utils.js', () => ({
  getHttpUrl: () => ({ baseUrl: 'https://example.invalid', usingProxy: false }),
  getHeaders: () => new Headers(),
}));
vi.mock('./invocation.js', () => ({
  AFFINITY_HEADER: 'x-vercel-affinity-id',
  DEPLOYMENT_HEADER: 'x-deployment-id',
  INVOCATION_HEADER: 'x-workflow-invoke-version',
  invocationAffinity: (id: string) => id,
  invocationConfig: () => ({ endpoint: 'https://example.invalid/invoke' }),
  isSingleOwnerRun: mocks.singleOwner,
  startInputAttributes: (input: { runInput?: { attributes?: unknown } }) =>
    input?.runInput?.attributes,
  createInvoker: (_config: unknown, kind: string) =>
    kind === 'wake' ? mocks.wake : mocks.invoke,
  isRemoteStepMessage: (payload: { input?: { executionMode?: string } }) =>
    payload?.input?.executionMode === 'remote',
  createStepDelivery: () => mocks.deliverStep,
  createDirectInvocationHandler: () => ({
    execute: mocks.execute,
    handle: vi.fn(),
  }),
}));
vi.mock('./ws-transport.js', () => ({ openWsChannel: mocks.open }));
vi.mock('./ws-transport-enabled.js', () => ({
  isWsEventsTransportEnabled: () => true,
  isWsEventsTransportEnabledForWorkflow: () => true,
}));

import { ValidQueueName } from '@workflow/world';
import { createQueue } from './queue.js';

it('delivers direct overflow execution itself instead of publishing it to VQS', async () => {
  const message = {
    runId: 'run',
    stepId: 'step',
    stepName: 'work',
    input: { type: 'step_execute', executionMode: 'remote' },
  };
  await expect(
    createQueue().queue(
      ValidQueueName.parse('__wkf_workflow_test'),
      message as never
    )
  ).resolves.toEqual({ messageId: 'direct_step' });
  expect(mocks.deliverStep).toHaveBeenCalledWith(
    '__wkf_workflow_test',
    message,
    undefined
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('delivers an owner-managed step to the worker without forwarding a wake or opening an owner channel', async () => {
  const handler = vi.fn();
  createQueue().createQueueHandler('__wkf_workflow_', handler);
  await mocks.callback!(
    {
      queueName: '__wkf_workflow_test',
      deploymentId: 'test',
      payload: {
        runId: 'run',
        stepId: 'step',
        stepName: 'work',
        input: { type: 'step_execute' },
      },
    },
    { messageId: 'delivery', deliveryCount: 1 }
  );
  expect(handler).toHaveBeenCalledOnce();
  expect(mocks.wake).not.toHaveBeenCalled();
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});

it("still forwards a single-owner run's orchestration wakes to its one owner", async () => {
  const handler = vi.fn();
  createQueue().createQueueHandler('__wkf_workflow_', handler);
  await mocks.callback!(
    {
      queueName: '__wkf_workflow_test',
      deploymentId: 'test',
      payload: { runId: 'run' },
    },
    { messageId: 'wake', deliveryCount: 1 }
  );
  expect(mocks.wake).toHaveBeenCalledWith(
    'run',
    { runId: 'run' },
    { idempotencyKey: 'wake' }
  );
  expect(mocks.singleOwner).toHaveBeenCalledWith('run', undefined);
  expect(handler).not.toHaveBeenCalled();
});

it("handles any other run's orchestration wake here", async () => {
  mocks.singleOwner.mockResolvedValueOnce(false);
  const handler = vi.fn();
  createQueue().createQueueHandler('__wkf_workflow_', handler);
  await mocks.callback!(
    {
      queueName: '__wkf_workflow_test',
      deploymentId: 'test',
      payload: { runId: 'run' },
    },
    { messageId: 'wake', deliveryCount: 1 }
  );
  expect(mocks.wake).not.toHaveBeenCalled();
  expect(handler).toHaveBeenCalledOnce();
});

it('acknowledges a wake its owner rejects because the run has ended', async () => {
  mocks.wake.mockRejectedValueOnce(
    Object.assign(new Error('Workflow has expired'), { status: 410 })
  );
  const handler = vi.fn();
  createQueue().createQueueHandler('__wkf_workflow_', handler);
  await expect(
    mocks.callback!(
      {
        queueName: '__wkf_workflow_test',
        deploymentId: 'test',
        payload: { runId: 'run' },
      },
      { messageId: 'wake', deliveryCount: 3 }
    )
  ).resolves.toBeUndefined();
  expect(handler).not.toHaveBeenCalled();
});

it.each([
  404, 503,
])('keeps retrying a wake its owner answers with %i', async (status) => {
  mocks.wake.mockRejectedValueOnce(
    Object.assign(new Error('rejected'), { status })
  );
  createQueue().createQueueHandler('__wkf_workflow_', vi.fn());
  await expect(
    mocks.callback!(
      {
        queueName: '__wkf_workflow_test',
        deploymentId: 'test',
        payload: { runId: 'run' },
      },
      { messageId: 'wake', deliveryCount: 1 }
    )
  ).rejects.toThrow('rejected');
});
