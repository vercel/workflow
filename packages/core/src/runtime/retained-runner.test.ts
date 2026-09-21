import { channel } from 'node:diagnostics_channel';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowWorldError } from '@workflow/errors';
import {
  type Event,
  type EventResult,
  getEventDataPayloadField,
  MessageId,
  requireEventSlot,
  SPEC_VERSION_CURRENT,
  ValidQueueName,
  type World,
} from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { ulid } from 'ulid';
import { afterEach, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import { deriveRunKeyPair } from '../sealed-box.js';
import { sealTo } from '../serialization/encryption.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { executeOwnedStep } from './owned-step.js';
import { RetainedRunner, withRetainedRunner } from './retained-runner.js';
import * as stepExecutor from './step-executor.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});
const code = `
  const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
  const write = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('retainedWrite');
  async function workflow() {
    const hook = createHook({ token: 'retained-token' });
    let count = 0;
    for await (const input of hook) {
      await write(input);
      if (++count === 3) break;
    }
    hook[Symbol.dispose]();
    return count;
  }
  globalThis.__private_workflows = new Map([['workflow', workflow]]);
`;

const parallelCode = `
  const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
  const work = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('queuedWork');
  async function workflow() {
    const hook = createHook({ token: 'retained-token' });
    await hook;
    const results = await Promise.all([work(0), work(1)]);
    hook[Symbol.dispose]();
    return results;
  }
  globalThis.__private_workflows = new Map([['workflow', workflow]]);
`;

async function queuedFixture() {
  const fixture = await setup(parallelCode, false, true);
  fixture.world.capabilities = { ...fixture.world.capabilities, invoke: true };
  const queue = vi
    .spyOn(fixture.world, 'queue')
    .mockResolvedValue({ messageId: null });
  const invoke = vi.fn(async (runId, input, options) =>
    fixture.owner.submit(
      {
        runId,
        invoke: true,
        input,
        requestId: options?.idempotencyKey,
      },
      fixture.metadata
    )
  );
  fixture.world.invoke = invoke;
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  await fixture.send('fanout', 'start');
  const messages = queue.mock.calls
    .map((call) => call[1])
    .filter((message) => 'stepId' in message);
  return { ...fixture, queue, invoke, messages };
}

it('dispatches admitted steps, executes concurrent workers without worker writes, and preserves completion order', async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const started: number[] = [];
  registerStepFunction('queuedWork', async (value) => {
    const n = value as number;
    started.push(n);
    await gates[n].promise;
    return n;
  });
  const fixture = await queuedFixture();
  expect(fixture.messages).toHaveLength(2);
  expect(started).toEqual([]);
  for (const message of fixture.messages) {
    if (!('stepId' in message)) throw new Error('not a step');
    expect(
      (await fixture.world.steps.get(fixture.runId, message.stepId!)).status
    ).toBe('running');
  }
  const write = vi.spyOn(fixture.world.events, 'create');
  const workers = fixture.messages.map((message) =>
    executeOwnedStep(fixture.world, message, fixture.metadata)
  );
  await vi.waitFor(() => expect(started).toEqual([0, 1]));
  expect(write).not.toHaveBeenCalled();
  gates[1].resolve();
  await workers[1];
  const first = fixture.owner.events.filter(
    (event) => event.eventType === 'step_completed'
  );
  expect(first).toHaveLength(1);
  expect(first[0].correlationId).toBe(
    (fixture.messages[1] as { stepId: string }).stepId
  );
  gates[0].resolve();
  await workers[0];
  await fixture.finished;
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
    'completed'
  );
  expect(
    fixture.invoke.mock.calls.filter(
      ([, input]) => input.type === 'step_result'
    )
  ).toHaveLength(2);
  expect(
    fixture.owner.events.filter((event) => event.eventType === 'step_started')
  ).toHaveLength(2);
});

it('retries a lost result acknowledgement with the original outcome, without rerunning the body', async () => {
  const body = vi.fn(async (n) => n);
  registerStepFunction('queuedWork', body);
  const fixture = await queuedFixture();
  let lose = true;
  const invoke = fixture.world.invoke!;
  fixture.world.invoke = async (...args) => {
    const reply = await invoke(...args);
    if (lose && (args[1] as { type: string }).type === 'step_result') {
      lose = false;
      throw new WorkflowWorldError('Lost ACK', { status: 502 });
    }
    return reply;
  };
  await expect(
    executeOwnedStep(fixture.world, fixture.messages[0], fixture.metadata)
  ).rejects.toThrow('Lost ACK');
  await executeOwnedStep(fixture.world, fixture.messages[0], {
    ...fixture.metadata,
    attempt: 2,
  });
  expect(body).toHaveBeenCalledTimes(1);
  expect(
    fixture.owner.events.filter((event) => event.eventType === 'step_completed')
  ).toHaveLength(1);
  await executeOwnedStep(fixture.world, fixture.messages[1], fixture.metadata);
  await fixture.finished;
});

