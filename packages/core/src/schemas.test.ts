import { describe, expect, it } from 'vitest';
import type { StepInvokePayload, WorkflowInvokePayload } from './schemas';

describe('Schema Types', () => {
  describe('WorkflowInvokePayload', () => {
    it('should accept valid workflow invoke payload', () => {
      const payload: WorkflowInvokePayload = {
        runId: 'test-run-123',
        traceCarrier: {
          traceparent:
            '00-00000000000000000000000000000000-0000000000000000-00',
          tracestate: 'ro=00000000000000000000000000000000',
        },
      };

      expect(payload.runId).toBe('test-run-123');
      expect(payload.traceCarrier).toBeDefined();
    });
  });

  describe('StepInvokePayload', () => {
    it('should extend WorkflowInvokePayload with step-specific fields', () => {
      const payload: StepInvokePayload = {
        workflowRunId: 'test-run-123',
        workflowStartedAt: Date.now(),
        workflowName: 'test-workflow',
        stepId: 'test-step',
      };

      expect(payload.workflowRunId).toBe('test-run-123');
      expect(payload.stepId).toBe('test-step');
      expect(payload.workflowStartedAt).toBeDefined();
      expect(payload.workflowName).toBe('test-workflow');
    });
  });
});
