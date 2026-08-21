import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetRunStatusLongPollSupportForTests,
  waitForWorkflowRunTerminalStatus,
} from './runs.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
const RUN_ID = 'wrun_01JB0000000000000000000000';

const runBody = (status: string) => ({
  runId: RUN_ID,
  status,
  deploymentId: 'dpl_1',
  workflowName: 'test-workflow',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

function mockAgent(): MockAgent {
  const agent = new MockAgent();
  agent.disableNetConnect();
  return agent;
}

/**
 * `waitForWorkflowRunTerminalStatus` — the `world-vercel` half of
 * `runs.waitForTerminalStatus`, backed by workflow-server's long-pollable
 * `GET /v2/runs/:runId/status`.
 *
 * The interesting behavior is the degradation: this adapter can be talking to
 * a workflow-server that does not have the route, and it must tell that apart
 * from a run that does not exist.
 */
describe('waitForWorkflowRunTerminalStatus', () => {
  const requestTimeoutEnv = 'WORKFLOW_REQUEST_TIMEOUT_MS';
  const originalRequestTimeout = process.env[requestTimeoutEnv];

  beforeEach(() => {
    _resetRunStatusLongPollSupportForTests();
  });

  afterEach(() => {
    if (originalRequestTimeout === undefined) {
      delete process.env[requestTimeoutEnv];
    } else {
      process.env[requestTimeoutEnv] = originalRequestTimeout;
    }
  });

  it('long polls the status route with the requested budget', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(200, runBody('completed'));

    const run = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(run.status).toBe('completed');
    agent.assertNoPendingInterceptors();
  });

  it('returns a non-terminal snapshot when the server budget expires', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(200, runBody('running'));

    // A run that is still going is an answer, not an error.
    const run = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(run.status).toBe('running');
    agent.assertNoPendingInterceptors();
  });

  it('asks for lazy refs when the caller does not want payloads', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=lazy&waitMs=1000`,
        method: 'GET',
      })
      .reply(200, runBody('completed'));

    const run = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 1_000, resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(run.output).toBeUndefined();
    agent.assertNoPendingInterceptors();
  });

  it('reads plainly when there is no budget to wait with', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(200, runBody('running'));

    const run = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      {},
      { token: 'test-token', dispatcher: agent }
    );

    expect(run.status).toBe('running');
    agent.assertNoPendingInterceptors();
  });

  it('clamps the budget under the adapter request timeout', async () => {
    // Leaves 10s of headroom, so a 12s request timeout permits a 2s wait —
    // the budget must always expire as a response, never as a client timeout.
    process.env[requestTimeoutEnv] = '12000';
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=2000`,
        method: 'GET',
      })
      .reply(200, runBody('completed'));

    await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );

    agent.assertNoPendingInterceptors();
  });

  it('degrades to the plain read when the held request is severed', async () => {
    // A ~25s hold crosses gateways and egress proxies entitled to cut an
    // apparently idle connection. That must not fail the caller's await for a
    // run that is merely still running, and it must stand the fast path down
    // rather than repeating the same doomed request every iteration.
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .replyWithError(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
      );
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(200, runBody('running'))
      .times(2);

    const first = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );
    // A still-running run is an answer, not a rejection.
    expect(first.status).toBe('running');

    // Second call goes straight to the plain read — no second status attempt.
    const second = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );
    expect(second.status).toBe('running');
    agent.assertNoPendingInterceptors();
  });

  it('propagates a caller abort instead of degrading', async () => {
    // An abort is deliberate, so it must not be read as "this backend cannot
    // hold a request open" — that would cost an extra read and disable the
    // fast path process-wide for five minutes on an ordinary cancellation.
    const agent = mockAgent();
    const controller = new AbortController();
    // Already aborted, so fetch rejects before it dispatches — no interceptor
    // is consumed, which is part of the point: nothing reached the wire, so
    // nothing should be concluded about the route.
    controller.abort();

    await expect(
      waitForWorkflowRunTerminalStatus(
        RUN_ID,
        { timeoutMs: 25_000, signal: controller.signal },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();

    // No plain-read interceptor was needed, and the next call still long polls.
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(200, runBody('completed'));
    const run = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );
    expect(run.status).toBe('completed');
    agent.assertNoPendingInterceptors();
  });

  it('degrades to the plain read on a 504 from an intermediary', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(504, { message: 'Gateway Timeout' });
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(200, runBody('running'));

    const run = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );

    expect(run.status).toBe('running');
    agent.assertNoPendingInterceptors();
  });

  it('degrades to the plain read when the server has no status route', async () => {
    const agent = mockAgent();
    // Two waits: the first discovers the route is missing, the second must not
    // even try it again.
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(404, { error: 'not-found', message: 'No route matches GET …' });
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(200, runBody('running'))
      .times(2);

    const config = { token: 'test-token', dispatcher: agent };
    const first = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      config
    );
    const second = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      config
    );

    expect(first.status).toBe('running');
    expect(second.status).toBe('running');
    // Only one status-route attempt was made across both calls.
    agent.assertNoPendingInterceptors();
  });

  it('suppresses the fast path per backend, not process-wide', async () => {
    // One process can hold worlds pointed at different backends — the
    // api.vercel.com proxy and workflow-server directly — which can be on
    // different versions. A miss against one must not disable the other.
    const agent = mockAgent();
    const direct = agent.get(ORIGIN);
    direct
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(404, { error: 'not-found', message: 'No route matches GET …' });
    direct
      .intercept({
        path: `/api/v2/runs/${RUN_ID}?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(200, runBody('running'));
    agent
      .get('https://api.vercel.com')
      .intercept({
        path: `/v1/workflow/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(200, runBody('completed'));

    await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      { token: 'test-token', dispatcher: agent }
    );
    const viaProxy = await waitForWorkflowRunTerminalStatus(
      RUN_ID,
      { timeoutMs: 25_000 },
      {
        token: 'test-token',
        projectConfig: { projectId: 'prj_1', teamId: 'team_1' },
        dispatcher: agent,
      }
    );

    expect(viaProxy.status).toBe('completed');
    agent.assertNoPendingInterceptors();
  });

  it('reports a missing run as not found, and keeps long polling enabled', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(404, { error: 'not-found', message: 'workflow run not found' })
      .times(2);
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}?remoteRefBehavior=resolve`,
        method: 'GET',
      })
      .reply(404, { error: 'not-found', message: 'workflow run not found' })
      .times(2);

    const config = { token: 'test-token', dispatcher: agent };
    await expect(
      waitForWorkflowRunTerminalStatus(RUN_ID, { timeoutMs: 25_000 }, config)
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);

    // A bad run ID says nothing about the server's routes, so the next wait
    // still tries the fast path (its own 404 pair is consumed here).
    await expect(
      waitForWorkflowRunTerminalStatus(RUN_ID, { timeoutMs: 25_000 }, config)
    ).rejects.toBeInstanceOf(WorkflowRunNotFoundError);

    agent.assertNoPendingInterceptors();
  });

  it('propagates a server error instead of masking it with a plain read', async () => {
    const agent = mockAgent();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/${RUN_ID}/status?remoteRefBehavior=resolve&waitMs=25000`,
        method: 'GET',
      })
      .reply(500, { error: 'internal-server-error', message: 'boom' });

    await expect(
      waitForWorkflowRunTerminalStatus(
        RUN_ID,
        { timeoutMs: 25_000 },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toBeInstanceOf(WorkflowWorldError);

    agent.assertNoPendingInterceptors();
  });
});