it('holds a queued result acknowledgement behind the owner flush barrier', async () => {
  registerStepFunction('queuedWork', async (n) => n);
  const fixture = await queuedFixture();
  const create = fixture.world.events.create.bind(fixture.world.events);
  // Install a session before a replacement owner bootstraps, so the real result
  // path (rather than the fixture's transport) is responsible for its barrier.
  await fixture.finished;
  const gate = Promise.withResolvers<void>();
  let blocked = false;
  let awaitingFlush = false;
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => create(fixture.runId, event, params),
    stage: (event, params) => create(fixture.runId, event, params),
    flush: async () => {
      if (blocked) {
        awaitingFlush = true;
        await gate.promise;
      }
    },
    dispose() {},
  });
  const owner = new RetainedRunner(
    fixture.world,
    fixture.runId,
    '__wkf_workflow_',
    parallelCode,
    fixture.metadata,
    () => {},
    500
  );
  fixture.world.invoke = (runId, input, options) =>
    owner.submit(
      {
        runId,
        invoke: true,
        requestId: options?.idempotencyKey,
        input,
      },
      fixture.metadata
    );
  blocked = true;
  let settled = false;
  const worker = executeOwnedStep(
    fixture.world,
    fixture.messages[0],
    fixture.metadata
  ).then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(awaitingFlush).toBe(true));
  expect(settled).toBe(false);
  gate.resolve();
  await worker;
  await executeOwnedStep(fixture.world, fixture.messages[1], fixture.metadata);
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
    'completed'
  );
});

it('does not publish queued bodies before the start prefix is durable', async () => {
  registerStepFunction('queuedWork', async (n) => n);
  const fixture = await setup(parallelCode, false, true);
  fixture.world.capabilities = { ...fixture.world.capabilities, invoke: true };
  fixture.world.invoke = (runId, input, options) =>
    fixture.owner.submit(
      {
        runId,
        invoke: true,
        requestId: options?.idempotencyKey,
        input,
      },
      fixture.metadata
    );
  const queue = vi
    .spyOn(fixture.world, 'queue')
    .mockResolvedValue({ messageId: null });
  const create = fixture.world.events.create.bind(fixture.world.events);
  const gate = Promise.withResolvers<void>();
  let block = false;
  let flushing = false;
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => create(fixture.runId, event, params),
    stage: (event, params) => create(fixture.runId, event, params),
    flush: async () => {
      if (block) {
        flushing = true;
        await gate.promise;
      }
    },
    dispose() {},
  });
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  block = true;
  const send = fixture.send('admission', 'start');
  await vi.waitFor(() => expect(flushing).toBe(true));
  expect(queue.mock.calls.some(([, payload]) => 'stepId' in payload)).toBe(
    false
  );
  expect(queue.mock.calls.some(([, , options]) => options?.delaySeconds)).toBe(
    true
  );
  gate.resolve();
  await send;
  const messages = queue.mock.calls
    .map(([, payload]) => payload)
    .filter((payload) => 'stepId' in payload);
  const legacy = vi.fn();
  const workerHandler = withRetainedRunner(
    fixture.world,
    '__wkf_workflow_',
    parallelCode
  )(legacy);
  const list = vi
    .spyOn(fixture.world.events, 'list')
    .mockRejectedValue(new Error('worker read history'));
  await Promise.all(
    messages.map((message) => workerHandler(message, fixture.metadata))
  );
  expect(list).not.toHaveBeenCalled();
  expect(legacy).not.toHaveBeenCalled();
  await fixture.finished;
});

it('rejects a contradictory result while another fan-out branch remains active', async () => {
  registerStepFunction('queuedWork', async (n) => n);
  const fixture = await queuedFixture();
  await executeOwnedStep(fixture.world, fixture.messages[0], fixture.metadata);
  const original = fixture.invoke.mock.calls.find(
    ([, input]) => input.type === 'step_result'
  )![1];
  const changed = structuredClone(original);
  changed.outcome.eventData.result = await dehydrateStepReturnValue(
    'changed',
    fixture.runId,
    undefined,
    [],
    globalThis,
    false
  );
  await expect(
    fixture.world.invoke!(fixture.runId, changed, {
      idempotencyKey: 'conflict',
    })
  ).rejects.toThrow('conflict');
  await fixture.finished;
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
});

