import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import {
  cancelWorkflowRuns,
  getWorkflowRun,
  getWorkflowRuns,
  listWorkflowRuns,
} from './runs.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

describe('listWorkflowRuns', () => {
  it('rejects an array of statuses client-side without issuing a request', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    await expect(
      listWorkflowRuns(
        { status: ['pending', 'running'] },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow(/does not support an array of statuses/);

    // No interceptors registered — a network attempt would throw a distinct
    // "not mocked" error, so reaching here means no request was made.
    agent.assertNoPendingInterceptors();
  });
});

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

describe('getWorkflowRun dynamic workflow code', () => {
  const code = new Uint8Array([10, 10, 10]);

  function agentReturningRun(remoteRefBehavior: 'lazy' | 'resolve') {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get(ORIGIN)
      .intercept({
        path: `/api/v2/runs/wrun_dynamic?remoteRefBehavior=${remoteRefBehavior}`,
        method: 'GET',
      })
      .reply(
        200,
        () =>
          encode({
            runId: 'wrun_dynamic',
            status: 'running',
            deploymentId: 'dpl_1',
            workflowName:
              'workflow//dynamic/0123456789abcdef0123456789abcdef//workflow',
            dynamicWorkflowCode: code,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        { headers: { 'content-type': 'application/cbor' } }
      );
    return agent;
  }

  it("omits the code with resolveData: 'none' even when the backend sends it", async () => {
    const agent = agentReturningRun('lazy');

    const run = await getWorkflowRun(
      'wrun_dynamic',
      { resolveData: 'none' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(run).not.toHaveProperty('dynamicWorkflowCode');
    agent.assertNoPendingInterceptors();
  });

  it("returns the code with resolveData: 'all'", async () => {
    const agent = agentReturningRun('resolve');

    const run = await getWorkflowRun(
      'wrun_dynamic',
      { resolveData: 'all' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(run.dynamicWorkflowCode).toEqual(code);
    agent.assertNoPendingInterceptors();
  });
});

describe('cancelWorkflowRuns', () => {
  it('issues a single POST /v4/runs/cancel with the run IDs and cancelReason', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    let requestCount = 0;
    let capturedBody: unknown;

    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v4/runs/cancel', method: 'POST' })
      .reply(
        200,
        (opts: { body?: unknown }) => {
          requestCount++;
          capturedBody = decode(new Uint8Array(opts.body as ArrayBufferLike));
          return encode({
            summary: {
              requested: 2,
              cancelled: 1,
              alreadyCancelled: 0,
              notCancellable: 0,
              notFound: 1,
              failed: 0,
            },
            results: [
              { runId: 'wrun_a', outcome: 'cancelled' },
              { runId: 'wrun_b', outcome: 'not_found' },
            ],
          });
        },
        { headers: { 'content-type': 'application/cbor' } }
      );

    const result = await cancelWorkflowRuns(
      { runIds: ['wrun_a', 'wrun_b'], cancelReason: 'cleanup' },
      { token: 'test-token', dispatcher: agent }
    );

    expect(requestCount).toBe(1);
    expect(capturedBody).toEqual({
      runIds: ['wrun_a', 'wrun_b'],
      cancelReason: 'cleanup',
    });
    expect(result.summary.cancelled).toBe(1);
    expect(result.results.map((r) => r.runId)).toEqual(['wrun_a', 'wrun_b']);
    agent.assertNoPendingInterceptors();
  });

  it('reorders backend results to match the requested runId order', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v4/runs/cancel', method: 'POST' })
      .reply(
        200,
        () =>
          encode({
            summary: {
              requested: 2,
              cancelled: 2,
              alreadyCancelled: 0,
              notCancellable: 0,
              notFound: 0,
              failed: 0,
            },
            // Intentionally reversed relative to the request.
            results: [
              { runId: 'wrun_b', outcome: 'cancelled' },
              { runId: 'wrun_a', outcome: 'cancelled' },
            ],
          }),
        { headers: { 'content-type': 'application/cbor' } }
      );

    const result = await cancelWorkflowRuns(
      { runIds: ['wrun_a', 'wrun_b'] },
      { token: 'test-token', dispatcher: agent }
    );

    expect(result.results.map((r) => r.runId)).toEqual(['wrun_a', 'wrun_b']);
    agent.assertNoPendingInterceptors();
  });

  it('rejects a malformed response that omits a requested runId instead of synthesizing not_found', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    agent
      .get(ORIGIN)
      .intercept({ path: '/api/v4/runs/cancel', method: 'POST' })
      .reply(
        200,
        () =>
          encode({
            summary: {
              requested: 2,
              cancelled: 1,
              alreadyCancelled: 0,
              notCancellable: 0,
              notFound: 0,
              failed: 0,
            },
            // Only one result for two requested IDs — a protocol violation.
            results: [{ runId: 'wrun_a', outcome: 'cancelled' }],
          }),
        { headers: { 'content-type': 'application/cbor' } }
      );

    await expect(
      cancelWorkflowRuns(
        { runIds: ['wrun_a', 'wrun_b'] },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow(/exactly one result per requested run ID/);
    agent.assertNoPendingInterceptors();
  });

  it('rejects invalid requests client-side without issuing a request', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();

    await expect(
      cancelWorkflowRuns(
        { runIds: [] },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();

    await expect(
      cancelWorkflowRuns(
        { runIds: ['dup', 'dup'] },
        { token: 'test-token', dispatcher: agent }
      )
    ).rejects.toThrow();

    // No interceptors registered — a network attempt would throw a distinct
    // "not mocked" error, so reaching here means no request was made.
    agent.assertNoPendingInterceptors();
  });
});
