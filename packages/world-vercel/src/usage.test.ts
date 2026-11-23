import { WorkflowRunNotFoundError, WorkflowWorldError } from '@workflow/errors';
import {
  AnalyticsRunWithUsageSchema,
  buildRunUsage,
  type RunUsageAggregates,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  makeRequest: vi.fn(),
}));

vi.mock('./utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./utils.js')>()),
  makeRequest: state.makeRequest,
}));

const { getRunUsage, USAGE_UNAVAILABLE } = await import('./analytics.js');
const { createWorld } = await import('./index.js');

const RUN_ID = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';
const HOOK_ID = 'hook_01K4BZQ9N3Q6SRXY8ZMVP4GHEC';
const FLAG = 'WORKFLOW_EXPERIMENTAL_VERCEL_USAGE';

const run = {
  runId: RUN_ID,
  status: 'completed',
  deploymentId: 'dpl_1',
  workflowName: 'workflow//./src/workflows/order//processOrder',
  attributes: {},
  createdAt: '2026-11-20 17:09:11.000',
  updatedAt: '2026-11-20 17:09:15.000',
};

/** The response body, as the backend sends it (before the schema runs). */
const usage = {
  asOf: '2026-11-20T17:10:00.000Z',
  eventGroups: [
    { eventType: 'run_created', events: 1 },
    { eventType: 'run_started', events: 1 },
    { eventType: 'run_completed', events: 1 },
    { eventType: 'hook_created', events: 1 },
    { eventType: 'hook_received', events: 1 },
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
    },
    {
      stepName: 'step//./src/workflows/order//reserveInventory',
      steps: 1,
      events: 3,
      created: 1,
      started: 1,
      completed: 1,
      failed: 0,
      retries: 0,
      restarts: 0,
    },
  ],
  hookGroups: [{ hookId: HOOK_ID, events: 2 }],
  dataWritten: { run: 80, step: 168, hook: 35, stream: 91 },
  dataRetained: { byteMonths: 374, retentionMonths: 1 },
};

/** Answer every request with `body`, parsed by the request's schema as makeRequest does. */
const respond = (body: unknown) =>
  state.makeRequest.mockImplementation(
    async ({ schema }: { schema: { parse(value: unknown): unknown } }) =>
      schema.parse(body)
  );

beforeEach(() => {
  state.makeRequest.mockReset();
});