it('a late result cannot fault an execution already superseded by a timeout', async () => {
  registerStepFunction('queuedWork', async (n) => n);
  const fixture = await queuedFixture();
  const message = fixture.messages[0] as {
    stepId: string;
    input: { executionId: string; attempt: number; deadline: number };
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(message.input.deadline + 100);
    await fixture.world.invoke!(
      fixture.runId,
      {
        type: 'step_status',
        version: 1,
        stepId: message.stepId,
        executionId: message.input.executionId,
        attempt: message.input.attempt,
      },
      { idempotencyKey: 'recovery' }
    );
    const response = await fixture.world.invoke!(
      fixture.runId,
      {
        type: 'step_result',
        version: 1,
        stepId: message.stepId,
        executionId: message.input.executionId,
        attempt: message.input.attempt,
        outcome: {
          eventType: 'step_completed',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: message.stepId,
          eventData: {
            stepName: 'queuedWork',
            workflowName: 'workflow',
            result: await dehydrateStepReturnValue(
              'late',
              fixture.runId,
              undefined,
              [],
              globalThis,
              false
            ),
          },
        },
      },
      { idempotencyKey: 'late' }
    );
    expect(response).toEqual({ status: 'superseded' });
    expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
      'running'
    );
    await fixture.world.invoke!(
      fixture.runId,
      { type: 'run_cancel', version: 1 },
      { idempotencyKey: 'cancel' }
    );
    await fixture.finished;
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  false,
  true,
])('observes nested owner snapshot reads and closes initialization on failure=%s', async (failRead) => {
  const fixture = await setup();
  const observations: Record<string, unknown>[] = [];
  const receive = (message: unknown) => {
    const event = message as Record<string, unknown>;
    if (event.runId === fixture.runId) observations.push(event);
  };
  channel('workflow.runner').subscribe(receive);
  cleanups.push(async () => channel('workflow.runner').unsubscribe(receive));
  const gate = Promise.withResolvers<void>();
  const list = fixture.world.events.list.bind(fixture.world.events);
  vi.spyOn(fixture.world.events, 'list').mockImplementation(async (params) => {
    await gate.promise;
    if (failRead) throw new Error('snapshot unavailable');
    return list(params);
  });
  const startup = fixture.owner.submit(
    { runId: fixture.runId },
    fixture.metadata
  );
  const outcome = startup.then(
    () => undefined,
    (error: unknown) => error
  );
  await vi.waitFor(() =>
    expect(observations.some((e) => e.phase === 'load_events')).toBe(true)
  );
  const initial = observations.find(
    (e) => e.phase === 'initialize' && e.event === 'begin'
  )!;
  for (const phase of ['load_run', 'load_events', 'load_steps'])
    expect(
      observations.find((e) => e.phase === phase && e.event === 'begin')
        ?.parentSpanId
    ).toBe(initial.spanId);
  expect(
    observations.some((e) => e.phase === 'initialize' && e.event === 'end')
  ).toBe(false);
  gate.resolve();
  const error = await outcome;
  expect(Boolean(error)).toBe(failRead);
  const ended = observations.find(
    (e) => e.phase === 'initialize' && e.event === 'end'
  );
  expect(ended?.status).toBe(failRead ? 'error' : 'completed');
  expect(ended?.elapsedMs).toBeGreaterThanOrEqual(0);
  if (!failRead) {
    expect(
      observations.find((e) => e.phase === 'load_events' && e.event === 'end')
    ).toMatchObject({ pageCount: 1, eventCount: 1 });
    expect(
      observations.find((e) => e.phase === 'apply_history' && e.event === 'end')
    ).toMatchObject({ parentSpanId: initial.spanId, eventCount: 1 });
    expect(
      observations.some(
        (e) => e.phase === 'replay_prewarm' && e.event === 'end'
      )
    ).toBe(true);
  }
  await fixture.finished;
});

it('groups buffered input/create/start and awaits durability before user code or acknowledgement', async () => {
  const fixture = await setup();
  const create = fixture.world.events.create.bind(fixture.world.events);
  const staged: string[] = [];
  const batches: string[][] = [];
  let block = false;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let body = false;
  registerStepFunction('retainedWrite', async () => {
    body = true;
  });
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => create(fixture.runId, event, params),
    stage: async (event, params) => {
      staged.push(event.eventType);
      return create(fixture.runId, event, params);
    },
    flush: async () => {
      if (!staged.length) return;
      if (block) await barrier;
      batches.push(staged.splice(0));
    },
    dispose() {},
  });
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  block = true;
  let acknowledged = false;
  const input = fixture.send('buffered', 'one').then(() => {
    acknowledged = true;
  });
  await vi.waitFor(() => expect(staged).toContain('step_started'));
  expect(body).toBe(false);
  expect(acknowledged).toBe(false);
  release();
  await input;
  await vi.waitFor(() => expect(body).toBe(true));
  expect(batches).toContainEqual([
    'hook_received',
    'step_created',
    'step_started',
  ]);
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
});

