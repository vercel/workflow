import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  invoke: vi.fn(),
  open: vi.fn(async () => () => {}),
  execute: vi.fn(async (_runId, work) => work()),
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
  createInvoker: (_config: unknown, kind: string) =>
    kind === 'wake' ? mocks.wake : mocks.invoke,
  createDirectInvocationHandler: () => ({
    execute: mocks.execute,
    handle: vi.fn(),
  }),
}));
vi.mock('./ws-transport.js', () => ({ openWsChannel: mocks.open }));
vi.mock('./ws-transport-enabled.js', () => ({
  isWsEventsTransportEnabled: () => true,
}));

import { ValidQueueName } from '@workflow/world';
import { createQueue } from './queue.js';

it('does not silently publish direct overflow execution to VQS', async () => {
  await expect(
    createQueue().queue(ValidQueueName.parse('__wkf_workflow_test'), {
      runId: 'run',
      stepId: 'step',
      stepName: 'work',
      input: { type: 'step_execute', executionMode: 'remote' },
    })
  ).rejects.toThrow('refusing VQS fallback');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it('delivers an owner-managed step to the worker without forwarding a wake or opening an owner channel', async () => {
  vi.stubEnv('WORKFLOW_RETAINED_RUNNER', '1');
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

it('still forwards orchestration wakes to the one run owner', async () => {
  vi.stubEnv('WORKFLOW_RETAINED_RUNNER', '1');
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
  expect(handler).not.toHaveBeenCalled();
});
