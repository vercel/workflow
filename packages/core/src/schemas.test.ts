import type { WorkflowInvokePayload } from '@workflow/world';
import { describe, expect, it } from 'vitest';

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
});
