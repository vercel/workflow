import type { EventType } from '@workflow/world';
import { decode, encode } from 'cbor-x';
import { MockAgent } from 'undici';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CreateEventV4Input,
  createEventResponseSchema,
  createWorkflowRunEventV4,
  EVENTS_API_VERSION,
  getCreateEventResponseSchema,
} from './events-v4.js';
import { WORKFLOW_SERVER_URL_OVERRIDE } from './utils.js';

vi.mock('./get-deadline.js', () => ({
  getDeadline: vi.fn(async () => undefined),
}));

const CREATED_AT = '2026-06-10T00:00:00.000Z';

const runningRun = {
  runId: 'wrun_1',
  status: 'running',
  deploymentId: 'dpl_1',
  workflowName: 'workflow',
  startedAt: CREATED_AT,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
};

const completedStep = {
  runId: 'wrun_1',
  stepId: 'step_1',
  stepName: 'step',
  status: 'completed',
  attempt: 1,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  errorRef: new Uint8Array([9]),
};

function responseBody(
  eventType: string,
  eventData: Record<string, unknown> = {},
  entities: Record<string, unknown> = {}
) {
  return {
    event: {
      eventType,
      specVersion: 2,
      correlationId: 'corr_1',
      eventId: 'evnt_1',
      runId: 'wrun_1',
      createdAt: CREATED_AT,
      ...(Object.keys(eventData).length > 0
        ? { eventData }
        : { eventData: {} }),
    },
    ...entities,
  };
}

async function postRaw(
  eventType: EventType,
  raw: Uint8Array,
  create: typeof createWorkflowRunEventV4 = createWorkflowRunEventV4
) {
  const origin = WORKFLOW_SERVER_URL_OVERRIDE || 'https://vercel-workflow.com';
  const agent = new MockAgent();
  agent.disableNetConnect();
  agent
    .get(origin)
    .intercept({
      path: `/api/${EVENTS_API_VERSION}/runs/wrun_1/events/${eventType}`,
      method: 'POST',
    })
    .reply(200, raw, {
      headers: {
        'x-wf-event-id': 'evnt_1',
        'x-wf-run-id': 'wrun_1',
        'x-wf-created-at': CREATED_AT,
      },
    });

  try {
    return await create(
      {
        runId: 'wrun_1',
        eventType,
        specVersion: 2,
        correlationId: 'corr_1',
        ...(eventType === 'run_started' ? { skipPreload: true as const } : {}),
      } as CreateEventV4Input & { eventType: typeof eventType },
      { token: 'test-token', dispatcher: agent }
    );
  } finally {
    await agent.close();
  }
}

function postEvent(
  eventType: EventType,
  body: unknown,
  create: typeof createWorkflowRunEventV4 = createWorkflowRunEventV4
) {
  return postRaw(eventType, encode(body), create);
}

async function countGeneratedFunctions(
  run: () => Promise<unknown>
): Promise<number> {
  const original = globalThis.Function;
  let calls = 0;
  globalThis.Function = new Proxy(original, {
    construct(target, args, newTarget) {
      calls += 1;
      return Reflect.construct(target, args, newTarget);
    },
  }) as unknown as FunctionConstructor;
  try {
    await run();
    return calls;
  } finally {
    globalThis.Function = original;
  }
}

function issuePaths(error: unknown): PropertyKey[][] {
  const cause = (error as { cause?: { issues?: { path: PropertyKey[] }[] } })
    .cause;
  return cause?.issues?.map((issue) => issue.path) ?? [];
}

function thrownIssues(error: unknown): unknown[] {
  const cause = (error as { cause?: { issues?: unknown[] } }).cause;
  return cause?.issues ?? [];
}

