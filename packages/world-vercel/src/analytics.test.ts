import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  makeRequest: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  makeRequest: state.makeRequest,
}));

const { createAnalytics } = await import('./analytics.js');

const RUN_ID = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';
const EVENT_ID_A = 'evnt_01K4BZQ7X9M3NPVR2GHTD8CWFY';
const EVENT_ID_B = 'evnt_01K4BZQ8M2P5RQWX7YKTN3FGDB';
const STEP_ID = 'step_01K4BZQ6M1P4RQWX8YKTN2FGDB';
const HOOK_ID = 'hook_01K4BZQ9N3Q6SRXY8ZMVP4GHEC';
const WAIT_ID = 'wait_01K4BZQAP4R7TSYZ9NWQR5HJFD';

const eventRow = {
  runId: RUN_ID,
  eventId: EVENT_ID_A,
  eventType: 'run_started',
  workflowName: 'test-workflow',
  deploymentId: 'dpl_1',
  runCreatedAt: '2026-07-13 17:09:11.000',
  createdAt: '2026-07-13 17:09:11.593',
  vercelId: 'request-grain-id',
  requestId: 'sibling-request-column',
  computeInstanceId: 'compute-instance-id',
};

describe('createAnalytics events.getMany', () => {
  beforeEach(() => {
    state.makeRequest.mockReset();
    state.makeRequest.mockResolvedValue([eventRow]);
  });

  it('posts one deduplicated batch and parses analytics provenance', async () => {
    const analytics = createAnalytics();
    await expect(
      analytics.events.getMany(RUN_ID, [EVENT_ID_A, EVENT_ID_A, EVENT_ID_B])
    ).resolves.toEqual([eventRow]);

    const request = state.makeRequest.mock.calls[0][0];
    expect(request.endpoint).toBe(
      `/v2/analytics/runs/${RUN_ID}/events/get-many`
    );
    expect(request.options).toEqual({ method: 'POST' });
    expect(request.data).toEqual({ eventIds: [EVENT_ID_A, EVENT_ID_B] });
    expect(request.schema.parse([eventRow])).toMatchObject([
      {
        vercelId: 'request-grain-id',
        requestId: 'sibling-request-column',
        computeInstanceId: 'compute-instance-id',
      },
    ]);
    expect(state.makeRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects empty and over-limit batches without a request', () => {
    const analytics = createAnalytics();
    expect(() => analytics.events.getMany(RUN_ID, [])).toThrow('at least one');
    expect(() =>
      analytics.events.getMany(
        RUN_ID,
        Array.from({ length: 101 }, () => EVENT_ID_A).map(
          (id, index) => `${id.slice(0, -3)}${String(index).padStart(3, '0')}`
        )
      )
    ).toThrow('at most 100');
    expect(state.makeRequest).not.toHaveBeenCalled();
  });
});

describe('createAnalytics attributes', () => {
  beforeEach(() => {
    state.makeRequest.mockReset();
    state.makeRequest.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
  });

  it('serializes attribute filters on runs.list as a JSON query param', async () => {
    const analytics = createAnalytics();
    await analytics.runs.list({
      attributes: { team: 'growth', '$eve.type': 'session' },
    });

    const { endpoint } = state.makeRequest.mock.calls[0][0];
    expect(endpoint).toBe(
      `/v2/analytics/runs?attributes=${encodeURIComponent(
        JSON.stringify({ team: 'growth', '$eve.type': 'session' })
      )}`
    );
  });

  it('omits the attributes param when the filter object is empty', async () => {
    const analytics = createAnalytics();
    await analytics.runs.list({ attributes: {} });

    const { endpoint } = state.makeRequest.mock.calls[0][0];
    expect(endpoint).toBe('/v2/analytics/runs');
  });

  it('lists attribute keys with filters and pagination', async () => {
    const analytics = createAnalytics();
    await analytics.attributes.list({
      workflowName: 'daily-report',
      startTime: '2026-06-20T00:00:00.000Z',
      endTime: '2026-06-21T00:00:00.000Z',
      pagination: { limit: 25, cursor: 'abc', sortOrder: 'asc' },
    });

    const { endpoint } = state.makeRequest.mock.calls[0][0];
    const url = new URL(endpoint, 'https://example.test');
    expect(url.pathname).toBe('/v2/analytics/attributes');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      workflowName: 'daily-report',
      startTime: '2026-06-20T00:00:00.000Z',
      endTime: '2026-06-21T00:00:00.000Z',
      limit: '25',
      cursor: 'abc',
      sortOrder: 'asc',
    });
  });
});

