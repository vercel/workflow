import { WorkflowAPIError } from '@workflow/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type Drizzle, Schema } from './drizzle/index.js';
import { createStepsStorage } from './storage.js';

// mock the drizzle instance
const mockDrizzle = {
  select: vi.fn(),
  insert: vi.fn(),
  update: vi.fn(),
} as unknown as Drizzle;

describe('Steps Storage', () => {
  let stepsStorage: ReturnType<typeof createStepsStorage>;

  beforeEach(() => {
    vi.clearAllMocks();
    stepsStorage = createStepsStorage(mockDrizzle);
  });

  describe('get', () => {
    it('should retrieve a step with runId and stepId', async () => {
      const testRunId = 'test-run-123';
      const testStepId = 'step-123';
      const mockStep = {
        runId: testRunId,
        stepId: testStepId,
        stepName: 'test-step',
        status: 'pending',
        input: [],
        attempt: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockSelect = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockStep]),
      };

      (mockDrizzle.select as any).mockReturnValue(mockSelect);

      const result = await stepsStorage.get(testRunId, testStepId);

      expect(result).toEqual(mockStep);
      expect(result).not.toBe(mockStep);
      expect(mockDrizzle.select).toHaveBeenCalledTimes(1);
      expect(mockSelect.from).toHaveBeenCalledWith(Schema.steps);
      expect(mockSelect.where).toHaveBeenCalledTimes(1);
      expect(mockSelect.limit).toHaveBeenCalledWith(1);
      expect(mockDrizzle.update).not.toHaveBeenCalled();
    });

    it('should retrieve a step with only stepId (runId undefined)', async () => {
      const testStepId = 'unique-step-123';
      const mockStep = {
        runId: 'some-run-id',
        stepId: testStepId,
        stepName: 'test-step',
        status: 'pending',
        input: [],
        attempt: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockSelect = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([mockStep]),
      };

      (mockDrizzle.select as any).mockReturnValue(mockSelect);

      const result = await stepsStorage.get(undefined, testStepId);

      expect(result).toEqual(mockStep);
      expect(result).not.toBe(mockStep);
      expect(mockDrizzle.select).toHaveBeenCalledTimes(1);
      expect(mockSelect.from).toHaveBeenCalledWith(Schema.steps);
      expect(mockSelect.where).toHaveBeenCalledTimes(1);
      expect(mockSelect.limit).toHaveBeenCalledWith(1);
      expect(mockDrizzle.update).not.toHaveBeenCalled();
    });

    it('should throw error for nonexistent step', async () => {
      const testRunId = 'test-run-123';
      const testStepId = 'nonexistent-step';

      const mockSelect = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      };

      (mockDrizzle.select as any).mockReturnValue(mockSelect);

      let error: unknown;
      try {
        await stepsStorage.get(testRunId, testStepId);
      } catch (err) {
        error = err;
      }

      expect(error).toBeInstanceOf(WorkflowAPIError);
      const workflowError = error as WorkflowAPIError;
      expect(workflowError.name).toBe('WorkflowAPIError');
      expect(workflowError.message).toBe('Step not found: nonexistent-step');
      expect(workflowError.status).toBe(404);
      expect(mockDrizzle.select).toHaveBeenCalledTimes(1);
      expect(mockSelect.from).toHaveBeenCalledWith(Schema.steps);
      expect(mockSelect.where).toHaveBeenCalledTimes(1);
      expect(mockSelect.limit).toHaveBeenCalledWith(1);
      expect(mockDrizzle.update).not.toHaveBeenCalled();
    });
  });
});
