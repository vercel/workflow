// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ withoutUsage: false }));

// The real Local World, optionally without `experimental_usage`, to stand in
// for a backend that does not count usage.
vi.mock('@workflow/world-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@workflow/world-local')>();
  return {
    ...actual,
    createWorld: (...args: Parameters<typeof actual.createWorld>) => {
      const world = actual.createWorld(...args);
      if (!state.withoutUsage) return world;
      const { experimental_usage: _omit, ...rest } = world;
      return rest;
    },
  };
});

const STEP = 'step//./src/workflows/order//chargeCard';

describe('the web UI reads run usage from the World', () => {
  let base: string;
  let dataDir: string;
  let seedWorld: World;
  let runId: string;
  let actions: typeof import('./workflow-server-actions.server');
  let rpc: typeof import('../routes/api.rpc');

  // Loading the server actions module takes seconds (see the queue-auth
  // suite), so it gets its own budget.
  beforeAll(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'web-usage-'));
    dataDir = path.join(base, '.workflow-data');
    vi.stubEnv('WORKFLOW_TARGET_WORLD', 'local');
    vi.stubEnv('WORKFLOW_LOCAL_DATA_DIR', dataDir);
    const { createWorld } = await import('@workflow/world-local');
    seedWorld = createWorld({ dataDir });

    // A run of 302 events: more than the first page of 200 the run page
    // loads.
    const create = (
      id: string | null,
      event: Record<string, unknown>
    ): ReturnType<World['events']['create']> =>
      seedWorld.events.create(id, {
        specVersion: SPEC_VERSION_CURRENT,
        ...event,
      } as never);
    const { run } = await create(null, {
      eventType: 'run_created',
      eventData: {
        deploymentId: 'dpl_test',
        workflowName: 'workflow//./src/workflows/order//processOrder',
        input: new Uint8Array(4),
      },
    });
    runId = run!.runId;
    await create(runId, { eventType: 'run_started' });
    for (let i = 0; i < 100; i++) {
      const correlationId = `step_${i}`;
      await create(runId, {
        eventType: 'step_created',
        correlationId,
        eventData: { stepName: STEP, input: new Uint8Array(4) },
      });
      await create(runId, { eventType: 'step_started', correlationId });
      await create(runId, {
        eventType: 'step_completed',
        correlationId,
        eventData: { result: new Uint8Array(4) },
      });
    }

    actions = await import('./workflow-server-actions.server');
    rpc = await import('../routes/api.rpc');
  }, 120_000);

  afterAll(async () => {
    await seedWorld?.close?.();
    vi.unstubAllEnvs();
    rmSync(base, { recursive: true, force: true });
  });

  it('counts the whole run', { timeout: 20_000 }, async () => {
    const result = await actions.fetchRunUsage({}, runId);
    expect(result).toMatchObject({
      success: true,
      data: { runId, events: 302, billableEvents: 302, inProgress: true },
    });
  });

  it('answers through the RPC route', { timeout: 20_000 }, async () => {
    const response = await rpc.action({
      request: new Request('http://localhost/api/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/cbor' },
        body: new Uint8Array(
          encode({ method: 'fetchRunUsage', params: { runId } })
        ),
      }),
    } as never);
    const body = decode(new Uint8Array(await response.arrayBuffer()));
    expect(body.success).toBe(true);
    expect(body.data.events).toBe(302);
    expect(body.data.eventsBySpan[0]).toMatchObject({
      name: STEP,
      events: 300,
    });
  });

  it('reports a missing run as an error', { timeout: 20_000 }, async () => {
    const result = await actions.fetchRunUsage(
      {},
      'wrun_01M6MV000000000000000000000'
    );
    expect(result.success).toBe(false);
  });

  it(
    'returns null on a World without usage, instead of a partial count',
    { timeout: 20_000 },
    async () => {
      state.withoutUsage = true;
      // The server caches its World by WORKFLOW_* env: a new key builds a
      // new one, without usage.
      vi.stubEnv('WORKFLOW_USAGE_TEST_CACHE_BUST', '1');
      try {
        const result = await actions.fetchRunUsage({}, runId);
        expect(result).toEqual({ success: true, data: null });
      } finally {
        state.withoutUsage = false;
      }
    }
  );
});
