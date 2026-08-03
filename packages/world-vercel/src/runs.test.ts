import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { getWorkflowRuns } from './runs.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

describe('getWorkflowRuns', () => {
  it('delegates to getWorkflowRun for unique IDs, preserves input order, and returns null for missing runs', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v2/runs/wrun_first?remoteRefBehavior=lazy',
        method: 'GET',
      })
      .reply(200, {
        runId: 'wrun_first',
        status: 'running',
        deploymentId: 'dpl_1',
        workflowName: 'test-workflow',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v2/runs/wrun_missing?remoteRefBehavior=lazy',
        method: 'GET',
      })
      .reply(404);

    const runs = await getWorkflowRuns(
      ['wrun_first', 'wrun_missing', 'wrun_first'],
      { resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(runs.map((run) => run?.runId ?? null)).toEqual([
      'wrun_first',
      null,
      'wrun_first',
    ]);
    expect(runs[0]?.input).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });
});
