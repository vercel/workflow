import {
  ReportWorkflowObservabilityEventRequestSchema,
  ReportWorkflowObservabilityEventResponseSchema,
  type ReportWorkflowObservabilityEventRequest,
  type ReportWorkflowObservabilityEventResponse,
} from '@workflow/world';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

export function createObservability(config?: APIConfig) {
  return {
    observability: {
      async reportEvent(
        runId: string,
        data: ReportWorkflowObservabilityEventRequest
      ): Promise<ReportWorkflowObservabilityEventResponse> {
        return makeRequest({
          endpoint: `/v2/runs/${runId}/observability-events`,
          options: { method: 'POST' },
          data: ReportWorkflowObservabilityEventRequestSchema.parse(data),
          config,
          schema: ReportWorkflowObservabilityEventResponseSchema,
        });
      },
    },
  };
}