describe('v4 create-event response schemas', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes a valid event, coerces dates, and deserializes the step', async () => {
    const result = await postEvent(
      'step_completed',
      responseBody(
        'step_completed',
        { result: new Uint8Array([1]) },
        { step: completedStep }
      )
    );

    expect(result.event.eventType).toBe('step_completed');
    expect(result.event.createdAt).toEqual(new Date(CREATED_AT));
    expect(result.step).toMatchObject({
      stepId: 'step_1',
      status: 'completed',
      error: new Uint8Array([9]),
    });
    expect(result.step).not.toHaveProperty('errorRef');
  });

  it('accepts an omitted step_completed payload', async () => {
    const result = await postEvent(
      'step_completed',
      responseBody('step_completed', { stepName: 'step' })
    );

    expect(result.event.eventType).toBe('step_completed');
    expect(result.event.eventData).toEqual({ stepName: 'step' });
  });

  it('requires run on run_created and startedAt on run_started', async () => {
    const created = await postEvent(
      'run_created',
      responseBody(
        'run_created',
        {
          deploymentId: 'dpl_1',
          workflowName: 'workflow',
          input: new Uint8Array(),
        },
        { run: runningRun }
      )
    );
    expect(created.run?.runId).toBe('wrun_1');
    expect(created.run?.startedAt).toEqual(new Date(CREATED_AT));

    await expect(
      postEvent(
        'run_created',
        responseBody('run_created', {
          deploymentId: 'dpl_1',
          workflowName: 'workflow',
          input: new Uint8Array(),
        })
      )
    ).rejects.toSatisfy(
      (error: unknown) =>
        issuePaths(error).some((path) => path.includes('run')) &&
        (error as { code?: string }).code === 'SCHEMA_VALIDATION'
    );

    const { startedAt: _startedAt, ...runWithoutStart } = runningRun;
    await expect(
      postEvent(
        'run_started',
        responseBody('run_started', {}, { run: runWithoutStart })
      )
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION' });

    const started = await postEvent(
      'run_started',
      responseBody('run_started', {}, { run: runningRun })
    );
    expect(started.run?.startedAt).toEqual(new Date(CREATED_AT));
  });

  it('requires startedAt on step_started and returns the deserialized step', async () => {
    await expect(
      postEvent(
        'step_started',
        responseBody('step_started', {}, { step: completedStep })
      )
    ).rejects.toMatchObject({ code: 'SCHEMA_VALIDATION' });

    const result = await postEvent(
      'step_started',
      responseBody(
        'step_started',
        {},
        { step: { ...completedStep, startedAt: CREATED_AT, status: 'running' } }
      )
    );
    expect(result.step?.startedAt).toEqual(new Date(CREATED_AT));
    expect(result.step).not.toHaveProperty('errorRef');
    expect(result.step?.error).toEqual(new Uint8Array([9]));
  });

  it('rejects an event type mismatch at event.eventType', async () => {
    await expect(
      postEvent('step_completed', responseBody('run_completed', {}))
    ).rejects.toMatchObject({
      code: 'SCHEMA_VALIDATION',
      message: 'v4 createEvent: invalid response body',
    });

    try {
      await postEvent('step_completed', responseBody('run_completed', {}));
      expect.unreachable();
    } catch (error) {
      expect(issuePaths(error)).toContainEqual(['event', 'eventType']);
    }
  });

  it('accepts hook_conflict only as the hook_created exception', async () => {
    const conflict = responseBody('hook_conflict', {
      token: 'token',
      conflictingRunId: 'wrun_2',
    });

    const created = await postEvent('hook_created', conflict);
    expect(created.event.eventType).toBe('hook_conflict');

    await expect(postEvent('hook_received', conflict)).rejects.toSatisfy(
      (error: unknown) =>
        issuePaths(error).some(
          (path) =>
            path.length === 2 && path[0] === 'event' && path[1] === 'eventType'
        )
    );

    await expect(
      postEvent(
        'hook_created',
        responseBody('hook_received', { payload: new Uint8Array() })
      )
    ).rejects.toSatisfy((error: unknown) =>
      issuePaths(error).some(
        (path) =>
          path.length === 2 && path[0] === 'event' && path[1] === 'eventType'
      )
    );
  });

  it('compiles each event type once, including types that share a base schema', async () => {
    vi.resetModules();
    const fresh = await import('./events-v4.js');
    const completed = responseBody('run_completed', {});
    const failed = responseBody('run_failed', { error: new Uint8Array([1]) });

    const firstCompleted = await countGeneratedFunctions(() =>
      postEvent('run_completed', completed, fresh.createWorkflowRunEventV4)
    );
    const secondCompleted = await countGeneratedFunctions(() =>
      postEvent('run_completed', completed, fresh.createWorkflowRunEventV4)
    );
    const firstFailed = await countGeneratedFunctions(() =>
      postEvent('run_failed', failed, fresh.createWorkflowRunEventV4)
    );
    const secondFailed = await countGeneratedFunctions(() =>
      postEvent('run_failed', failed, fresh.createWorkflowRunEventV4)
    );

    expect(firstCompleted).toBeGreaterThan(0);
    expect(secondCompleted).toBe(0);
    expect(firstFailed).toBeGreaterThan(0);
    expect(secondFailed).toBe(0);
  });
});

