import {
  ANALYTICS_EVENTS_GET_MANY_LIMIT,
  type Analytics,
  AnalyticsAttributeKeySchema,
  AnalyticsEventSchema,
  AnalyticsHookSchema,
  type AnalyticsListAttributesParams,
  AnalyticsRunSchema,
  AnalyticsStepSchema,
  AnalyticsWaitSchema,
  PaginatedResponseSchema,
  type PaginationOptions,
} from '@workflow/world';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

function appendPagination(
  params: URLSearchParams,
  pagination: PaginationOptions | undefined
): void {
  if (pagination?.limit) params.set('limit', pagination.limit.toString());
  if (pagination?.cursor) params.set('cursor', pagination.cursor);
  if (pagination?.sortOrder) params.set('sortOrder', pagination.sortOrder);
}

function createQueryString(params: URLSearchParams): string {
  const query = params.toString();
  return query ? `?${query}` : '';
}

function normalizeEventIds(eventIds: readonly string[]): string[] {
  const uniqueEventIds = [...new Set(eventIds)];
  if (uniqueEventIds.length === 0) {
    throw new RangeError('eventIds must contain at least one event ID');
  }
  if (uniqueEventIds.length > ANALYTICS_EVENTS_GET_MANY_LIMIT) {
    throw new RangeError(
      `eventIds must contain at most ${ANALYTICS_EVENTS_GET_MANY_LIMIT} unique event IDs`
    );
  }
  return uniqueEventIds;
}

function appendAttributeListParams(
  searchParams: URLSearchParams,
  params: AnalyticsListAttributesParams
): void {
  if (params.workflowName) {
    searchParams.set('workflowName', params.workflowName);
  }
  if (params.startTime && params.endTime) {
    searchParams.set('startTime', params.startTime);
    searchParams.set('endTime', params.endTime);
  }
  appendPagination(searchParams, params.pagination);
}

export function createAnalytics(config?: APIConfig): Analytics {
  return {
    runs: {
      get(runId) {
        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}`,
          config,
          schema: AnalyticsRunSchema,
        });
      },
      list(params = {}) {
        const searchParams = new URLSearchParams();
        if (params.workflowName) {
          searchParams.set('workflowName', params.workflowName);
        }
        if (params.status) {
          searchParams.set('status', params.status);
        }
        if (params.startTime && params.endTime) {
          searchParams.set('startTime', params.startTime);
          searchParams.set('endTime', params.endTime);
        }
        if (params.attributes && Object.keys(params.attributes).length > 0) {
          // JSON-encoded rather than repeated key=value pairs: attribute
          // keys and values are arbitrary user strings that may themselves
          // contain `=` or `,`.
          searchParams.set('attributes', JSON.stringify(params.attributes));
        }
        appendPagination(searchParams, params.pagination);

        return makeRequest({
          endpoint: `/v2/analytics/runs${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsRunSchema),
        });
      },
    },
    attributes: {
      list(params = {}) {
        const searchParams = new URLSearchParams();
        appendAttributeListParams(searchParams, params);

        return makeRequest({
          endpoint: `/v2/analytics/attributes${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsAttributeKeySchema),
        });
      },
    },
    steps: {
      get(runId, stepId) {
        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`,
          config,
          schema: AnalyticsStepSchema,
        });
      },
      list(params) {
        const searchParams = new URLSearchParams();
        appendPagination(searchParams, params.pagination);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/steps${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsStepSchema),
        });
      },
    },
    events: {
      get(runId, eventId) {
        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(eventId)}`,
          config,
          schema: AnalyticsEventSchema,
        });
      },
      getMany(runId, eventIds) {
        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/events/get-many`,
          options: { method: 'POST' },
          data: { eventIds: normalizeEventIds(eventIds) },
          config,
          schema: AnalyticsEventSchema.array(),
        });
      },
      list(params) {
        const searchParams = new URLSearchParams();
        if (params.eventType) {
          searchParams.set('eventType', params.eventType);
        }
        if (params.correlationId) {
          searchParams.set('correlationId', params.correlationId);
        }
        appendPagination(searchParams, params.pagination);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/events${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsEventSchema),
        });
      },
      listByCorrelationId(params) {
        const searchParams = new URLSearchParams();
        searchParams.set('correlationId', params.correlationId);
        appendPagination(searchParams, params.pagination);

        // A correlation id is unique per run, not globally — a slot-numbered
        // run numbers its own steps, so `step_…001` names the first step of
        // every such run. The run-scoped endpoint takes the same
        // correlation-id filter, so scoping costs nothing here.
        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/events${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsEventSchema),
        });
      },
    },
    hooks: {
      get(hookId, params) {
        const searchParams = new URLSearchParams();
        if (params?.runId) {
          searchParams.set('runId', params.runId);
        }

        return makeRequest({
          endpoint: `/v2/analytics/hooks/${encodeURIComponent(hookId)}${createQueryString(searchParams)}`,
          config,
          schema: AnalyticsHookSchema,
        });
      },
      list(params) {
        const searchParams = new URLSearchParams();
        searchParams.set('runId', params.runId);
        appendPagination(searchParams, params.pagination);

        return makeRequest({
          endpoint: `/v2/analytics/hooks${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsHookSchema),
        });
      },
    },
    waits: {
      get(runId, waitId) {
        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/waits/${encodeURIComponent(waitId)}`,
          config,
          schema: AnalyticsWaitSchema,
        });
      },
      list(params) {
        const searchParams = new URLSearchParams();
        if (params.status) {
          searchParams.set('status', params.status);
        }
        appendPagination(searchParams, params.pagination);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/waits${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsWaitSchema),
        });
      },
    },
  };
}
