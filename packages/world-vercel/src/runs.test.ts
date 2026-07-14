import { decode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { getWorkflowRuns } from './runs.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

describe('getWorkflowRuns', () => {
  it('posts unique IDs once and maps an aligned response including missing runs', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(ORIGIN)
      .intercept({
        path: '/api/v2/runs/batch',
        method: 'POST',
        body: (body) => {
          expect(decode(new Uint8Array(body))).toEqual({
            runIds: ['wrun_first', 'wrun_missing'],
            remoteRefBehavior: 'lazy',
          });
          return true;
        },
      })
      .reply(200, {
        runs: [
          {
            runId: 'wrun_first',
            status: 'running',
            deploymentId: 'dpl_1',
            workflowName: 'test-workflow',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          null,
        ],
      });

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
