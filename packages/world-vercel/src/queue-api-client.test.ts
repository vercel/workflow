import { QueueClient } from '@vercel/queue';
import { describe, expect, it } from 'vitest';

// world-vercel logs the outcome of each handoff by wrapping the API client
// that `@vercel/queue` exposes on its `QueueClient` (`observeHandoffOutcomes`
// in queue.ts). That hook is not public API: this test, against the
// installed `@vercel/queue` and not a mock, fails when an upgrade drops it.
describe('@vercel/queue API client hook', () => {
  it('exposes a changeVisibility to wrap on every QueueClient', () => {
    const client = new QueueClient({
      region: 'iad1',
      token: 'test-token',
      deploymentId: 'dpl_test',
    });
    const api = (client as unknown as Record<symbol, unknown>)[
      Symbol.for('@vercel/queue.apiClient')
    ] as { changeVisibility?: unknown } | undefined;
    expect(typeof api?.changeVisibility).toBe('function');
  });
});
