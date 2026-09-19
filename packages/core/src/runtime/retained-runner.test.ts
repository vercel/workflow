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
import { RetainedRunner } from './retained-runner.js';
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

async function setup(workflowCode = code) {
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
      executionContext: { retainedRunnerVersion: 1 },
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
    40
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
