import { makeRequest } from '@workflow/world-vercel/actor-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { affinityHeaders, createWorld } from './index.js';

vi.mock('@workflow/world-vercel/actor-client', () => ({
  makeRequest: vi.fn(),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe('affinity delivery configuration', () => {
  it('requires the supplied header name and sends the exact run id', () => {
    expect(affinityHeaders('wrun_123', 'x-test-affinity')).toEqual({
      'x-test-affinity': 'wrun_123',
    });
    expect(() => affinityHeaders('wrun_123', '')).toThrow(
      /platform affinity header/
    );
  });
  it('does not allow configuration to replace authentication or HTTP framing', () => {
    for (const header of [
      'Authorization',
      'Host',
      'Content-Length',
      'Content-Type',
      'bad\nheader',
    ]) {
      expect(() => affinityHeaders('wrun_123', header)).toThrow();
    }
  });
  it('validates the pinned deployment in the adapter before core gets a snapshot', async () => {
    vi.stubEnv('VERCEL_DEPLOYMENT_ID', 'dpl_wrong');
    vi.mocked(makeRequest)
      .mockResolvedValueOnce({
        profile: 'single-owner-v1',
        runId: 'wrun_test',
        deploymentId: 'dpl_expected',
        head: 1,
        tenant: {
          ownerId: 'team_test',
          projectId: 'prj_test',
          environment: 'preview',
        },
        events: [
          {
            runId: 'wrun_test',
            eventId: `evnt_${'1'.padStart(26, '0')}`,
            createdAt: new Date(),
            eventType: 'run_created',
            specVersion: 7,
            eventData: {
              deploymentId: 'dpl_expected',
              workflowName: 'workflow//test//main',
              input: new Uint8Array(),
            },
          },
        ],
      })
      .mockResolvedValueOnce({ quarantined: true });
    const execution = createWorld({
      affinityHeader: 'x-test-affinity',
    }).execution;
    await expect(execution?.acquire('wrun_test')).rejects.toThrow(
      'wrong deployment'
    );
    expect(makeRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endpoint: '/v1/actor-executions/wrun_test/fault',
        data: expect.objectContaining({
          code: 'EXECUTION_INVARIANT_VIOLATION',
        }),
      })
    );
  });
});
