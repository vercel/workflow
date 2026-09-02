import {
  ANALYTICS_EVENTS_GET_MANY_LIMIT,
  ANALYTICS_MAX_ATTRIBUTE_FILTERS,
  ANALYTICS_PAGE_LIMIT,
  ANALYTICS_RUN_SCOPED_PAGE_LIMIT,
  type Analytics,
  AnalyticsAttributeKeySchema,
  AnalyticsEventSchema,
  AnalyticsHookSchema,
  type AnalyticsListAttributesParams,
  AnalyticsRunSchema,
  AnalyticsStepSchema,
  AnalyticsWaitSchema,
  ATTRIBUTE_KEY_MAX_LENGTH,
  ATTRIBUTE_VALUE_MAX_BYTES,
  AttributeKeySchema,
  AttributeValueSchema,
  PaginatedResponseSchema,
  type PaginationOptions,
} from '@workflow/world';
import type { APIConfig } from './utils.js';
import { makeRequest } from './utils.js';

/**
 * Body of a prefixed workflow ULID: the tag-shifted first character followed
 * by 25 Crockford-Base32 digits.
 *
 * Every id below is matched against this rather than against
 * `workflowRunIdSchema`, whose `z.ulid()` accepts a lowercase body and a
 * first character outside the tagged `0-7` range. The backend accepts
 * neither, so validating run ids that way let exactly the arguments this
 * guard exists to catch through to a 400.
 */
const ULID_BODY = '[01234567][0123456789ABCDEFGHJKMNPQRSTVWXYZ]{25}';

const RUN_ID_PATTERN = new RegExp(`^wrun_${ULID_BODY}$`);

/**
 * Correlation-id prefixes the analytics event listings accept, mirroring the
 * backend's `CorrelationIdSchema` union (step / hook / wait / attribute).
 * An event's correlation id is always one of these four entity ids.
 */
const CORRELATION_ID_PATTERN = new RegExp(
  `^(?:step|hook|wait|attr)_${ULID_BODY}$`
);

const EVENT_ID_PATTERN = new RegExp(`^evnt_${ULID_BODY}$`);

const STEP_ID_PATTERN = new RegExp(`^step_${ULID_BODY}$`);

const HOOK_ID_PATTERN = new RegExp(`^hook_${ULID_BODY}$`);

const WAIT_ID_PATTERN = new RegExp(`^wait_${ULID_BODY}$`);

/**
 * Reject a page size the backend would reject, before the request is sent.
 *
 * `maxLimit` is a required parameter rather than a default so that a new
 * listing cannot be added without stating which cap applies to it — the caps
 * differ per endpoint and silently inheriting the wrong one is the mistake
 * this guard exists to prevent.
 */
function assertPageLimit(limit: number, maxLimit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new RangeError(
      `pagination.limit must be an integer between 1 and ${maxLimit} (received ${limit})`
    );
  }
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new RangeError(
      `runId must be a workflow run id ('wrun_' followed by a ULID), received ${JSON.stringify(runId)}`
    );
  }
}

function assertCorrelationId(correlationId: string): void {
  if (!CORRELATION_ID_PATTERN.test(correlationId)) {
    throw new RangeError(
      `correlationId must be a step, hook, wait, or attribute id, received ${JSON.stringify(correlationId)}`
    );
  }
}

function assertEventId(eventId: string): void {
  if (!EVENT_ID_PATTERN.test(eventId)) {
    throw new RangeError(
      `eventId must be an event id ('evnt_' followed by a ULID), received ${JSON.stringify(eventId)}`
    );
  }
}

function assertStepId(stepId: string): void {
  if (!STEP_ID_PATTERN.test(stepId)) {
    throw new RangeError(
      `stepId must be a step id ('step_' followed by a ULID), received ${JSON.stringify(stepId)}`
    );
  }
}

function assertHookId(hookId: string): void {
  if (!HOOK_ID_PATTERN.test(hookId)) {
    throw new RangeError(
      `hookId must be a hook id ('hook_' followed by a ULID), received ${JSON.stringify(hookId)}`
    );
  }
}

function assertWaitId(waitId: string): void {
  if (!WAIT_ID_PATTERN.test(waitId)) {
    throw new RangeError(
      `waitId must be a wait id ('wait_' followed by a ULID), received ${JSON.stringify(waitId)}`
    );
  }
}

