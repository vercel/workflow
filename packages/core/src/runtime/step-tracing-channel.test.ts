/**
 * Tests for the `workflow.step` diagnostics tracing channel published around
 * step execution (see StepTracingContext in step-executor.ts).
 *
 * Covers:
 *  - event payload and start/end/asyncStart/asyncEnd/error sequencing,
 *    including retries and fatal-vs-retryable classification
 *  - async context flow: AsyncLocalStorage bound via `channel.start.bindStore`
 *    survives nested awaits inside the step body, so auto-instrumentation
 *    (undici et al.) parents under a subscriber-opened span with no user code
 *  - no context bleed across concurrently executing steps
 *  - step return values never reach subscribers
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { tracingChannel } from 'node:diagnostics_channel';
import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Context,
  context as otelContext,
  trace as otelTrace,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { FatalError } from '@workflow/errors';
import type { World } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStepFunction } from '../private.js';
import { dehydrateStepArguments } from '../serialization.js';
import { executeStep, type StepTracingContext } from './step-executor.js';

const channel = tracingChannel<unknown, StepTracingContext>('workflow.step');

let counter = 0;
function uniqueStepName(): string {
  counter += 1;
  return `step//./step-tracing-channel-test//step${counter}`;
}

function makeWorld(): World {
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-step-tracing-'));
  return createWorld({ dataDir, tag: `tc${counter}` });
}

async function setupRunningStep(opts: {
  world: World;
  stepName: string;
  body: (...args: unknown[]) => Promise<unknown>;
  maxRetries?: number;
}): Promise<{ runId: string; stepId: string }> {
  const { world, stepName, body } = opts;
  const runInput = await dehydrateStepArguments([], 'run', undefined);
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_test',
      workflowName: 'wf',
      input: runInput,
    },
  });
  const runId = created.run!.runId;
  await world.events.create(runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {},
  } as never);

  const stepId = `step_tc_${counter}`;
  // Step inputs are serialized as { args, closureVars, thisVal } — the shape
  // the suspension handler enqueues (see suspension-handler.ts).
  const stepInput = await dehydrateStepArguments(
    { args: [], closureVars: undefined, thisVal: null },
    runId,
    undefined
  );
  await world.events.create(runId, {
    eventType: 'step_created',
    specVersion: SPEC_VERSION_CURRENT,
    correlationId: stepId,
    eventData: { stepName, input: stepInput },
  });

  registerStepFunction(
    stepName,
    Object.assign(body, { maxRetries: opts.maxRetries ?? 3 })
  );
  return { runId, stepId };
}

function runStep(
  world: World,
  runId: string,
  stepId: string,
  stepName: string
) {
  return executeStep({
    world,
    workflowRunId: runId,
    workflowName: 'wf',
    workflowStartedAt: Date.now(),
    stepId,
    stepName,
  });
}

type RecordedEvent = { name: string; ctx: StepTracingContext };

function recordEvents(): { events: RecordedEvent[]; cleanup: () => void } {
  const events: RecordedEvent[] = [];
  const rec = (name: string) => (ctx: StepTracingContext) => {
    events.push({ name, ctx: { ...ctx } });
  };
  const handlers = {
    start: rec('start'),
    end: rec('end'),
    asyncStart: rec('asyncStart'),
    asyncEnd: rec('asyncEnd'),
    error: rec('error'),
  };
  channel.subscribe(handlers);
  return { events, cleanup: () => channel.unsubscribe(handlers) };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  counter += 1;
  while (cleanups.length) cleanups.pop()?.();
});

describe('workflow.step channel — payload and sequencing', () => {
  it('publishes start/end/asyncStart/asyncEnd with full metadata payload on success', async () => {
    const { events, cleanup } = recordEvents();
    cleanups.push(cleanup);

    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      body: async () => 'a-return-value-subscribers-must-not-see',
    });

    const result = await runStep(world, runId, stepId, stepName);
    expect(result.type).toBe('completed');

    expect(events.map((e) => e.name)).toEqual([
      'start',
      'end',
      'asyncStart',
      'asyncEnd',
    ]);
    for (const e of events) {
      expect(e.ctx.runId).toBe(runId);
      expect(e.ctx.stepId).toBe(stepId);
      expect(e.ctx.stepName).toBe(stepName);
      expect(e.ctx.workflowName).toBe('wf');
      expect(e.ctx.attempt).toBe(1);
      // Step return values must never reach subscribers: the traced fn
      // resolves undefined, so TracingChannel's context.result carries
      // nothing.
      expect(
        (e.ctx as Record<string, unknown>).result,
        `event ${e.name} leaked a result`
      ).toBeUndefined();
    }
  });

  it('fires error exactly once per retryable attempt, classified retryable, then a clean attempt 2', async () => {
    const { events, cleanup } = recordEvents();
    cleanups.push(cleanup);

    const world = makeWorld();
    const stepName = uniqueStepName();
    let calls = 0;
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      body: async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient boom');
        return 'ok';
      },
    });

    const first = await runStep(world, runId, stepId, stepName);
    expect(first.type).toBe('retry');

    const errors = events.filter((e) => e.name === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0].ctx.error as Error).message).toBe('transient boom');
    expect(errors[0].ctx.classification).toBe('retryable');
    expect(errors[0].ctx.attempt).toBe(1);
    // TracingChannel ordering for a rejected promise: `end` fires at
    // synchronous return, `error` when the promise rejects.
    expect(events.map((e) => e.name)).toEqual([
      'start',
      'end',
      'error',
      'asyncStart',
      'asyncEnd',
    ]);

    events.length = 0;
    const second = await runStep(world, runId, stepId, stepName);
    expect(second.type).toBe('completed');
    expect(events.filter((e) => e.name === 'error')).toHaveLength(0);
    expect(events.find((e) => e.name === 'start')?.ctx.attempt).toBe(2);
  });

  it('classifies a FatalError throw as fatal', async () => {
    const { events, cleanup } = recordEvents();
    cleanups.push(cleanup);

    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      body: async () => {
        throw new FatalError('unrecoverable');
      },
    });

    const result = await runStep(world, runId, stepId, stepName);
    expect(result.type).toBe('failed');
    const errors = events.filter((e) => e.name === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].ctx.classification).toBe('fatal');
  });
});

describe('workflow.step channel — async context flow', () => {
  it('ALS store bound on start survives nested awaits inside the step body', async () => {
    const als = new AsyncLocalStorage<StepTracingContext>();
    channel.start.bindStore(als, (ctx) => ctx);
    cleanups.push(() => channel.start.unbindStore(als));

    const world = makeWorld();
    const stepName = uniqueStepName();
    const seen: Array<string | undefined> = [];
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      body: async () => {
        seen.push(als.getStore()?.stepId);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(als.getStore()?.stepId);
        await (async () => {
          await Promise.resolve();
          await new Promise((r) => setImmediate(r));
          seen.push(als.getStore()?.stepId);
        })();
        seen.push(als.getStore()?.stepId);
        return 'ok';
      },
    });

    const result = await runStep(world, runId, stepId, stepName);
    expect(result.type).toBe('completed');
    expect(seen).toEqual([stepId, stepId, stepId, stepId]);
  });

  it('does not bleed context across concurrently executing steps', async () => {
    const als = new AsyncLocalStorage<StepTracingContext>();
    channel.start.bindStore(als, (ctx) => ctx);
    cleanups.push(() => channel.start.unbindStore(als));

    const mismatches: string[] = [];
    const makeBody = (expectedStepId: () => string) => {
      return async () => {
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, Math.random() * 3));
          const got = als.getStore()?.stepId;
          if (got !== expectedStepId()) {
            mismatches.push(`expected ${expectedStepId()}, saw ${got}`);
          }
        }
        return 'ok';
      };
    };

    const worldA = makeWorld();
    const stepNameA = uniqueStepName();
    let stepIdA = '';
    const a = await setupRunningStep({
      world: worldA,
      stepName: stepNameA,
      body: makeBody(() => stepIdA),
    });
    stepIdA = a.stepId;

    counter += 1;
    const worldB = makeWorld();
    const stepNameB = uniqueStepName();
    let stepIdB = '';
    const b = await setupRunningStep({
      world: worldB,
      stepName: stepNameB,
      body: makeBody(() => stepIdB),
    });
    stepIdB = b.stepId;

    const [ra, rb] = await Promise.all([
      runStep(worldA, a.runId, a.stepId, stepNameA),
      runStep(worldB, b.runId, b.stepId, stepNameB),
    ]);
    expect(ra.type).toBe('completed');
    expect(rb.type).toBe('completed');
    expect(mismatches).toEqual([]);
  });
});

describe('workflow.step channel — OTel subscriber end to end', () => {
  it('a fetch inside the step body parents (transitively) under a subscriber-opened attempt span', async () => {
    // OTel pipeline as a runtime binding would construct it.
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    const contextManager = new AsyncLocalStorageContextManager();
    contextManager.enable();
    otelContext.setGlobalContextManager(contextManager);
    otelTrace.setGlobalTracerProvider(provider);
    const undiciInstr = new UndiciInstrumentation();
    undiciInstr.setTracerProvider(provider);
    undiciInstr.enable();
    cleanups.push(() => {
      undiciInstr.disable();
      otelTrace.disable();
      otelContext.disable();
      contextManager.disable();
    });

    const tracer = provider.getTracer('workflow-step-subscriber');
    // Bind the context manager's underlying storage to the channel's start
    // event: the attempt span becomes the active context for the entire step
    // body, so any auto-instrumentation parents under it.
    const otelAls = (
      contextManager as unknown as {
        _asyncLocalStorage: AsyncLocalStorage<Context>;
      }
    )._asyncLocalStorage;
    const spansByStepId = new Map<
      string,
      ReturnType<typeof tracer.startSpan>
    >();
    channel.start.bindStore(otelAls, (ctx: StepTracingContext) => {
      const span = tracer.startSpan(`workflow.step.attempt ${ctx.stepName}`, {
        attributes: {
          'workflow.run_id': ctx.runId,
          'workflow.step_id': ctx.stepId,
          'workflow.attempt': ctx.attempt,
        },
      });
      spansByStepId.set(ctx.stepId, span);
      return otelTrace.setSpan(otelContext.active(), span);
    });
    const endHandlers = {
      asyncEnd: (ctx: StepTracingContext) => {
        spansByStepId.get(ctx.stepId)?.end();
      },
      error: (ctx: StepTracingContext) => {
        spansByStepId.get(ctx.stepId)?.end();
      },
    };
    channel.subscribe(endHandlers);
    cleanups.push(() => {
      channel.start.unbindStore(otelAls);
      channel.unsubscribe(endHandlers);
    });

    const server: Server = createServer((_req, res) => res.end('hello'));
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    cleanups.push(() => server.close());

    const world = makeWorld();
    const stepName = uniqueStepName();
    const { runId, stepId } = await setupRunningStep({
      world,
      stepName,
      body: async () => {
        const res = await fetch(`http://127.0.0.1:${port}/hello`);
        return await res.text();
      },
    });

    const result = await runStep(world, runId, stepId, stepName);
    expect(result.type).toBe('completed');

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const attemptSpan = spans.find((s) =>
      s.name.startsWith('workflow.step.attempt')
    );
    expect(attemptSpan).toBeDefined();
    const undiciSpan = spans.find((s) =>
      s.attributes['url.full']?.toString().includes(`127.0.0.1:${port}`)
    );
    expect(undiciSpan).toBeDefined();

    // Walk ancestry: the undici span must reach the attempt span through its
    // parent chain. Intermediate spans (the runtime's own step.execute) are
    // expected — the channel composes with the SDK's built-in OTel tracing.
    const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
    const chain: string[] = [];
    let cur: ReadableSpan | undefined = undiciSpan;
    let reachedAttempt = false;
    for (let hops = 0; cur && hops < 10; hops++) {
      const parentId = (cur as unknown as { parentSpanId?: string })
        .parentSpanId;
      if (!parentId) break;
      cur = byId.get(parentId);
      if (cur) chain.push(cur.name);
      if (cur === attemptSpan) {
        reachedAttempt = true;
        break;
      }
    }
    expect(reachedAttempt, `ancestry chain: ${chain.join(' -> ')}`).toBe(true);
    expect(undiciSpan!.spanContext().traceId).toBe(
      attemptSpan!.spanContext().traceId
    );
  });
});