/**
 * Compilation-count pin for this Workflow SDK schema-compilation change.
 *
 * Counting method: a `construct` trap on `globalThis.Function`, installed
 * before the work under test. Zod 4.5.4 reads `Function` inside `z.compile`
 * (`const F = Function; new F(...)`) and constructs it twice per successful
 * compile, once for the parser and once for the validator. Spying on
 * `z.compile` does not work: the ESM namespace export is not configurable.
 *
 * Absolute startup counts are not asserted. A different counter over a
 * similar graph reported 204 validator functions, which is not comparable
 * to this one. Fresh-process fixture: Node starts with no workflow
 * modules loaded, the trap is installed, then the built entry is imported.
 * Sample on Node 24.13.1, zod 4.5.4, cbor-x 1.6.0:
 * `@workflow/world` `dist/index.js` 109 functions / 52 ms;
 * `@workflow/world-vercel` `dist/index.js` (includes world) 142 functions /
 * 149 ms; `events-v4.js` 123 functions / 103 ms; first `step_completed`
 * decode +2 functions / 16 ms (import + first decode 125 functions /
 * 119 ms); 200 warm compiled parses 0 functions / 1.3 ms. The full-runtime
 * target for the graph that previously read 154 is 152, because
 * `AllEventsSchema` is no longer compiled on its own (−2). The
 * `schema-compile-timing` log below is in-process, after Vitest has already
 * loaded Zod, and is not this sample.
 *
 * The assertions are the durable requirement: an event type compiles on
 * first decode and not again, a type that shares the base schema still
 * compiles, and a new module copy compiles again.
 */