/**
 * Validate an attribute prefilter against the same bounds the backend applies:
 * between 1 and {@link ANALYTICS_MAX_ATTRIBUTE_FILTERS} pairs, keys and values
 * within the shared attribute limits.
 *
 * Reserved `$`-prefixed keys are deliberately allowed. Writing them is
 * rejected, but filtering by them is how a caller finds a run by
 * `$parentRunId` or `$rootRunId`, so `AttributeKeySchema` (which bounds
 * length only) is the right check here rather than the write-path validator.
 */
function assertAttributeFilters(attributes: Record<string, string>): void {
  const entries = Object.entries(attributes);
  if (entries.length > ANALYTICS_MAX_ATTRIBUTE_FILTERS) {
    throw new RangeError(
      `attributes may filter by at most ${ANALYTICS_MAX_ATTRIBUTE_FILTERS} pairs (received ${entries.length})`
    );
  }
  for (const [key, value] of entries) {
    if (!AttributeKeySchema.safeParse(key).success) {
      throw new RangeError(
        `attributes key must be 1 to ${ATTRIBUTE_KEY_MAX_LENGTH} characters, received ${JSON.stringify(key)}`
      );
    }
    if (!AttributeValueSchema.safeParse(value).success) {
      throw new RangeError(
        `attributes value for ${JSON.stringify(key)} must be at most ${ATTRIBUTE_VALUE_MAX_BYTES} UTF-8 bytes`
      );
    }
  }
}

/**
 * Validate the optional `startTime`/`endTime` window.
 *
 * The two are only meaningful together, and the caller that supplies one
 * without the other has a bug: the backend rejects that pair, but the
 * querystring builders used to drop a lone bound silently, turning a
 * mistakenly-unbounded listing into a full-retention scan that looks like a
 * successful answer. Fail instead.
 */
function assertDateWindow(startTime?: string, endTime?: string): void {
  if (startTime === undefined && endTime === undefined) return;
  if (startTime === undefined || endTime === undefined) {
    throw new RangeError(
      'startTime and endTime must be provided together, or both omitted'
    );
  }
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (!Number.isFinite(start)) {
    throw new RangeError(
      `startTime must be a parseable datetime, received ${JSON.stringify(startTime)}`
    );
  }
  if (!Number.isFinite(end)) {
    throw new RangeError(
      `endTime must be a parseable datetime, received ${JSON.stringify(endTime)}`
    );
  }
  if (start > end) {
    throw new RangeError('startTime must be before or equal to endTime');
  }
}

function appendPagination(
  params: URLSearchParams,
  pagination: PaginationOptions | undefined,
  maxLimit: number
): void {
  // Compared against undefined rather than tested for truthiness: `limit: 0`
  // is invalid, and dropping it silently handed back the backend's default
  // page instead of surfacing the caller's bug.
  if (pagination?.limit !== undefined) {
    assertPageLimit(pagination.limit, maxLimit);
    params.set('limit', pagination.limit.toString());
  }
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
  // Checked after the cardinality bounds: a caller that passed the wrong
  // collection entirely gets the more useful message first.
  for (const eventId of uniqueEventIds) assertEventId(eventId);
  return uniqueEventIds;
}

function appendAttributeListParams(
  searchParams: URLSearchParams,
  params: AnalyticsListAttributesParams
): void {
  assertDateWindow(params.startTime, params.endTime);
  if (params.workflowName !== undefined) {
    searchParams.set('workflowName', params.workflowName);
  }
  if (params.startTime !== undefined && params.endTime !== undefined) {
    searchParams.set('startTime', params.startTime);
    searchParams.set('endTime', params.endTime);
  }
  appendPagination(searchParams, params.pagination, ANALYTICS_PAGE_LIMIT);
}

