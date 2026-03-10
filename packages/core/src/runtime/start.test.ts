import { WorkflowRuntimeError } from '@workflow/errors';
import { SPEC_VERSION_CURRENT, SPEC_VERSION_LEGACY } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { start } from './start.js';
import { getWorld } from './world.js';

// Mock @vercel/functions
vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

// Mock the world module with all required exports
vi.mock('./world.js', () => ({
  getWorld: vi.fn(),
  getWorldHandlers: vi.fn(() => ({
    createQueueHandler: vi.fn(() => vi.fn()),
  })),
}));

// Mock telemetry
vi.mock('../telemetry.js', () => ({
  serializeTraceCarrier: vi.fn().mockResolvedValue({}),
  trace: vi.fn((_name, fn) => fn(undefined)),
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
        `'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`
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
        `'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`
      );
    });

    it('should throw WorkflowRuntimeError when workflow has no workflowId', async () => {
      const invalidWorkflow = () => Promise.resolve('result');

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        WorkflowRuntimeError
      );

      await expect(start(invalidWorkflow, [])).rejects.toThrow(
        `'start' received an invalid workflow function. Ensure the Workflow Development Kit is configured correctly and the function includes a 'use workflow' directive.`
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

      vi.mocked(getWorld).mockReturnValue({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_123'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
      } as any);
    });

    afterEach(() => {
      vi.clearAllMocks();
    });

    it('should use SPEC_VERSION_CURRENT when specVersion is not provided', async () => {
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

      vi.mocked(getWorld).mockReturnValue({
        getDeploymentId: vi.fn().mockResolvedValue('deploy_resolved'),
        events: { create: mockEventsCreate },
        queue: mockQueue,
        getEncryptionKeyForRun: mockGetEncryptionKeyForRun,
      } as any);
    });

    afterEach(() => {
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
});
