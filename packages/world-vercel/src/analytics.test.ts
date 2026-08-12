import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  makeRequest: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  makeRequest: state.makeRequest,
}));

const { createAnalytics } = await import('./analytics.js');

const eventRow = {
  runId: 'wrun_1',
  eventId: 'evnt_1',
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
      analytics.events.getMany('wrun/1', ['evnt_1', 'evnt_1', 'evnt_2'])
    ).resolves.toEqual([eventRow]);

    const request = state.makeRequest.mock.calls[0][0];
    expect(request.endpoint).toBe(
      '/v2/analytics/runs/wrun%2F1/events/get-many'
    );
    expect(request.options).toEqual({ method: 'POST' });
    expect(request.data).toEqual({ eventIds: ['evnt_1', 'evnt_2'] });
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
    expect(() => analytics.events.getMany('wrun_1', [])).toThrow(
      'at least one'
    );
    expect(() =>
      analytics.events.getMany(
        'wrun_1',
        Array.from({ length: 101 }, (_, index) => `evnt_${index}`)
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