it('uses owner-session bootstrap reads instead of the public storage transport', async () => {
  const fixture = await setup();
  const run = await fixture.world.runs.get(fixture.runId);
  const events = await fixture.world.events.list({ runId: fixture.runId });
  const reads = {
    getRun: vi.fn().mockResolvedValue(run),
    listEvents: vi.fn().mockResolvedValue(events),
    listSteps: vi
      .fn()
      .mockResolvedValue({ data: [], hasMore: false, cursor: null }),
  };
  const create = fixture.world.events.create.bind(fixture.world.events);
  fixture.world.events.createWriteSession = () => ({
    reads,
    create: (event, params) => create(fixture.runId, event, params),
    dispose() {},
  });
  vi.spyOn(fixture.world.runs, 'get').mockRejectedValue(
    new Error('HTTP run read')
  );
  vi.spyOn(fixture.world.events, 'list').mockRejectedValue(
    new Error('HTTP event read')
  );
  vi.spyOn(fixture.world.steps, 'list').mockRejectedValue(
    new Error('HTTP step read')
  );
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  expect(reads.getRun).toHaveBeenCalledTimes(1);
  expect(reads.listEvents).toHaveBeenCalledTimes(1);
  expect(reads.listSteps).toHaveBeenCalledTimes(1);
  await fixture.finished;
});

it('fails a buffered durability barrier without running the user step', async () => {
  const fixture = await setup();
  const create = fixture.world.events.create.bind(fixture.world.events);
  const body = vi.fn();
  registerStepFunction('retainedWrite', body);
  let fail = false;
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => create(fixture.runId, event, params),
    stage: (event, params) => create(fixture.runId, event, params),
    flush: async () => {
      if (fail) throw new Error('durability failed');
    },
    dispose() {},
  });
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  fail = true;
  await expect(fixture.send('buffered-failure', 'one')).rejects.toThrow();
  expect(body).not.toHaveBeenCalled();
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
});

it('uses canonical materialized step state returned by flush before invoking the body', async () => {
  const fixture = await setup();
  const create = fixture.world.events.create.bind(fixture.world.events);
  const results: EventResult[] = [];
  let canonicalStart: Date | undefined;
  const execute = vi.spyOn(stepExecutor, 'executeStep');
  const body = vi.fn();
  registerStepFunction('retainedWrite', body);
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => create(fixture.runId, event, params),
    stage: async (event, params) => {
      const result = await create(fixture.runId, event, params);
      results.push(result);
      if (result.step?.startedAt && event.eventType === 'step_started') {
        canonicalStart = result.step.startedAt;
        return {
          ...result,
          step: { ...result.step, startedAt: new Date(+canonicalStart - 100) },
        };
      }
      return result;
    },
    flush: async () => results.splice(0),
    dispose() {},
  });
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  await fixture.send('canonical-flush', 'one');
  await vi.waitFor(() => expect(body).toHaveBeenCalled());
  expect(execute.mock.calls[0][0].preclaimedStart?.step.startedAt).toEqual(
    canonicalStart
  );
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
});

it('rejects a changed event clock from flush before running user code', async () => {
  const fixture = await setup();
  const create = fixture.world.events.create.bind(fixture.world.events);
  const results: EventResult[] = [];
  const body = vi.fn();
  registerStepFunction('retainedWrite', body);
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => create(fixture.runId, event, params),
    stage: async (event, params) => {
      const result = await create(fixture.runId, event, params);
      results.push(
        result.event?.eventType === 'hook_received'
          ? {
              ...result,
              event: {
                ...result.event,
                createdAt: new Date(+result.event.createdAt + 1),
              },
            }
          : result
      );
      return result;
    },
    flush: async () => results.splice(0),
    dispose() {},
  });
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  await expect(fixture.send('wrong-clock', 'one')).rejects.toThrow();
  expect(body).not.toHaveBeenCalled();
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
});

function lazyEvent(
  event: Event,
  representation: 'reference' | 'omitted'
): Event {
  const field = getEventDataPayloadField(event.eventType);
  if (!field || !event.eventData) return event;
  const eventData = { ...event.eventData } as Record<string, unknown>;
  if (eventData[field] instanceof Uint8Array) {
    if (representation === 'omitted') delete eventData[field];
    else
      eventData[field] = { _type: 'RemoteRef', _ref: 'opaque-test-reference' };
  }
  return { ...event, eventData } as Event;
}

it.each([
  'reference',
  'omitted',
] as const)('continues from lazy %s write acknowledgements without payload readback', async (representation) => {
  const values: unknown[] = [];
  registerStepFunction('retainedWrite', async (value) => {
    values.push(value);
  });
  const fixture = await setup();
  const create = fixture.world.events.create.bind(fixture.world.events);
  let previousHook: Event | undefined;
  vi.spyOn(fixture.world.events, 'create').mockImplementation((async (
    id,
    request,
    params
  ) => {
    const result = await create(id, request, { ...params, resolveData: 'all' });
    const wire: EventResult = {
      ...result,
      event: result.event ? lazyEvent(result.event, representation) : undefined,
    };
    for (const name of ['run', 'step', 'hook'] as const) {
      const entity = result[name];
      if (!entity) continue;
      const copy = { ...entity } as Record<string, unknown>;
      for (const field of ['input', 'output', 'error', 'metadata']) {
        if (!(copy[field] instanceof Uint8Array)) continue;
        if (representation === 'omitted') delete copy[field];
        else
          copy[field] = { _type: 'RemoteRef', _ref: 'opaque-entity-reference' };
      }
      Object.assign(wire, { [name]: copy });
    }
    if (request.eventType === 'hook_received') {
      if (previousHook)
        Object.assign(wire, {
          events: [lazyEvent(previousHook, representation)],
          cursor: null,
          hasMore: false,
        });
      previousHook = result.event;
    }
    return wire;
  }) as typeof fixture.world.events.create);
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const list = vi.spyOn(fixture.world.events, 'list');
  const get = vi.spyOn(fixture.world.events, 'get');
  await fixture.send('a', 'one');
  await fixture.send('a', 'one');
  await fixture.send('b', 'two');
  await fixture.send('c', 'three');
  await fixture.finished;
  expect(values).toEqual(['one', 'two', 'three']);
  expect(list).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(
    fixture.owner.events.filter((event) => event.eventType === 'hook_received')
  ).toHaveLength(3);
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
    'completed'
  );
});