describe('getRunUsage', () => {
  it('builds the same usage as buildRunUsage on the same aggregates, billed', async () => {
    respond({ ...run, usage });
    const expected = buildRunUsage({
      runId: RUN_ID,
      status: 'completed',
      workflowName: run.workflowName,
      eventGroups: usage.eventGroups.map((g) => ({ ...g, bytes: 0 })),
      stepGroups: usage.stepGroups.map((g) => ({ ...g, bytes: 0 })),
      streamBytes: 0,
      dataWritten: usage.dataWritten,
      dataRetained: usage.dataRetained,
      hookGroups: usage.hookGroups.map((group) => ({ ...group, token: null })),
      billed: true,
      asOf: usage.asOf,
    } satisfies RunUsageAggregates);

    const result = await getRunUsage(RUN_ID);

    expect(result).toEqual(expected);
    expect(result.billed).toBe(true);
    expect(result.asOf).toBe(usage.asOf);
    expect(result.events).toBe(13);
    // The backend's per-entity totals, as given.
    expect(result.dataWritten.byEntity).toEqual(usage.dataWritten);
    expect(result.dataWritten.bytes).toBe(80 + 168 + 35 + 91);
    expect(result.dataWritten.source).toBe('log');
  });

  it('asks for the run with include=usage, in one request', async () => {
    respond({ ...run, usage });
    await getRunUsage(RUN_ID);
    expect(state.makeRequest).toHaveBeenCalledTimes(1);
    expect(state.makeRequest.mock.calls[0][0].endpoint).toBe(
      `/v2/analytics/runs/${RUN_ID}?include=usage`
    );
  });

  it('names a hook by its id, since analytics carries no token', async () => {
    respond({ ...run, usage });
    const result = await getRunUsage(RUN_ID);
    const hook = result.eventsBySpan.find((span) => span.kind === 'hook');
    expect(hook?.name).toBe(HOOK_ID);
  });

  it('rejects an unknown run with WorkflowRunNotFoundError', async () => {
    state.makeRequest.mockRejectedValue(
      new WorkflowWorldError('Not found', { status: 404 })
    );
    await expect(getRunUsage(RUN_ID)).rejects.toBeInstanceOf(
      WorkflowRunNotFoundError
    );
  });

  it('passes other request errors through unchanged', async () => {
    const error = new WorkflowWorldError('Server error', { status: 500 });
    state.makeRequest.mockRejectedValue(error);
    await expect(getRunUsage(RUN_ID)).rejects.toBe(error);
  });

  it('rejects with a clear error when the backend sends no usage', async () => {
    respond(run);
    const rejection = getRunUsage(RUN_ID);
    await expect(rejection).rejects.toBeInstanceOf(WorkflowWorldError);
    await expect(rejection).rejects.toMatchObject({
      code: USAGE_UNAVAILABLE,
      message: "Run usage isn't available from this backend yet.",
    });
  });

  it('rejects step events in eventGroups instead of counting them twice', async () => {
    const doubled = {
      ...run,
      usage: {
        ...usage,
        eventGroups: [
          ...usage.eventGroups,
          { eventType: 'step_started', events: 3 },
        ],
      },
    };
    expect(AnalyticsRunWithUsageSchema.safeParse(doubled).success).toBe(false);
    expect(
      AnalyticsRunWithUsageSchema.safeParse({ ...run, usage }).success
    ).toBe(true);
  });

  it.each([
    ['null', null],
    ['absent', undefined],
  ])('treats usage %s as unavailable', async (_label, value) => {
    respond({ ...run, usage: value });
    await expect(getRunUsage(RUN_ID)).rejects.toMatchObject({
      code: USAGE_UNAVAILABLE,
    });
  });

  it('rejects a hook listed twice, which would count its events twice', () => {
    const twice = {
      ...usage,
      hookGroups: [
        { hookId: HOOK_ID, events: 1 },
        { hookId: HOOK_ID, events: 1 },
      ],
    };
    expect(
      AnalyticsRunWithUsageSchema.safeParse({ ...run, usage: twice }).success
    ).toBe(false);
  });

  it('rejects hook groups holding more events than the hook_* events', () => {
    const over = { ...usage, hookGroups: [{ hookId: HOOK_ID, events: 3 }] };
    const parsed = AnalyticsRunWithUsageSchema.safeParse({
      ...run,
      usage: over,
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      'more than the 2 hook_* events'
    );
  });

  it('keeps every share at or under 100% for a response the schema accepts', async () => {
    respond({ ...run, usage });
    const result = await getRunUsage(RUN_ID);
    const total = result.eventsBySpan.reduce((n, span) => n + span.share, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('reads asOf as UTC, with or without a zone, and rejects one that is not a time', async () => {
    respond({ ...run, usage: { ...usage, asOf: '2026-11-20 17:10:00.000' } });
    expect((await getRunUsage(RUN_ID)).asOf).toBe('2026-11-20T17:10:00.000Z');
    for (const asOf of ['', 'soon']) {
      expect(
        AnalyticsRunWithUsageSchema.safeParse({
          ...run,
          usage: { ...usage, asOf },
        }).success
      ).toBe(false);
    }
  });

  it('accepts a response without dataRetained', async () => {
    const { dataRetained: _omit, ...withoutRetained } = usage;
    respond({ ...run, usage: withoutRetained });
    expect((await getRunUsage(RUN_ID)).dataRetained).toBeNull();
  });

  it('reads counts of 2^32 or more that arrive as bigint', async () => {
    respond({
      ...run,
      usage: {
        ...usage,
        dataWritten: { ...usage.dataWritten, stream: 2n ** 33n },
      },
    });
    const result = await getRunUsage(RUN_ID);
    expect(result.dataWritten.byEntity.stream).toBe(2 ** 33);
  });

  it('rejects an answer for a different run', async () => {
    respond({ ...run, runId: 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCF', usage });
    await expect(getRunUsage(RUN_ID)).rejects.toThrow(/answered for run/);
  });

  it('rejects a bad run id before sending anything', async () => {
    await expect(getRunUsage('nope')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(state.makeRequest).not.toHaveBeenCalled();
  });
});

describe(`createWorld with ${FLAG}`, () => {
  const original = process.env[FLAG];
  afterEach(() => {
    if (original === undefined) delete process.env[FLAG];
    else process.env[FLAG] = original;
  });

  it('has no experimental_usage when the flag is unset', () => {
    delete process.env[FLAG];
    expect(createWorld().experimental_usage).toBeUndefined();
  });

  it.each([
    '0',
    'true',
    '',
  ])('has no experimental_usage when it is %j', (value) => {
    process.env[FLAG] = value;
    expect(createWorld().experimental_usage).toBeUndefined();
  });

  it('reads usage through experimental_usage when it is 1', async () => {
    process.env[FLAG] = '1';
    respond({ ...run, usage });
    const world = createWorld();
    expect(typeof world.experimental_usage?.getRun).toBe('function');
    const result = await world.experimental_usage?.getRun(RUN_ID);
    expect(result?.asOf).toBe(usage.asOf);
    expect(state.makeRequest.mock.calls[0][0].endpoint).toContain(
      'include=usage'
    );
  });
});
