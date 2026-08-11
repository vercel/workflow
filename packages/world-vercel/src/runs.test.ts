import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { describe, expect, it } from 'vitest';
import { cancelWorkflowRuns, getWorkflowRuns } from './runs.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

const ORIGIN = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';

/**
 * Reads a request body as the mock hands it to a reply callback.
 *
 * undici 8's MockAgent consumes the outgoing body to drive the handler's
 * body-sent hooks, then substitutes a replayable async iterable for it; undici 7
 * passed whatever `fetch` dispatched (a `Uint8Array`) straight through. Reply
 * callbacks therefore have to drain it, which makes them async.
 */
async function mockBodyBytes(rawBody: unknown): Promise<Uint8Array> {
  if (rawBody == null) return new Uint8Array();
  if (typeof rawBody === 'string') return new TextEncoder().encode(rawBody);
  if (rawBody instanceof Uint8Array) return rawBody;
  if (
    typeof (rawBody as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] ===
    'function'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of rawBody as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return new Uint8Array(Buffer.concat(chunks));
  }
  return new Uint8Array(rawBody as ArrayBufferLike);
}

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
        async (opts: { body?: unknown }) => {
          requestCount++;
          capturedBody = decode(await mockBodyBytes(opts.body));
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