it.each([
  'payload',
  'malformed-reference',
  'run',
  'resume',
  'slot',
  'token',
] as const)('still fails the run for a conflicting %s acknowledgement', async (corruption) => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const create = fixture.world.events.create.bind(fixture.world.events);
  vi.spyOn(fixture.world.events, 'create').mockImplementation((async (
    id,
    request,
    params
  ) => {
    const result = await create(id, request, { ...params, resolveData: 'all' });
    if (request.eventType !== 'hook_received' || !result.event) return result;
    const event = {
      ...result.event,
      eventData: { ...result.event.eventData },
    } as Event;
    if (corruption === 'run') event.runId = 'wrun_other';
    if (corruption === 'resume') event.resumeId = 'different-resume';
    if (corruption === 'slot')
      event.eventId = 'evnt_00000000000000000000000099';
    const data = event.eventData as Record<string, unknown>;
    if (corruption === 'payload') data.payload = new Uint8Array([255]);
    if (corruption === 'malformed-reference')
      data.payload = { unexpected: true };
    if (corruption === 'token') data.token = 'different-token';
    return { ...result, event };
  }) as typeof fixture.world.events.create);
  await expect(fixture.send('a', 'one')).rejects.toMatchObject({
    code: 'RETAINED_RUNNER_FAILED',
    kind: 'conflict',
    terminalPersisted: true,
    conflictReason: {
      payload: 'event_data',
      'malformed-reference': 'event_data',
      run: 'run_id',
      resume: 'resume_id',
      slot: 'event_slot',
      token: 'event_data',
    }[corruption],
  });
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
});

it('loads the startup snapshot within the backend pagination limit', async () => {
  const fixture = await setup();
  const list = fixture.world.steps.list.bind(fixture.world.steps);
  const requests = vi
    .spyOn(fixture.world.steps, 'list')
    .mockImplementation((async (params) => {
      if ((params.pagination?.limit ?? 100) > 100) {
        throw new WorkflowWorldError('Page size exceeds maximum of 100', {
          status: 400,
        });
      }
      if (!params.pagination?.cursor)
        return { data: [], hasMore: true, cursor: 'next-step-page' };
      return list({
        ...params,
        pagination: { ...params.pagination, cursor: undefined },
      });
    }) as typeof fixture.world.steps.list);
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  expect(requests).toHaveBeenCalledWith(
    expect.objectContaining({
      pagination: expect.objectContaining({ limit: 100 }),
    })
  );
  expect(requests).toHaveBeenCalledTimes(2);
  expect(requests).toHaveBeenLastCalledWith(
    expect.objectContaining({
      pagination: expect.objectContaining({
        limit: 100,
        cursor: 'next-step-page',
      }),
    })
  );
  expect(
    fixture.owner.events.some((event) => event.eventType === 'hook_created')
  ).toBe(true);
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
});