export function createAnalytics(config?: APIConfig): Analytics {
  return {
    runs: {
      get(runId) {
        assertRunId(runId);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}`,
          config,
          schema: AnalyticsRunSchema,
        });
      },
      list(params = {}) {
        assertDateWindow(params.startTime, params.endTime);

        const searchParams = new URLSearchParams();
        if (params.workflowName !== undefined) {
          searchParams.set('workflowName', params.workflowName);
        }
        if (params.status) {
          searchParams.set('status', params.status);
        }
        if (params.startTime !== undefined && params.endTime !== undefined) {
          searchParams.set('startTime', params.startTime);
          searchParams.set('endTime', params.endTime);
        }
        if (params.attributes && Object.keys(params.attributes).length > 0) {
          assertAttributeFilters(params.attributes);
          // JSON-encoded rather than repeated key=value pairs: attribute
          // keys and values are arbitrary user strings that may themselves
          // contain `=` or `,`.
          searchParams.set('attributes', JSON.stringify(params.attributes));
        }
        appendPagination(searchParams, params.pagination, ANALYTICS_PAGE_LIMIT);

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
        assertRunId(runId);
        assertStepId(stepId);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}`,
          config,
          schema: AnalyticsStepSchema,
        });
      },
      list(params) {
        assertRunId(params.runId);

        const searchParams = new URLSearchParams();
        appendPagination(
          searchParams,
          params.pagination,
          ANALYTICS_RUN_SCOPED_PAGE_LIMIT
        );

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/steps${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsStepSchema),
        });
      },
    },
    events: {
      get(runId, eventId) {
        assertRunId(runId);
        assertEventId(eventId);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/events/${encodeURIComponent(eventId)}`,
          config,
          schema: AnalyticsEventSchema,
        });
      },
      getMany(runId, eventIds) {
        assertRunId(runId);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/events/get-many`,
          options: { method: 'POST' },
          data: { eventIds: normalizeEventIds(eventIds) },
          config,
          schema: AnalyticsEventSchema.array(),
        });
      },
      list(params) {
        assertRunId(params.runId);

        const searchParams = new URLSearchParams();
        if (params.eventType) {
          searchParams.set('eventType', params.eventType);
        }
        if (params.correlationId !== undefined) {
          assertCorrelationId(params.correlationId);
          searchParams.set('correlationId', params.correlationId);
        }
        appendPagination(
          searchParams,
          params.pagination,
          ANALYTICS_RUN_SCOPED_PAGE_LIMIT
        );

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/events${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsEventSchema),
        });
      },
      /**
       * @deprecated Use `list({ runId, correlationId })`. Kept as its own
       * implementation rather than delegating: `list` treats
       * `correlationId` as optional and skips an empty one, where this
       * method requires it, so a delegation would turn an empty id into an
       * unfiltered listing of the run.
       */
      listByCorrelationId(params) {
        assertRunId(params.runId);
        assertCorrelationId(params.correlationId);

        const searchParams = new URLSearchParams();
        searchParams.set('correlationId', params.correlationId);
        appendPagination(
          searchParams,
          params.pagination,
          ANALYTICS_RUN_SCOPED_PAGE_LIMIT
        );

        // A correlation id is unique per run, not globally: a slot-numbered
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
        assertHookId(hookId);

        const searchParams = new URLSearchParams();
        if (params?.runId !== undefined) {
          assertRunId(params.runId);
          searchParams.set('runId', params.runId);
        }

        return makeRequest({
          endpoint: `/v2/analytics/hooks/${encodeURIComponent(hookId)}${createQueryString(searchParams)}`,
          config,
          schema: AnalyticsHookSchema,
        });
      },
      list(params) {
        assertRunId(params.runId);

        const searchParams = new URLSearchParams();
        searchParams.set('runId', params.runId);
        appendPagination(searchParams, params.pagination, ANALYTICS_PAGE_LIMIT);

        return makeRequest({
          endpoint: `/v2/analytics/hooks${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsHookSchema),
        });
      },
    },
    waits: {
      get(runId, waitId) {
        assertRunId(runId);
        assertWaitId(waitId);

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(runId)}/waits/${encodeURIComponent(waitId)}`,
          config,
          schema: AnalyticsWaitSchema,
        });
      },
      list(params) {
        assertRunId(params.runId);

        const searchParams = new URLSearchParams();
        if (params.status) {
          searchParams.set('status', params.status);
        }
        appendPagination(
          searchParams,
          params.pagination,
          ANALYTICS_RUN_SCOPED_PAGE_LIMIT
        );

        return makeRequest({
          endpoint: `/v2/analytics/runs/${encodeURIComponent(params.runId)}/waits${createQueryString(searchParams)}`,
          config,
          schema: PaginatedResponseSchema(AnalyticsWaitSchema),
        });
      },
    },
  };
}
