import { WorkflowRuntimeError } from '@workflow/errors';
import { describe, expect, it, vi } from 'vitest';
import { start } from './start.js';

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
});