it('starts snapshot reads beside writer setup and retains one writer through detached steps', async () => {
  let finishStep!: () => void;
  const stepWait = new Promise<void>((resolve) => {
    finishStep = resolve;
  });
  const values: unknown[] = [];
  registerStepFunction('retainedWrite', async (value) => {
    values.push(value);
    if (value === 'one') await stepWait;
  });
  const fixture = await setup();
  const reads: string[] = [];
  let finishRunRead!: () => void;
  const runWait = new Promise<void>((resolve) => {
    finishRunRead = resolve;
  });
  const get = fixture.world.runs.get.bind(fixture.world.runs);
  vi.spyOn(fixture.world.runs, 'get').mockImplementation((async (
    ...args: Parameters<typeof get>
  ) => {
    reads.push('run');
    await runWait;
    return get(...args);
  }) as typeof get);
  const list = fixture.world.events.list.bind(fixture.world.events);
  vi.spyOn(fixture.world.events, 'list').mockImplementation(async (params) => {
    reads.push('events');
    return list(params);
  });
  const steps = fixture.world.steps.list.bind(fixture.world.steps);
  vi.spyOn(fixture.world.steps, 'list').mockImplementation((async (params) => {
    reads.push('steps');
    return steps(params);
  }) as typeof steps);
  const dispose = vi.fn();
  const write = vi.fn((event, params) =>
    fixture.world.events.create(fixture.runId, event, params)
  );
  const open = vi.fn(() => {
    reads.push('writer');
    return { create: write, dispose };
  });
  fixture.world.events.createWriteSession = open;
  const startup = fixture.owner.submit(
    { runId: fixture.runId },
    fixture.metadata
  );
  await vi.waitFor(() =>
    expect(reads).toEqual(['writer', 'run', 'events', 'steps'])
  );
  finishRunRead();
  await startup;
  await fixture.send('a', 'one');
  await vi.waitFor(() => expect(values).toEqual(['one']));
  await new Promise((resolve) => setTimeout(resolve, 60)); // Beyond the idle window, while a step is active.
  expect(dispose).not.toHaveBeenCalled();
  await fixture.send('b', 'two');
  await fixture.send('c', 'three');
  finishStep();
  // Draining three real filesystem-backed steps can exceed waitFor's 1s
  // polling budget on Windows CI. Await the lifecycle event itself.
  await fixture.finished;
  expect(values).toEqual(['one', 'two', 'three']);
  expect(open).toHaveBeenCalledTimes(1);
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(write.mock.calls.map(([event]) => event.eventType)).toEqual(
    expect.arrayContaining([
      'run_started',
      'hook_received',
      'step_created',
      'step_started',
      'step_completed',
      'run_completed',
    ])
  );
});

it.each([
  'snapshot',
  'write',
] as const)('releases the owner writer after a fatal %s failure', async (failure) => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  const dispose = vi.fn();
  fixture.world.events.createWriteSession = () => ({
    create: (event, params) => {
      if (event.eventType === 'hook_received') throw new Error('write failed');
      return fixture.world.events.create(fixture.runId, event, params);
    },
    dispose,
  });
  if (failure === 'snapshot')
    vi.spyOn(fixture.world.events, 'list').mockRejectedValue(
      new Error('snapshot failed')
    );
  const startup = fixture.owner.submit(
    { runId: fixture.runId },
    fixture.metadata
  );
  if (failure === 'snapshot') await expect(startup).rejects.toThrow();
  else {
    await startup;
    await expect(fixture.send('a', 'one')).rejects.toThrow();
  }
  await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
});

it('opens hook inputs sealed to the run while retaining its VM', async () => {
  const values: unknown[] = [];
  registerStepFunction('retainedWrite', async (value) => {
    values.push(value);
  });
  const fixture = await setup();
  const material = new Uint8Array(32).fill(7);
  fixture.world.getEncryptionKeyForRun = async () => material;
  const { publicKey } = await deriveRunKeyPair(material);
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const hook = fixture.owner.events.find(
    (event) => event.eventType === 'hook_created'
  );
  if (!hook || hook.eventType !== 'hook_created')
    throw new Error('hook missing');
  for (const value of ['one', 'two', 'three']) {
    await fixture.owner.submit(
      {
        runId: fixture.runId,
        invoke: true,
        requestId: value,
        input: {
          type: 'hook_resume',
          version: 1,
          hookId: hook.correlationId,
          token: hook.eventData.token,
          payload: await dehydrateStepReturnValue(
            value,
            fixture.runId,
            sealTo(publicKey),
            [],
            globalThis,
            false
          ),
        },
      },
      fixture.metadata
    );
  }
  await fixture.finished;
  expect(values).toEqual(['one', 'two', 'three']);
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
    'completed'
  );
});

async function setup(
  workflowCode = code,
  ownerJournal = false,
  queued = false
) {
  const directory = await mkdtemp(join(tmpdir(), 'retained-runner-'));
  const world = createWorld({ dataDir: directory }) as World;
  cleanups.push(async () => {
    await world.close?.();
    await rm(directory, { recursive: true, force: true });
  });
  const runId = `wrun_${ulid()}`;
  await world.events.create(runId, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'test',
      workflowName: 'workflow',
      executionContext: {
        retainedRunnerVersion: 1,
        ...(ownerJournal ? { ownerJournalVersion: 1 } : {}),
        ...(queued
          ? { stepExecution: { mode: 'queued', attemptTimeoutMs: 1000 } }
          : {}),
      },
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
    },
  });
  const metadata = {
    queueName: ValidQueueName.parse('__wkf_workflow_workflow'),
    messageId: MessageId.parse('initial-wake'),
    attempt: 1,
  };
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const retired = vi.fn(() => finish());
  const owner = new RetainedRunner(
    world,
    runId,
    '__wkf_workflow_',
    workflowCode,
    metadata,
    retired,
    queued ? 500 : 40
  );
  const send = async (requestId: string, value: string, target = owner) => {
    const hook = target.events.find(
      (event) => event.eventType === 'hook_created'
    );
    if (!hook || hook.eventType !== 'hook_created')
      throw new Error('hook not registered');
    return target.submit(
      {
        runId,
        invoke: true,
        requestId,
        input: {
          type: 'hook_resume',
          version: 1,
          hookId: hook.correlationId,
          token: hook.eventData.token,
          payload: await dehydrateStepReturnValue(
            value,
            runId,
            undefined,
            [],
            globalThis,
            false
          ),
        },
      },
      metadata
    );
  };
  return { owner, world, runId, metadata, send, retired, finished };
}

