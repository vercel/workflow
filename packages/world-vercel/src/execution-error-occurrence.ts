import {
  ReportWorkflowExecutionErrorOccurrenceRequestSchema,
  ReportWorkflowExecutionErrorOccurrenceResponseSchema,
  type ReportWorkflowExecutionErrorOccurrenceRequest,
  type ReportWorkflowExecutionErrorOccurrenceResponse,
} from '@workflow/world';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

export function createExecutionErrorOccurrences(config?: APIConfig) {
  return {
    executionErrors: {
      async reportOccurrence(
        runId: string,
        data: ReportWorkflowExecutionErrorOccurrenceRequest
      ): Promise<ReportWorkflowExecutionErrorOccurrenceResponse> {
        return makeRequest({
          endpoint: `/v2/runs/${runId}/execution-error-occurrences`,
          options: { method: 'POST' },
          data: ReportWorkflowExecutionErrorOccurrenceRequestSchema.parse(data),
          config,
          schema: ReportWorkflowExecutionErrorOccurrenceResponseSchema,
        });
      },
    },
  };
}