describe('response schema compilation boundaries', () => {
  const stepCompleted = responseBody(
    'step_completed',
    { result: new Uint8Array([1]) },
    { step: completedStep }
  );

  it('matches the uncompiled schema for values and full Zod issues over HTTP', async () => {
    const { startedAt: _startedAt, ...runWithoutStart } = runningRun;
    const valid = [
      ['step_completed', stepCompleted],
      [
        'run_created',
        responseBody(
          'run_created',
          {
            deploymentId: 'dpl_1',
            workflowName: 'workflow',
            input: new Uint8Array(),
          },
          { run: runningRun }
        ),
      ],
      [
        'hook_created',
        responseBody('hook_conflict', {
          token: 'token',
          conflictingRunId: 'wrun_2',
        }),
      ],
    ] as const;
    for (const [eventType, body] of valid) {
      const decoded = decode(encode(body));
      const baseline = createEventResponseSchema(eventType).parse(decoded);
      const compiled = getCreateEventResponseSchema(eventType).parse(decoded);
      const http = await postEvent(eventType, body);
      expect(compiled).toEqual(baseline);
      expect(http).toEqual(baseline);
    }

    const invalid = [
      ['step_completed', responseBody('run_completed', {})],
      [
        'run_created',
        responseBody('run_created', {
          deploymentId: 'dpl_1',
          workflowName: 'workflow',
          input: new Uint8Array(),
        }),
      ],
      [
        'run_started',
        responseBody('run_started', {}, { run: runWithoutStart }),
      ],
      [
        'step_started',
        responseBody('step_started', {}, { step: completedStep }),
      ],
      [
        'step_completed',
        responseBody(
          'step_completed',
          { result: new Uint8Array([1]) },
          { step: { ...completedStep, attempt: 'nope' } }
        ),
      ],
    ] as const;
    for (const [eventType, body] of invalid) {
      const decoded = decode(encode(body));
      const baseline = createEventResponseSchema(eventType).safeParse(decoded);
      const compiled =
        getCreateEventResponseSchema(eventType).safeParse(decoded);
      expect(baseline.success).toBe(false);
      expect(compiled.success).toBe(false);
      if (baseline.success || compiled.success) continue;
      expect(compiled.error.issues).toEqual(baseline.error.issues);
      await expect(postEvent(eventType, body)).rejects.toSatisfy(
        (error: unknown) => {
          expect(thrownIssues(error)).toEqual(baseline.error.issues);
          return true;
        }
      );
    }
  });

  it('rejects empty and malformed CBOR before schema validation', async () => {
    await expect(
      postRaw('step_completed', new Uint8Array())
    ).rejects.toMatchObject({
      code: 'PARSE_ERROR',
      message: 'v4 createEvent: empty response body',
    });
    // 0x18 is a truncated CBOR uint. 0xff decodes as an empty map.
    await expect(
      postRaw('step_completed', new Uint8Array([0x18]))
    ).rejects.toMatchObject({
      code: 'PARSE_ERROR',
      message: 'v4 createEvent: invalid CBOR response body',
    });
  });

  it('stores schemas, not response bodies', () => {
    const schema = getCreateEventResponseSchema('step_completed');
    const first = schema.parse(decode(encode(stepCompleted)));
    const second = schema.parse(
      decode(
        encode(
          responseBody(
            'step_completed',
            { result: new Uint8Array([2]) },
            { step: completedStep }
          )
        )
      )
    );
    expect(first.event.eventData).toEqual({ result: new Uint8Array([1]) });
    expect(second.event.eventData).toEqual({ result: new Uint8Array([2]) });
  });

  it('compiles an event type again in a new module copy', async () => {
    vi.resetModules();
    const firstCopy = await import('./events-v4.js');
    const body = responseBody('run_completed', {});
    const first = await countGeneratedFunctions(() =>
      postEvent('run_completed', body, firstCopy.createWorkflowRunEventV4)
    );
    vi.resetModules();
    const secondCopy = await import('./events-v4.js');
    const second = await countGeneratedFunctions(() =>
      postEvent('run_completed', body, secondCopy.createWorkflowRunEventV4)
    );
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(0);
  });

  it('pays compilation on the first decode and none while warm', async () => {
    vi.resetModules();
    const importStarted = performance.now();
    const fresh = await import('./events-v4.js');
    const importMs = performance.now() - importStarted;

    const decoded = decode(encode(stepCompleted));
    const baseline = fresh.createEventResponseSchema('step_completed');
    const firstStarted = performance.now();
    const firstFunctions = await countGeneratedFunctions(() =>
      postEvent('step_completed', stepCompleted, fresh.createWorkflowRunEventV4)
    );
    const firstDecodeMs = performance.now() - firstStarted;

    const warmCount = 20;
    const warmStarted = performance.now();
    const warmFunctions = await countGeneratedFunctions(async () => {
      for (let i = 0; i < warmCount; i++) {
        await postEvent(
          'step_completed',
          stepCompleted,
          fresh.createWorkflowRunEventV4
        );
      }
    });
    const warmDecodeMs = performance.now() - warmStarted;

    const compiled = fresh.getCreateEventResponseSchema('step_completed');
    const parseCount = 200;
    const compiledWarmStarted = performance.now();
    const compiledWarmFunctions = await countGeneratedFunctions(async () => {
      for (let i = 0; i < parseCount; i++) compiled.parse(decoded);
    });
    const compiledWarmMs = performance.now() - compiledWarmStarted;
    const uncompiledWarmStarted = performance.now();
    for (let i = 0; i < parseCount; i++) baseline.parse(decoded);
    const uncompiledWarmMs = performance.now() - uncompiledWarmStarted;

    expect(compiled.parse(decoded)).toEqual(baseline.parse(decoded));
    expect(firstFunctions).toBeGreaterThan(0);
    expect(warmFunctions).toBe(0);
    expect(compiledWarmFunctions).toBe(0);
    console.info(
      'schema-compile-timing',
      JSON.stringify({
        importMs,
        firstDecodeMs,
        importPlusFirstDecodeMs: importMs + firstDecodeMs,
        warmDecodeMs,
        warmCount,
        compiledWarmMs,
        uncompiledWarmMs,
        parseCount,
      })
    );
  });
});
