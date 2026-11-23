import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { getRunUsage, USAGE_UNAVAILABLE } from './analytics.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

// The real request path (makeRequest, headers, JSON and CBOR decoding,
// schema parsing), with only the network mocked.

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const RUN_ID = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';
const PATH = `/api/v2/analytics/runs/${RUN_ID}?include=usage`;

const run = {
  runId: RUN_ID,
  status: 'completed',
  deploymentId: 'dpl_1',
  workflowName: 'workflow//./src/workflows/order//processOrder',
  attributes: {},
  createdAt: '2026-11-20 17:09:11.000',
  updatedAt: '2026-11-20 17:09:15.000',
};

const usage = {
  asOf: '2026-11-20T17:10:00.000Z',
  eventGroups: [
    { eventType: 'run_created', events: 1, bytes: 64 },
    { eventType: 'run_started', events: 1, bytes: 0 },
    { eventType: 'run_completed', events: 1, bytes: 16 },
  ],
  stepGroups: [
    {
      stepName: 'step//./src/workflows/order//chargeCard',
      steps: 1,
      events: 5,
      created: 1,
      started: 2,
      completed: 1,
      failed: 0,
      retries: 1,
      restarts: 0,
      bytes: 104,
    },
  ],
  streamBytes: 91,
  dataRetained: null,
};

function agentReplying(
  status: number,
  body?: unknown,
  contentType = 'application/json'
) {
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(ORIGIN)
    .intercept({ path: PATH, method: 'GET' })
    .reply(
      status,
      body === undefined
        ? ''
        : contentType === 'application/cbor'
          ? Buffer.from(encode(body))
          : JSON.stringify(body),
      { headers: { 'content-type': contentType } }
    );
  return agent;
}

const config = (dispatcher: MockAgent) => ({ token: 'test-token', dispatcher });

describe('getRunUsage over HTTP', () => {
  it.each([
    'application/json',
    'application/cbor',
  ])('reads a %s response into billed usage', async (contentType) => {
    const agent = agentReplying(200, { ...run, usage }, contentType);
    const result = await getRunUsage(RUN_ID, config(agent));
    expect(result.billed).toBe(true);
    expect(result.asOf).toBe(usage.asOf);
    expect(result.events).toBe(8);
    expect(result.dataWritten.bytes).toBe(80 + 104 + 91);
    agent.assertNoPendingInterceptors();
  });

  it('turns a 404 into WorkflowRunNotFoundError', async () => {
    const agent = agentReplying(404, { error: 'not found' });
    await expect(getRunUsage(RUN_ID, config(agent))).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
  });

  it('says usage is unavailable when the backend sends the run without it', async () => {
    const agent = agentReplying(200, run);
    const rejection = getRunUsage(RUN_ID, config(agent));
    await expect(rejection).rejects.toBeInstanceOf(WorkflowWorldError);
    await expect(rejection).rejects.toMatchObject({ code: USAGE_UNAVAILABLE });
  });
});