describe('createAnalytics events input guards', () => {
  beforeEach(() => {
    state.makeRequest.mockReset();
    state.makeRequest.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
  });

  it('accepts the run-scoped cap of 1000 on events.list', async () => {
    const analytics = createAnalytics();
    await analytics.events.list({
      runId: RUN_ID,
      pagination: { limit: 1000 },
    });

    const { endpoint } = state.makeRequest.mock.calls[0][0];
    expect(
      new URL(endpoint, 'https://example.test').searchParams.get('limit')
    ).toBe('1000');
  });

  it.each([
    ['over the cap', 1001],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s limit without a request', (_label, limit) => {
    const analytics = createAnalytics();
    expect(() =>
      analytics.events.list({ runId: RUN_ID, pagination: { limit } })
    ).toThrow('pagination.limit must be an integer between 1 and 1000');
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  // The cross-run listings are capped an order of magnitude lower, so the
  // page size that is valid on events.list must still be refused here.
  it('rejects a 1000 limit on runs.list, which caps at 100', () => {
    const analytics = createAnalytics();
    expect(() => analytics.runs.list({ pagination: { limit: 1000 } })).toThrow(
      'pagination.limit must be an integer between 1 and 100'
    );
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('rejects a malformed runId on every events method', () => {
    const analytics = createAnalytics();
    expect(() => analytics.events.list({ runId: 'not-a-run' })).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.events.get('wrun/1', EVENT_ID_A)).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.events.getMany('', [EVENT_ID_A])).toThrow(
      'runId must be a workflow run id'
    );
    expect(() =>
      analytics.events.listByCorrelationId({
        runId: 'wrun_short',
        correlationId: STEP_ID,
      })
    ).toThrow('runId must be a workflow run id');
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('rejects a correlationId that is not a step, hook, wait, or attribute id', () => {
    const analytics = createAnalytics();
    expect(() =>
      analytics.events.list({ runId: RUN_ID, correlationId: 'step-1' })
    ).toThrow('correlationId must be a step, hook, wait, or attribute id');
    expect(() =>
      analytics.events.listByCorrelationId({
        runId: RUN_ID,
        correlationId: EVENT_ID_A,
      })
    ).toThrow('correlationId must be a step, hook, wait, or attribute id');
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('accepts each correlation-id flavour the backend allows', async () => {
    const analytics = createAnalytics();
    for (const prefix of ['step', 'hook', 'wait', 'attr']) {
      await analytics.events.list({
        runId: RUN_ID,
        correlationId: `${prefix}_${STEP_ID.slice(5)}`,
      });
    }
    expect(state.makeRequest).toHaveBeenCalledTimes(4);
  });

  it('rejects a malformed eventId on get and getMany', () => {
    const analytics = createAnalytics();
    expect(() => analytics.events.get(RUN_ID, 'evnt_1')).toThrow(
      "eventId must be an event id ('evnt_' followed by a ULID)"
    );
    expect(() =>
      analytics.events.getMany(RUN_ID, [EVENT_ID_A, 'nope'])
    ).toThrow("eventId must be an event id ('evnt_' followed by a ULID)");
    expect(state.makeRequest).not.toHaveBeenCalled();
  });
});

describe('createAnalytics runs and steps input guards', () => {
  beforeEach(() => {
    state.makeRequest.mockReset();
    state.makeRequest.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
  });

  it('rejects a malformed runId and stepId', () => {
    const analytics = createAnalytics();
    expect(() => analytics.runs.get('nope')).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.steps.list({ runId: 'wrun_short' })).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.steps.get('nope', STEP_ID)).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.steps.get(RUN_ID, 'step-1')).toThrow(
      "stepId must be a step id ('step_' followed by a ULID)"
    );
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  // runs.list caps an order of magnitude lower than the run-scoped listings.
  it('applies the cross-run cap to runs.list and the run-scoped cap to steps.list', async () => {
    const analytics = createAnalytics();
    expect(() => analytics.runs.list({ pagination: { limit: 101 } })).toThrow(
      'pagination.limit must be an integer between 1 and 100'
    );
    await analytics.steps.list({ runId: RUN_ID, pagination: { limit: 1000 } });
    expect(state.makeRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects a half-open date window instead of dropping it', () => {
    const analytics = createAnalytics();
    for (const window of [
      { startTime: '2026-06-20T00:00:00.000Z' },
      { endTime: '2026-06-21T00:00:00.000Z' },
    ]) {
      expect(() => analytics.runs.list(window)).toThrow(
        'startTime and endTime must be provided together'
      );
      expect(() => analytics.attributes.list(window)).toThrow(
        'startTime and endTime must be provided together'
      );
    }
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('rejects an unparseable or inverted date window', () => {
    const analytics = createAnalytics();
    expect(() =>
      analytics.runs.list({ startTime: 'yesterday', endTime: 'today' })
    ).toThrow('startTime must be a parseable datetime');
    expect(() =>
      analytics.runs.list({
        startTime: '2026-06-21T00:00:00.000Z',
        endTime: '2026-06-20T00:00:00.000Z',
      })
    ).toThrow('startTime must be before or equal to endTime');
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('sends a complete date window', async () => {
    const analytics = createAnalytics();
    await analytics.runs.list({
      startTime: '2026-06-20T00:00:00.000Z',
      endTime: '2026-06-21T00:00:00.000Z',
    });

    const { endpoint } = state.makeRequest.mock.calls[0][0];
    const url = new URL(endpoint, 'https://example.test');
    expect(url.searchParams.get('startTime')).toBe('2026-06-20T00:00:00.000Z');
    expect(url.searchParams.get('endTime')).toBe('2026-06-21T00:00:00.000Z');
  });

  it('rejects an attribute filter above the pair cap', () => {
    const analytics = createAnalytics();
    const attributes = Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`key${i}`, 'v'])
    );
    expect(() => analytics.runs.list({ attributes })).toThrow(
      'attributes may filter by at most 8 pairs'
    );
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('rejects an over-long attribute key or value', () => {
    const analytics = createAnalytics();
    expect(() =>
      analytics.runs.list({ attributes: { ['k'.repeat(257)]: 'v' } })
    ).toThrow('attributes key must be 1 to 256 characters');
    expect(() =>
      analytics.runs.list({ attributes: { team: 'v'.repeat(257) } })
    ).toThrow('must be at most 256 UTF-8 bytes');
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  // `$`-prefixed keys are rejected on write but are the documented way to
  // filter by parent/root run, so the filter guard must let them through.
  it('accepts reserved $-prefixed keys and an empty filter object', async () => {
    const analytics = createAnalytics();
    await analytics.runs.list({ attributes: { $parentRunId: RUN_ID } });
    await analytics.runs.list({ attributes: {} });
    expect(state.makeRequest).toHaveBeenCalledTimes(2);
  });
});

describe('createAnalytics hooks and waits input guards', () => {
  beforeEach(() => {
    state.makeRequest.mockReset();
    state.makeRequest.mockResolvedValue({
      data: [],
      cursor: null,
      hasMore: false,
    });
  });

  it('rejects a malformed hookId and waitId', () => {
    const analytics = createAnalytics();
    expect(() => analytics.hooks.get('hook-1')).toThrow(
      "hookId must be a hook id ('hook_' followed by a ULID)"
    );
    expect(() => analytics.waits.get(RUN_ID, 'wait-1')).toThrow(
      "waitId must be a wait id ('wait_' followed by a ULID)"
    );
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  it('rejects a malformed runId on every run-scoped hooks and waits call', () => {
    const analytics = createAnalytics();
    expect(() => analytics.hooks.list({ runId: 'nope' })).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.waits.list({ runId: 'nope' })).toThrow(
      'runId must be a workflow run id'
    );
    expect(() => analytics.waits.get('nope', WAIT_ID)).toThrow(
      'runId must be a workflow run id'
    );
    expect(state.makeRequest).not.toHaveBeenCalled();
  });

  // hooks.get scopes by run only when asked, so the guard has to be inside
  // that branch rather than at the top of the method.
  it('validates the optional runId scope on hooks.get but does not require it', async () => {
    const analytics = createAnalytics();
    expect(() => analytics.hooks.get(HOOK_ID, { runId: 'nope' })).toThrow(
      'runId must be a workflow run id'
    );

    await analytics.hooks.get(HOOK_ID);
    await analytics.hooks.get(HOOK_ID, { runId: RUN_ID });
    expect(state.makeRequest).toHaveBeenCalledTimes(2);
    expect(state.makeRequest.mock.calls[1][0].endpoint).toBe(
      `/v2/analytics/hooks/${HOOK_ID}?runId=${RUN_ID}`
    );
  });

  // hooks.list is run-scoped by contract but sits at the top level, so it
  // inherits the lower cross-run cap while waits.list gets the run-scoped one.
  it('caps hooks.list at 100 and waits.list at 1000', async () => {
    const analytics = createAnalytics();
    expect(() =>
      analytics.hooks.list({ runId: RUN_ID, pagination: { limit: 101 } })
    ).toThrow('pagination.limit must be an integer between 1 and 100');
    await analytics.waits.list({ runId: RUN_ID, pagination: { limit: 1000 } });
    expect(state.makeRequest).toHaveBeenCalledTimes(1);
  });
});
