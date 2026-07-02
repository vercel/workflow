import { waitUntil } from '@vercel/functions';
import {
  EntityConflictError,
  HookConflictError,
  RUN_ERROR_CODES,
  WorkflowRuntimeError,
  WorkflowStartError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
  type StartHookAdmissionCaps,
  SPEC_VERSION_LEGACY,
  SPEC_VERSION_SUPPORTS_ATTRIBUTES,
  SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
  SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
} from '@workflow/world';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from 'vitest';
import { runtimeLogger } from '../logger.js';
import type { Run } from './run.js';
import type { WorkflowFunction } from './start.js';
import { _resetLatestNoOpWarnForTests, start } from './start.js';
import { setWorld } from './world.js';

// Mock @vercel/functions
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

// Mock telemetry
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
  getActiveSpan: vi.fn().mockResolvedValue(undefined),
}));

describe('start', () => {
  describe('error handling', () => {
    it('should throw WorkflowRuntimeError when workflow is undefined', async () => {
      await expect(
        // @ts-expect-error - intentionally passing undefined
        start(undefined, [])
      ).rejects.toThrow(WorkflowRuntimeError);

      await expect(
        // @ts-expect-error - intentionally passing undefined
        start(undefined, [])
      ).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow is null', async () => {
      await expect(
        // @ts-expect-error - intentionally passing null
        start(null, [])
      ).rejects.toThrow(WorkflowRuntimeError);

      await expect(
        // @ts-expect-error - intentionally passing null
        start(null, [])
      ).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow has no workflowId', async () => {
      const invalidWorkflow = () => Promise.resolve('result');

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        WorkflowRuntimeError
      );

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow SDK is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow has empty string workflowId', async () => {
      const invalidWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: '',
      });

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        WorkflowRuntimeError
      );
    });
  });

  describe('specVersion', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;
    const queueFirstStartHookAdmission: StartHookAdmissionCaps = {
      maxTtlSeconds: 30 * 24 * 60 * 60,
      maxTokenBytes: 255,
    };

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      setWorld(undefined);
      vi.clearAllMocks();
    });

    function setQueueFirstWorld(specVersion = SPEC_VERSION_CURRENT) {
      setWorld({
        specVersion,
        startHookAdmission: queueFirstStartHookAdmission,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);
    }

    it('rejects worlds that do not declare a specVersion', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'requires a World with matching spec version'
      );
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('uses world.specVersion when available', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, []);

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_CURRENT,
        }),
        expect.objectContaining({
          v1Compat: false,
        })
      );
    });

    it('rejects worlds whose declared specVersion is older than the runtime', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'requires a World with matching spec version'
      );
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('rejects worlds whose declared specVersion is newer than the runtime', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      setWorld({
        specVersion: SPEC_VERSION_CURRENT + 1,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'requires a World with matching spec version'
      );
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('should use provided specVersion when passed in options', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, [], { specVersion: SPEC_VERSION_LEGACY });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_LEGACY,
        }),
        expect.objectContaining({
          v1Compat: true,
        })
      );
    });

    it('should use provided specVersion with v1Compat true for legacy versions', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, [], { specVersion: 1 });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: 1,
        }),
        expect.objectContaining({
          v1Compat: true,
        })
      );
    });

    it('seeds initial attributes on run_created and resilient run input for v4', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, [], {
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        attributes: { tenant: 't1' },
      });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          eventData: expect.objectContaining({
            attributes: { tenant: 't1' },
          }),
        }),
        expect.anything()
      );
      expect(mockQueue.mock.calls[0]?.[1].runInput.attributes).toEqual({
        tenant: 't1',
      });
      // The reserved-namespace escape hatch was not requested, so the
      // flag must not appear on either payload.
      expect(mockEventsCreate.mock.calls[0]?.[1].eventData).not.toHaveProperty(
        'allowReservedAttributes'
      );
      expect(mockQueue.mock.calls[0]?.[1].runInput).not.toHaveProperty(
        'allowReservedAttributes'
      );
    });

    it('seeds start hook data on run_created and the resilient run input', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      // Worlds without caps declare an empty admission object.
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        startHookAdmission: {},
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await start(validWorkflow, [], {
        hook: {
          token: 'order:123',
          experimental_ttl: '30 days',
        },
      });

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          eventData: expect.objectContaining({
            startHook: {
              token: 'order:123',
              ttlSeconds: 30 * 24 * 60 * 60,
            },
          }),
        }),
        expect.anything()
      );
      expect(mockQueue.mock.calls[0]?.[1].runInput.startHook).toEqual({
        token: 'order:123',
        ttlSeconds: 30 * 24 * 60 * 60,
      });

      vi.useRealTimers();
    });

    it('omits ttlSeconds when experimental_ttl is not provided (token released at run end)', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setQueueFirstWorld();

      await start(validWorkflow, [], {
        hook: { token: 'order:123' },
      });

      expect(mockEventsCreate.mock.calls[0]?.[1].eventData.startHook).toEqual({
        token: 'order:123',
      });
      expect(mockQueue.mock.calls[0]?.[1].runInput.startHook).toEqual({
        token: 'order:123',
      });
    });

    it('rejects empty start hook tokens', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: '',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toThrow(/token must be a non-empty string/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('queues before admitting experimental start hooks in queue-first worlds', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setQueueFirstWorld();

      const run = await start(validWorkflow, [], {
        hook: {
          token: 'order:123',
          experimental_ttl: '30 days',
        },
      });

      expect(run.runId).toBe(mockEventsCreate.mock.calls[0]?.[0]);
      expect(mockQueue).toHaveBeenCalledTimes(1);
      expect(mockEventsCreate).toHaveBeenCalledTimes(1);
      expect(mockQueue.mock.calls[0]?.[1].runInput.startHook).toEqual({
        token: 'order:123',
        ttlSeconds: 30 * 24 * 60 * 60,
      });
      expect(mockEventsCreate.mock.calls[0]?.[1].eventData).toEqual(
        expect.objectContaining({
          startHook: {
            token: 'order:123',
            ttlSeconds: 30 * 24 * 60 * 60,
          },
        })
      );
      expect(mockQueue.mock.calls[0]?.[2]).not.toHaveProperty('idempotencyKey');
      expect(mockQueue.mock.invocationCallOrder[0]).toBeLessThan(
        mockEventsCreate.mock.invocationCallOrder[0]
      );
    });

    it('throws WorkflowStartError without admission when queue-first enqueue fails', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      const queueError = new WorkflowWorldError('queue unavailable', {
        status: 503,
      });
      mockQueue.mockRejectedValueOnce(queueError);
      setQueueFirstWorld();

      const startPromise = start(validWorkflow, [], {
        hook: {
          token: 'order:123',
          experimental_ttl: '30 days',
        },
      });

      await expect(startPromise).rejects.toBeInstanceOf(WorkflowStartError);
      await expect(startPromise).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'queue',
        queued: 'unknown',
        retryable: true,
        status: 503,
        cause: queueError,
      });
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('throws WorkflowStartError when queue-first admission cannot be confirmed', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      const admissionError = new WorkflowWorldError('response lost', {
        status: 500,
      });
      mockEventsCreate.mockRejectedValueOnce(admissionError);
      setQueueFirstWorld();

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'admission',
        queued: true,
        retryable: true,
        status: 500,
        cause: admissionError,
      });
      expect(mockQueue).toHaveBeenCalledTimes(1);
    });

    it('wraps transient queue-first admission world errors after queueing', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      const admissionError = new WorkflowWorldError('service unavailable', {
        status: 503,
      });
      mockEventsCreate.mockRejectedValueOnce(admissionError);
      setQueueFirstWorld();

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'admission',
        queued: true,
        retryable: true,
        status: 503,
        cause: admissionError,
      });
      expect(mockQueue).toHaveBeenCalledTimes(1);
    });

    it('wraps non-retryable queue-first admission world errors after queueing', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      const admissionError = new WorkflowWorldError('forbidden', {
        status: 403,
      });
      mockEventsCreate.mockRejectedValueOnce(admissionError);
      setQueueFirstWorld();

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'admission',
        queued: true,
        retryable: false,
        status: 403,
        cause: admissionError,
      });
      expect(mockQueue).toHaveBeenCalledTimes(1);
    });

    it('wraps unknown queue-first admission failures after queueing', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      const admissionError = new TypeError('socket closed');
      mockEventsCreate.mockRejectedValueOnce(admissionError);
      setQueueFirstWorld();
      const waitUntilCalls = vi.mocked(waitUntil).mock.calls.length;

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'admission',
        queued: true,
        retryable: false,
        cause: admissionError,
      });
      await vi.waitFor(() =>
        expect(vi.mocked(waitUntil).mock.calls.length).toBeGreaterThan(
          waitUntilCalls
        )
      );
    });

    it('wraps durability-probe failures after a post-enqueue admission conflict', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      const probeError = new WorkflowWorldError('list unavailable', {
        status: 503,
      });
      mockEventsCreate.mockRejectedValueOnce(
        new EntityConflictError('Run already exists')
      );
      const mockEventsList = vi.fn().mockRejectedValue(probeError);
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        startHookAdmission: queueFirstStartHookAdmission,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate, list: mockEventsList },
        queue: mockQueue,
      } as any);

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'admission',
        queued: true,
        retryable: true,
        cause: probeError,
      });
      expect(mockQueue).toHaveBeenCalledTimes(1);
    });

    it('still surfaces HookConflictError after queue-first enqueue', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      mockEventsCreate.mockRejectedValueOnce(
        new HookConflictError('order:123', 'wrun_conflicting')
      );
      setQueueFirstWorld();

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toThrow(HookConflictError);
      expect(mockQueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.mock.invocationCallOrder[0]).toBeLessThan(
        mockEventsCreate.mock.invocationCallOrder[0]
      );
    });

    it('rejects experimental start hook TTLs above the world cap before queueing', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setQueueFirstWorld();

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '31 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowWorldError',
        code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('rejects queue-first start hooks with oversized tokens before queueing', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setQueueFirstWorld();

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'x'.repeat(256),
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowWorldError',
        code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('rejects queue-first start hooks without runInput queue transport before queueing', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setQueueFirstWorld();

      // Worlds must match the runtime spec version, so a pre-CBOR-transport
      // run can only come from an explicit opts.specVersion override.
      await expect(
        start(validWorkflow, [], {
          specVersion: SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowWorldError',
        code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('rejects queue-first start hooks when the target deployment lacks runtime support', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        startHookAdmission: queueFirstStartHookAdmission,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_current'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        streams: {
          get: vi.fn().mockResolvedValue(
            new Response(
              JSON.stringify({
                healthy: true,
                workflowCoreVersion: '5.0.0-beta.25',
              })
            ).body
          ),
        },
      } as any);

      await expect(
        start(validWorkflow, [], {
          deploymentId: 'deploy_old',
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toMatchObject({
        name: 'WorkflowWorldError',
        code: RUN_ERROR_CODES.WORLD_CONTRACT_ERROR,
      });
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).toHaveBeenCalledTimes(1);
      expect(mockQueue.mock.calls[0]?.[0]).toContain('health_check');
    });

    it('rejects experimental start hooks when the world has not opted in', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(
        start(validWorkflow, [], {
          hook: {
            token: 'order:123',
            experimental_ttl: '30 days',
          },
        })
      ).rejects.toThrow(/supports experimental start-hook admission/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
      expect(mockQueue).not.toHaveBeenCalled();
    });

    it('rejects initial attributes for pre-v4 runs', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await expect(
        start(validWorkflow, [], {
          specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
          attributes: { tenant: 't1' },
        })
      ).rejects.toThrow(/spec version 4/);
    });

    it('rejects non-string initial attribute values', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], {
          attributes: { tenant: undefined } as any,
        })
      ).rejects.toThrow(/must be a string value/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('rejects reserved-prefix initial attribute keys with guidance', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], { attributes: { $system: 'x' } })
      ).rejects.toThrow(/reserved prefix/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('seeds reserved-prefix initial attributes with allowReservedAttributes and forwards the flag on both payloads', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await start(validWorkflow, [], {
        attributes: { $rootRunId: 'wrun_root', tenant: 't1' },
        allowReservedAttributes: true,
      });

      // run_created carries the attributes and the flag, so server-side
      // validation permits the reserved keys the same way the client did.
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          eventData: expect.objectContaining({
            attributes: { $rootRunId: 'wrun_root', tenant: 't1' },
            allowReservedAttributes: true,
          }),
        }),
        expect.anything()
      );
      // The resilient-start queue input carries both too, so a run
      // bootstrapped from run_started validates identically.
      expect(mockQueue.mock.calls[0]?.[1].runInput).toEqual(
        expect.objectContaining({
          attributes: { $rootRunId: 'wrun_root', tenant: 't1' },
          allowReservedAttributes: true,
        })
      );
    });

    it('still enforces non-reserved validation rules when allowReservedAttributes is set', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], {
          attributes: { $note: 'v'.repeat(257) },
          allowReservedAttributes: true,
        })
      ).rejects.toThrow(/exceeds limit 256/);
      expect(mockEventsCreate).not.toHaveBeenCalled();
    });

    it('rejects oversized initial attribute keys, values, and batches before any write', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(
        start(validWorkflow, [], {
          attributes: { ['k'.repeat(257)]: 'v' },
        })
      ).rejects.toThrow(/exceeds limit 256/);

      await expect(
        start(validWorkflow, [], {
          attributes: { note: 'v'.repeat(257) },
        })
      ).rejects.toThrow(/exceeds limit 256/);

      const overCap: Record<string, string> = {};
      for (let i = 0; i <= 64; i++) overCap[`key_${i}`] = 'v';
      await expect(
        start(validWorkflow, [], { attributes: overCap })
      ).rejects.toThrow(/exceed limit 64/);

      expect(mockEventsCreate).not.toHaveBeenCalled();
    });
  });

  describe('encryption', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;
    let mockGetEncryptionKeyForRun: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);
      mockGetEncryptionKeyForRun = vi.fn().mockResolvedValue(undefined);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_resolved'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      });
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('should pass resolved deploymentId to getEncryptionKeyForRun even when not in opts', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      // Call start() without explicit deploymentId in options — it should
      // be resolved from world.getDeploymentId() and forwarded to
      // getEncryptionKeyForRun so the key can be fetched.
      await start(validWorkflow, []);

      expect(mockGetEncryptionKeyForRun).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          deploymentId: 'deploy_resolved',
        })
      );
    });

    it('should pass explicit deploymentId from opts to getEncryptionKeyForRun', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      await start(validWorkflow, [], { deploymentId: 'deploy_explicit' });

      expect(mockGetEncryptionKeyForRun).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          deploymentId: 'deploy_explicit',
        })
      );
    });
  });

  describe('deploymentId: latest', () => {
    let mockEventsCreate: ReturnType<typeof vi.fn>;
    let mockQueue: ReturnType<typeof vi.fn>;

    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);
      // Reset the warn-once guard so the no-op warn path is exercisable
      // regardless of test order.
      _resetLatestNoOpWarnForTests();
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
      // Restore any spies (e.g. on runtimeLogger.warn) even if a test threw
      // before its own cleanup — clearAllMocks alone doesn't restore spies.
      vi.restoreAllMocks();
    });

    it('should resolve "latest" to the actual deployment ID via resolveLatestDeploymentId', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      });

      await start(validWorkflow, [], { deploymentId: 'latest' });

      expect(mockResolveLatest).toHaveBeenCalledTimes(1);

      // The resolved deployment ID should be used in the run_created event
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          eventData: expect.objectContaining({
            deploymentId: 'dpl_resolved_abc123',
          }),
        }),
        expect.anything()
      );

      // The resolved deployment ID should be used in the queue call
      expect(mockQueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ deploymentId: 'dpl_resolved_abc123' })
      );
    });

    it('should pass the resolved deployment ID to getEncryptionKeyForRun when using "latest"', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');
      const mockGetEncryptionKeyForRun = vi.fn();

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      });

      await start(validWorkflow, [], { deploymentId: 'latest' });

      expect(mockResolveLatest).toHaveBeenCalledTimes(1);
      expect(mockGetEncryptionKeyForRun).toHaveBeenCalled();

      const [, contextArg] =
        mockGetEncryptionKeyForRun.mock.calls[
          mockGetEncryptionKeyForRun.mock.calls.length - 1
        ] || [];

      expect(contextArg).toEqual(
        expect.objectContaining({
          deploymentId: 'dpl_resolved_abc123',
        })
      );
    });

    it('should warn and fall back to the current deployment ID when "latest" is used with a World that does not implement resolveLatestDeploymentId', async () => {
      const warnSpy = vi
        .spyOn(runtimeLogger, 'warn')
        .mockImplementation(() => {});

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        // No resolveLatestDeploymentId
      });

      // Should not throw — 'latest' is a no-op in worlds without atomic
      // deployments.
      await start(validWorkflow, [], { deploymentId: 'latest' });

      // It should warn that 'latest' had no effect in this world.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("deploymentId: 'latest' has no effect"),
        expect.objectContaining({ currentDeploymentId: 'deploy_123' })
      );

      // The run should fall back to the current deployment ID in both the
      // run_created event and the queue call.
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          eventData: expect.objectContaining({
            deploymentId: 'deploy_123',
          }),
        }),
        expect.anything()
      );
      expect(mockQueue).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        expect.objectContaining({ deploymentId: 'deploy_123' })
      );
    });

    it('should only warn once per process when "latest" is used repeatedly in an unsupported World', async () => {
      const warnSpy = vi
        .spyOn(runtimeLogger, 'warn')
        .mockImplementation(() => {});

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        // No resolveLatestDeploymentId
      });

      // Multiple runs that all hit the no-op path...
      await start(validWorkflow, [], { deploymentId: 'latest' });
      await start(validWorkflow, [], { deploymentId: 'latest' });
      await start(validWorkflow, [], { deploymentId: 'latest' });

      // ...should only log the warning a single time.
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // ...but every run still falls back to the current deployment.
      expect(mockQueue).toHaveBeenCalledTimes(3);
      for (const call of mockQueue.mock.calls) {
        expect(call[2]).toEqual(
          expect.objectContaining({ deploymentId: 'deploy_123' })
        );
      }
    });

    it('should not call resolveLatestDeploymentId when a normal deploymentId is provided', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      });

      await start(validWorkflow, [], { deploymentId: 'dpl_specific_456' });

      expect(mockResolveLatest).not.toHaveBeenCalled();

      // The provided deployment ID should be used directly
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventData: expect.objectContaining({
            deploymentId: 'dpl_specific_456',
          }),
        }),
        expect.anything()
      );
    });

    it('should not call resolveLatestDeploymentId when no deploymentId is provided', async () => {
      const mockResolveLatest = vi
        .fn()
        .mockResolvedValue('dpl_resolved_abc123');

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('dpl_default_789'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      });

      await start(validWorkflow, []);

      expect(mockResolveLatest).not.toHaveBeenCalled();

      // Should use the default from getDeploymentId()
      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventData: expect.objectContaining({
            deploymentId: 'dpl_default_789',
          }),
        }),
        expect.anything()
      );
    });
  });

  describe('resilient start (run_created failure)', () => {
    const validWorkflow = Object.assign(() => Promise.resolve('result'), {
      workflowId: 'test-workflow',
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('should succeed when events.create throws a 500 error (queue still dispatched)', async () => {
      const mockQueue = vi.fn().mockResolvedValue({ messageId: null });
      const serverError = new WorkflowWorldError('Internal Server Error', {
        status: 500,
      });
      const mockEventsCreate = vi.fn().mockRejectedValue(serverError);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      // start() should NOT throw — the queue was still dispatched
      const run = await start(validWorkflow, [42], {
        specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
      });
      expect(run.runId).toMatch(/^wrun_/);

      // Queue should have been called with runInput
      expect(mockQueue).toHaveBeenCalledTimes(1);
      const [, queuePayload] = mockQueue.mock.calls[0];
      expect(queuePayload.runInput).toBeDefined();
      expect(queuePayload.runInput.deploymentId).toBe('deploy_123');
      expect(queuePayload.runInput.workflowName).toBe('test-workflow');
      expect(queuePayload.runInput.specVersion).toBe(
        SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT
      );
    });

    it('wraps queue failures in WorkflowStartError even if events.create succeeds', async () => {
      const mockEventsCreate = vi.fn().mockResolvedValue({
        run: { runId: 'wrun_test', status: 'pending' },
      });
      const queueError = new Error('Queue unavailable');
      const mockQueue = vi.fn().mockRejectedValue(queueError);

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(start(validWorkflow, [])).rejects.toMatchObject({
        name: 'WorkflowStartError',
        stage: 'queue',
        queued: 'unknown',
        cause: queueError,
        runId: expect.stringMatching(/^wrun_/),
      });
    });

    it('should throw when events.create fails with a non-retryable error (e.g. 400)', async () => {
      const badRequest = new WorkflowWorldError('Bad Request', {
        status: 400,
      });
      const mockEventsCreate = vi.fn().mockRejectedValue(badRequest);
      const mockQueue = vi.fn().mockResolvedValue({ messageId: null });

      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      });

      await expect(start(validWorkflow, [])).rejects.toThrow('Bad Request');
    });
  });

  describe('overload type inference', () => {
    // Type-only assertions that don't execute start() at runtime.
    // We use expectTypeOf on the function signature's return type directly.

    type TypedWf = WorkflowFunction<[string, number], boolean>;
    type ZeroArgWf = WorkflowFunction<[], string>;
    type Meta = { workflowId: string };

    it('should preserve types without deploymentId', () => {
      // With args
      expectTypeOf<
        (wf: TypedWf, args: [string, number]) => Promise<Run<boolean>>
      >().toMatchTypeOf<typeof start>();

      // Zero-arg workflow without args
      expectTypeOf(start<string>)
        .parameter(0)
        .toMatchTypeOf<ZeroArgWf | Meta>();
    });

    it('should return Run<unknown> when deploymentId is provided', () => {
      // Typed workflow with deploymentId - return type becomes Run<unknown>
      type StartWithDeploymentId = (
        wf: TypedWf | Meta,
        args: unknown[],
        opts: { deploymentId: string }
      ) => Promise<Run<unknown>>;
      expectTypeOf<StartWithDeploymentId>().toMatchTypeOf<typeof start>();
    });

    it('should accept typed workflows with deploymentId (no contravariance issue)', () => {
      // This is the key test: a typed workflow should be assignable to the
      // deploymentId overload. We verify by checking the first parameter
      // accepts TypedWf.
      type DeploymentIdOverload = <TArgs extends unknown[], TResult>(
        wf: WorkflowFunction<TArgs, TResult> | Meta,
        args: unknown[],
        opts: { deploymentId: string }
      ) => Promise<Run<unknown>>;
      expectTypeOf<DeploymentIdOverload>().toMatchTypeOf<typeof start>();
    });
  });
});