it('replays once, retains across hook inputs, and validates retries without backend reads', async () => {
  const values: unknown[] = [];
  registerStepFunction('retainedWrite', async (value) => {
    values.push(value);
  });
  const fixture = await setup();
  const modes: string[] = [];
  const receive = (value: unknown) => {
    const event = value as { runId: string; event: string; mode: string };
    if (event.runId === fixture.runId && event.event === 'begin')
      modes.push(event.mode);
  };
  channel('workflow.execution').subscribe(receive);
  cleanups.push(async () => {
    channel('workflow.execution').unsubscribe(receive);
  });
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const runs = vi.spyOn(fixture.world.runs, 'get');
  const hooks = vi.spyOn(fixture.world.hooks, 'getByToken');
  const events = vi.spyOn(fixture.world.events, 'list');
  await expect(fixture.send('a', 'one')).resolves.toEqual({
    status: 'accepted',
  });
  await expect(fixture.send('a', 'one')).resolves.toEqual({
    status: 'accepted',
  });
  await expect(fixture.send('a', 'changed')).rejects.toMatchObject({
    status: 409,
  });
  await expect(fixture.send('b', 'two')).resolves.toEqual({
    status: 'accepted',
  });
  await expect(fixture.send('c', 'three')).resolves.toEqual({
    status: 'accepted',
  });
  await vi.waitFor(() => expect(values).toEqual(['one', 'two', 'three']));
  await vi.waitFor(() =>
    expect(
      fixture.owner.events.some((event) => event.eventType === 'run_completed')
    ).toBe(true)
  );
  expect(runs).not.toHaveBeenCalled();
  expect(hooks).not.toHaveBeenCalled();
  expect(events).not.toHaveBeenCalled();
  expect(modes[0]).toBe('replay');
  expect(modes.filter((mode) => mode === 'replay')).toHaveLength(1);
  expect(modes.slice(1).every((mode) => mode === 'retained')).toBe(true);
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
});

it('fails every unfinished input and durably fails the run after a persistence failure', async () => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const create = fixture.world.events.create.bind(fixture.world.events);
  vi.spyOn(fixture.world.events, 'create').mockImplementation((async (
    id,
    event,
    params
  ) => {
    if (event.eventType === 'hook_received')
      throw new Error('write unavailable');
    return create(id, event, params);
  }) as typeof fixture.world.events.create);
  const results = await Promise.allSettled([
    fixture.send('a', 'one'),
    fixture.send('b', 'two'),
  ]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
  expect(
    fixture.owner.events.some((event) => event.eventType === 'hook_received')
  ).toBe(false);
});

it.each([
  false,
  true,
])('keeps terminal failure on the owner channel, broken=%s', async (broken) => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup(code, true);
  const create = fixture.world.events.create.bind(fixture.world.events);
  let failed = false;
  let head = 1;
  const disposed = vi.fn(async () => {});
  fixture.world.events.createWriteSession = () => ({
    get heads() {
      return { queued: head, committed: head };
    },
    dispose: disposed,
    create: async (event, params) => {
      if (failed) throw new Error('channel failed');
      if (broken && event.eventType === 'hook_received') {
        failed = true;
        throw new Error('uncertain storage write');
      }
      const result = await create(fixture.runId, event, params);
      if (result.event) head = requireEventSlot(result.event.eventId);
      if (event.eventType === 'hook_received' && result.event)
        return {
          ...result,
          event: { ...result.event, correlationId: 'unexpected-hook' },
        };
      return result;
    },
  });
  const native = vi.spyOn(fixture.world.events, 'create');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const results = await Promise.allSettled([
    fixture.send('a', 'one'),
    fixture.send('b', 'two'),
  ]);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected')
      expect(result.reason).toMatchObject({
        terminalPersisted: !broken,
      });
  }
  expect(native).not.toHaveBeenCalled();
  expect(disposed).toHaveBeenCalled();
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
    broken ? 'running' : 'failed'
  );
});

it('treats an unexpected returned event as fatal and records a durable terminal failure', async () => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const create = fixture.world.events.create.bind(fixture.world.events);
  vi.spyOn(fixture.world.events, 'create').mockImplementation((async (
    id,
    event,
    params
  ) => {
    const result = await create(id, event, params);
    if (event.eventType === 'hook_received' && result.event)
      return {
        ...result,
        event: { ...result.event, correlationId: 'unexpected-hook' },
      };
    return result;
  }) as typeof fixture.world.events.create);
  await expect(fixture.send('a', 'one')).rejects.toMatchObject({
    code: 'RETAINED_RUNNER_FAILED',
    kind: 'conflict',
    terminalPersisted: true,
  });
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('failed');
});

