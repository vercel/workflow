import { WorkflowRuntimeError, WorkflowWorldError } from '@workflow/errors';
import {
  SPEC_VERSION_CURRENT,
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

    beforeEach(() => {
      mockEventsCreate = vi.fn().mockImplementation((runId) => {
        return Promise.resolve({
          run: { runId: runId ?? 'wrun_test123', status: 'pending' },
        });
      });
      mockQueue = vi.fn().mockResolvedValue(undefined);

      setWorld({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);
    });

    afterEach(() => {
      setWorld(undefined);
      vi.clearAllMocks();
    });

    it('should use world.specVersion when available, falling back to SPEC_VERSION_SUPPORTS_EVENT_SOURCING', async () => {
      const validWorkflow = Object.assign(() => Promise.resolve('result'), {
        workflowId: 'test-workflow',
      });

      // Mock world without specVersion → falls back to safe baseline (v2)
      await start(validWorkflow, []);

      expect(mockEventsCreate).toHaveBeenCalledWith(
        expect.stringMatching(/^wrun_/),
        expect.objectContaining({
          eventType: 'run_created',
          specVersion: SPEC_VERSION_SUPPORTS_EVENT_SOURCING,
        }),
        expect.objectContaining({
          v1Compat: false,
        })
      );

      vi.clearAllMocks();

      // Mock world with specVersion 3 → uses it
      setWorld({
        specVersion: SPEC_VERSION_CURRENT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await start(validWorkflow, [], { attributes: { tenant: 't1' } });

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
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
        specVersion: SPEC_VERSION_SUPPORTS_ATTRIBUTES,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
        getDeploymentId: vi.fn().mockResolvedValue('deploy_resolved'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      } as any);
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
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      } as any);

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
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      } as any);

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
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        // No resolveLatestDeploymentId
      } as any);

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
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        // No resolveLatestDeploymentId
      } as any);

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
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      } as any);

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
        getDeploymentId: vi.fn().mockResolvedValue('dpl_default_789'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        resolveLatestDeploymentId: mockResolveLatest,
      } as any);

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
        // World declares specVersion 3 to enable CBOR queue transport + runInput
        specVersion: SPEC_VERSION_SUPPORTS_CBOR_QUEUE_TRANSPORT,
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      // start() should NOT throw — the queue was still dispatched
      const run = await start(validWorkflow, [42]);
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

    it('should throw when queue fails even if events.create succeeds', async () => {
      const mockEventsCreate = vi.fn().mockResolvedValue({
        run: { runId: 'wrun_test', status: 'pending' },
      });
      const mockQueue = vi
        .fn()
        .mockRejectedValue(new Error('Queue unavailable'));

      setWorld({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

      await expect(start(validWorkflow, [])).rejects.toThrow(
        'Queue unavailable'
      );
    });

    it('should throw when events.create fails with a non-retryable error (e.g. 400)', async () => {
      const badRequest = new WorkflowWorldError('Bad Request', {
        status: 400,
      });
      const mockEventsCreate = vi.fn().mockRejectedValue(badRequest);
      const mockQueue = vi.fn().mockResolvedValue({ messageId: null });

      setWorld({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);

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
