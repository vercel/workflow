import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  makeRequest: vi.fn(),
}));

vi.mock('./utils.js', () => ({
  makeRequest: state.makeRequest,
}));

const { createAnalytics } = await import('./analytics.js');

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