it('exposes failure to persist run_failed while rejecting unfinished inputs', async () => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const events: Record<string, unknown>[] = [];
  const receiver = (event: unknown) =>
    events.push(event as Record<string, unknown>);
  channel('workflow.runner').subscribe(receiver);
  cleanups.push(async () => {
    channel('workflow.runner').unsubscribe(receiver);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(fixture.world.events, 'create').mockRejectedValue(
    new Error('storage unavailable')
  );
  const results = await Promise.allSettled([
    fixture.send('a', 'one'),
    fixture.send('b', 'two'),
  ]);
  expect(results.every((result) => result.status === 'rejected')).toBe(true);
  expect(events).toContainEqual(
    expect.objectContaining({
      runId: fixture.runId,
      phase: 'failure',
      event: 'end',
      terminalPersisted: false,
      status: 'error',
    })
  );
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe('running');
});

it('holds acknowledgements behind persistence and serializes competing mailbox inputs', async () => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  const create = fixture.world.events.create.bind(fixture.world.events);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  let maximum = 0;
  let first = true;
  vi.spyOn(fixture.world.events, 'create').mockImplementation((async (
    id,
    event,
    params
  ) => {
    maximum = Math.max(maximum, ++active);
    try {
      if (event.eventType === 'hook_received' && first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return await create(id, event, params);
    } finally {
      active--;
    }
  }) as typeof fixture.world.events.create);
  let acknowledged = false;
  const a = fixture.send('a', 'one').then(() => {
    acknowledged = true;
  });
  await entered.promise;
  const b = fixture.send('b', 'two');
  expect(acknowledged).toBe(false);
  expect(
    fixture.owner.events.filter((event) => event.eventType === 'hook_received')
  ).toHaveLength(0);
  release.resolve();
  await Promise.all([a, b]);
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
  expect(maximum).toBe(1);
});

it('processes a self-hook while a step waits for its invocation result', async () => {
  let send: (id: string, value: string) => Promise<unknown>;
  registerStepFunction('sendRetainedHook', async () => {
    await send('self', 'value');
    return 'step done';
  });
  const fixture = await setup(`
    const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
    const send = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('sendRetainedHook');
    async function workflow() {
      const hook = createHook({ token: 'retained-token' });
      await Promise.all([send(), hook]);
      hook[Symbol.dispose]();
      return 'done';
    }
    globalThis.__private_workflows = new Map([['workflow', workflow]]);
  `);
  send = fixture.send;
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  await vi.waitFor(() =>
    expect(
      fixture.owner.events.some((event) => event.eventType === 'run_completed')
    ).toBe(true)
  );
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
});

it('commits cancellation through the mailbox and rejects later hook inputs', async () => {
  registerStepFunction('retainedWrite', async () => undefined);
  const fixture = await setup();
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  await fixture.owner.submit(
    {
      runId: fixture.runId,
      invoke: true,
      requestId: 'cancel',
      input: { type: 'run_cancel', version: 1 },
    },
    fixture.metadata
  );
  expect((await fixture.world.runs.get(fixture.runId)).status).toBe(
    'cancelled'
  );
  await expect(fixture.send('late', 'value')).rejects.toBeInstanceOf(Error);
});

it('reconstructs idempotency and VM state after an idle owner retires', async () => {
  const values: unknown[] = [];
  registerStepFunction('retainedWrite', async (value) => {
    values.push(value);
  });
  const fixture = await setup();
  const dispose = vi.fn();
  const open = vi.fn<NonNullable<World['events']['createWriteSession']>>(
    () => ({
      create: (event, params) =>
        fixture.world.events.create(fixture.runId, event, params),
      dispose,
    })
  );
  fixture.world.events.createWriteSession = open;
  await fixture.owner.submit({ runId: fixture.runId }, fixture.metadata);
  await fixture.send('a', 'one');
  await vi.waitFor(() => expect(fixture.retired).toHaveBeenCalled());
  const retiredAgain = vi.fn();
  const recovered = new RetainedRunner(
    fixture.world,
    fixture.runId,
    '__wkf_workflow_',
    code,
    fixture.metadata,
    retiredAgain,
    40
  );
  await recovered.submit({ runId: fixture.runId }, fixture.metadata);
  await fixture.send('a', 'one', recovered);
  await fixture.send('b', 'two', recovered);
  await fixture.send('c', 'three', recovered);
  await vi.waitFor(() => expect(retiredAgain).toHaveBeenCalled());
  expect(values).toEqual(['one', 'two', 'three']);
  expect(open).toHaveBeenCalledTimes(2);
  expect(dispose).toHaveBeenCalledTimes(2);
  expect(
    recovered.events.filter((event) => event.eventType === 'hook_received')
  ).toHaveLength(3);
});
