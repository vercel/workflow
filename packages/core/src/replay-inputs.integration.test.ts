import {
  EntityConflictError,
  RetryableError,
  TooEarlyError,
} from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type Step,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from './private.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import {
  dehydrateWorkflowArguments,
  hydrateStepArguments,
  hydrateStepError,
  hydrateWorkflowReturnValue,
} from './serialization.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: (promise: Promise<unknown>) => {
    promise.catch(() => {});
  },
}));
vi.mock('./runtime/get-port-lazy.js', () => ({
  getPortLazy: async () => 3000,
}));

type Message = {
  runId: string;
  stepId?: string;
  stepName?: string;
  replayInputs?: true;
  [key: string]: unknown;
};

/** Durable bytes survive each handler invocation; every delivery creates a fresh workflow VM. */
async function harness(code: string) {
  const runId = 'wrun_replay_inputs';
  const now = new Date('2026-06-01T00:00:00Z');
  const run: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    deploymentId: 'dpl_replay_inputs',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    input: await dehydrateWorkflowArguments([], runId, undefined, []),
  };
  const events: Event[] = [];
  const steps = new Map<string, Step>();
  const messages: Array<{ message: Message; options: any }> = [];
  const keys = new Set<string>();
  let delivery = 0;
  const append = (data: any) => {
    const event = {
      ...data,
      runId,
      eventId: slotToEventId(events.length + 1),
      createdAt: new Date(),
    } as Event;
    events.push(event);
    return event;
  };
  append({
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      input: run.input,
      workflowName: 'workflow',
      deploymentId: run.deploymentId,
    },
  });
  const create = async (
    _runId: string,
    data: any,
    params?: any
  ): Promise<any> => {
    if (data.eventType === 'run_started') return { run, events: [...events] };
    let step = steps.get(data.correlationId);
    if (
      data.eventType === 'step_created' ||
      (data.eventType === 'step_started' && data.eventData.input !== undefined)
    ) {
      if (step) throw new EntityConflictError('Step already exists');
      step = {
        runId,
        stepId: data.correlationId,
        stepName: data.eventData.stepName,
        input: data.eventData.input,
        status: 'pending',
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      };
      steps.set(data.correlationId, step);
      if (data.eventType === 'step_started')
        append({ ...data, eventType: 'step_created' });
    }
    if (data.eventType === 'step_started') {
      if (!step) throw new Error('Missing step');
      if (step.status === 'completed' || step.status === 'failed')
        throw new EntityConflictError('Step is terminal');
      if (step.retryAfter && +step.retryAfter > Date.now())
        throw new TooEarlyError('Retry delay has not elapsed', {
          retryAfter: 10,
        });
      step.status = 'running';
      step.attempt++;
      step.startedAt = now;
    }
    if (data.eventType === 'step_completed' && step) {
      step.status = 'completed';
      step.output = data.eventData.result;
    }
    if (data.eventType === 'step_failed' && step) {
      step.status = 'failed';
      step.error = data.eventData.error;
    }
    if (data.eventType === 'step_retrying' && step) {
      step.status = 'pending';
      step.error = data.eventData.error;
      step.retryAfter = data.eventData.retryAfter;
    }
    const event = append(data);
    return {
      event,
      ...(step ? { step: { ...step } } : {}),
      ...(data.eventType === 'step_started' &&
      data.eventData.input !== undefined
        ? { stepCreated: true }
        : {}),
      ...(params?.sinceCursor !== undefined
        ? {
            events: events.slice(Number(params.sinceCursor)),
            cursor: String(events.length),
            hasMore: false,
          }
        : {}),
    };
  };
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: { binaryQueuePayloads: true },
    createQueueHandler:
      (_prefix: string, handler: any) => async (request: Request) => {
        const message = await request.json();
        const outcome = await handler(message, {
          messageId: request.headers.get('message-id'),
          requestId: 'req_replay',
          attempt: 1,
          queueName: '__wkf_workflow_workflow',
        });
        if (outcome?.timeoutSeconds !== undefined)
          messages.push({
            message,
            options: { delaySeconds: outcome.timeoutSeconds },
          });
        return Response.json(outcome ?? null);
      },
    events: {
      create,
      list: async (options?: any) => ({
        data: events.slice(Number(options?.pagination?.cursor ?? 0)),
        cursor: String(events.length),
        hasMore: false,
      }),
    },
    runs: { get: async () => run },
    queue: async (_name: string, message: Message, options?: any) => {
      if (!options?.idempotencyKey || !keys.has(options.idempotencyKey)) {
        messages.push({ message: structuredClone(message), options });
        if (options?.idempotencyKey) keys.add(options.idempotencyKey);
      }
      return { messageId: `queued_${messages.length}` };
    },
    getEncryptionKeyForRun: async () => undefined,
  } as any);
  const deliver = async (
    message: Message = { runId },
    id = `message_${++delivery}`,
    source = code
  ) => {
    return workflowEntrypoint(source)(
      new Request('https://example.test', {
        method: 'POST',
        headers: { 'message-id': id },
        body: JSON.stringify(message),
      })
    );
  };
  const next = async (source = code) => {
    const queued = messages.shift();
    if (!queued) throw new Error('No queued message');
    keys.delete(queued.options?.idempotencyKey);
    await deliver(queued.message, undefined, source);
    return queued;
  };
  const result = async () => {
    const completed = events.findLast(
      (event) => event.eventType === 'run_completed'
    );
    return (
      completed &&
      (await hydrateWorkflowReturnValue(
        completed.eventData.output,
        runId,
        undefined,
        []
      ))
    );
  };
  return { run, runId, events, steps, messages, create, deliver, next, result };
}

function source(body: string, indices = '[0]') {
  return `const turn = globalThis[Symbol.for('WORKFLOW_USE_STEP')]('replay_turn');
    turn.replayInputs = ${indices};
    async function workflow() { ${body} }
    globalThis.__private_workflows = new Map([['workflow', workflow]]);`;
}

afterEach(() => {
  setWorld(undefined);
  vi.unstubAllEnvs();
});

for (const engine of ['node', 'quickjs'])
  describe(`${engine} replay-derived step inputs`, () => {
    it.each([
      '0',
      '1',
    ])('growing state stores only constant-sized deltas (retention=%s)', async (retained) => {
      vi.stubEnv('WORKFLOW_VM', engine);
      vi.stubEnv('WORKFLOW_RETAINED_VM', retained);
      const calls = vi.fn(async (state: string[], ordinary: number) => {
        expect(state).toHaveLength(ordinary);
        state.push('executor-only');
        return 'private-state-content';
      });
      registerStepFunction('replay_turn', calls);
      const h = await harness(
        source(
          `const state = []; for (let i = 0; i < 8; i++) { state.push(await turn(state, i)); } return state.length;`
        )
      );
      await h.deliver();
      expect(await h.result()).toBe(8);
      expect(calls).toHaveBeenCalledTimes(8);
      const sizes = [];
      for (const step of h.steps.values()) {
        const input = await hydrateStepArguments(
          step.input,
          h.runId,
          undefined
        );
        expect(input.args[0]).toBe('reconstructed through replay');
        expect(
          new TextDecoder().decode(step.input as Uint8Array)
        ).not.toContain('private-state-content');
        sizes.push((step.input as Uint8Array).byteLength);
      }
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(10);
    });

    it('cold queued overflow reconstructs parallel invocations and ignores later workflow mutations', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
      const calls = vi.fn(
        async (state: { value: string }, ordinary: number) =>
          `${state.value}:${ordinary}`
      );
      registerStepFunction('replay_turn', calls);
      const h = await harness(
        source(
          `const state = { value: 'private-state-content' }; const pending = [turn(state, 1), turn(state, 2), turn(state, 3)]; state.value = 'later'; return await Promise.all(pending);`
        )
      );
      await h.deliver();
      expect(calls).toHaveBeenCalledTimes(1);
      expect(h.messages).toHaveLength(2);
      for (const { message } of h.messages) {
        expect(message.replayInputs).toBe(true);
        expect(JSON.stringify(message)).not.toContain('private-state-content');
      }
      await h.next();
      await h.next();
      expect(await h.result()).toEqual(
        [1, 2, 3].map((n) => `private-state-content:${n}`)
      );
      expect(calls).toHaveBeenCalledTimes(3);
      await h.deliver();
      expect(calls).toHaveBeenCalledTimes(3);
    });

    it('reconstructs delayed retries and uses the committed input fingerprint', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const calls = vi.fn(async (state: { count: number }) => {
        expect(state.count).toBe(3);
        if (calls.mock.calls.length === 1)
          throw new RetryableError('try again', { retryAfter: '1 hour' });
        return state.count;
      });
      registerStepFunction('replay_turn', calls);
      const h = await harness(source('return await turn({ count: 3 });'));
      await h.deliver();
      expect(calls).toHaveBeenCalledTimes(1);
      expect(h.messages[0].message.replayInputs).toBe(true);
      expect(h.messages[0].options.delaySeconds).toBeGreaterThan(0);
      // A queue delivering too early must not execute the body.
      await h.next();
      expect(calls).toHaveBeenCalledTimes(1);
      for (const step of h.steps.values()) step.retryAfter = new Date(0);
      await h.next();
      expect(await h.result()).toBe(3);
      expect(calls).toHaveBeenCalledTimes(2);
    });

    it('a wake cannot bypass the queued backoff of a plain-error retry', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const calls = vi.fn(async () => {
        throw new Error('retry later');
      });
      registerStepFunction('replay_turn', calls);
      const h = await harness(source('return await turn({ n: 1 });'));
      await h.deliver();
      expect(h.messages).toHaveLength(1);
      expect(h.messages[0].options.delaySeconds).toBeGreaterThan(0);
      await h.deliver();
      expect(calls).toHaveBeenCalledTimes(1);
      expect(h.messages).toHaveLength(1);
    });

    it('rejects a changed reconstruction before retrying user code', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const calls = vi.fn(async () => {
        throw new Error('retry');
      });
      registerStepFunction('replay_turn', calls);
      const h = await harness(source('return await turn({ count: 3 });'));
      await h.deliver();
      await h.next(source('return await turn({ count: 4 });'));
      expect(calls).toHaveBeenCalledTimes(1);
      const failed = h.events.find(
        (event) => event.eventType === 'step_failed'
      );
      expect(failed).toBeDefined();
      if (failed?.eventType === 'step_failed') {
        expect(
          (await hydrateStepError(failed.eventData.error, h.runId, undefined))
            .message
        ).toContain('mismatch');
      }
    });

    it('applies indices to the original bound signature and keeps this and closure values persisted', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      registerStepFunction(
        'replay_turn',
        async function (
          this: any,
          fixed: string,
          state: { n: number },
          ordinary: string
        ) {
          return [this.label, fixed, state.n, ordinary];
        }
      );
      const h = await harness(
        source(
          `const bound = turn.bind({ label: 'receiver' }, 'fixed'); return await bound({ n: 7 }, 'ordinary');`,
          '[1]'
        ).replace(
          "('replay_turn');",
          "('replay_turn', () => ({ ordinaryClosure: 'captured' }));"
        )
      );
      await h.deliver();
      expect(await h.result()).toEqual(['receiver', 'fixed', 7, 'ordinary']);
      const input = await hydrateStepArguments(
        [...h.steps.values()][0].input,
        h.runId,
        undefined
      );
      expect(input.args).toEqual([
        'fixed',
        'reconstructed through replay',
        'ordinary',
      ]);
      expect(input.thisVal).toEqual({ label: 'receiver' });
      expect(input.closureVars).toEqual({ ordinaryClosure: 'captured' });
    });
    it('reconstructs multiple selected arguments while retaining the ordinary serializer', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      registerStepFunction(
        'replay_turn',
        async (left: { n: number }, date: Date, right: { n: number }) => [
          left.n,
          date.getUTCFullYear(),
          right.n,
        ]
      );
      const h = await harness(
        source(
          `return await turn({ n: 1 }, new Date('2020-01-01'), { n: 2 });`,
          '[0, 2]'
        )
      );
      await h.deliver();
      expect(await h.result()).toEqual([1, 2020, 2]);
      const input = await hydrateStepArguments(
        [...h.steps.values()][0].input,
        h.runId,
        undefined
      );
      expect(input.args[1]).toBeInstanceOf(Date);
      expect(
        input.replayInputs.arguments.map(
          (value: { index: number }) => value.index
        )
      ).toEqual([0, 2]);
    });

    it('rejects a nested proxy before invoking its traps', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const calls = vi.fn(async () => 1);
      registerStepFunction('replay_turn', calls);
      const h = await harness(
        source(`
        const state = { child: new Proxy({}, { getPrototypeOf() { throw new Error('trap ran'); } }) };
        try { await turn(state); } catch (error) { return error.message; }
      `)
      );
      await h.deliver();
      expect(await h.result()).toBe('replayInputs does not support proxies');
      expect(calls).not.toHaveBeenCalled();
      expect(h.steps.size).toBe(0);
    });
    it('recovers an interrupted inline owner in a cold VM without queueing its captured state', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const calls = vi.fn(async (state: { n: number }) => state.n);
      registerStepFunction('replay_turn', calls);
      const h = await harness(source('return await turn({ n: 4 });'));
      await h.deliver(undefined, 'owner');
      // Restore the durable prefix left by a process dying after the body ran
      // but before its output committed. User side effects may run again.
      h.events.splice(
        h.events.findIndex((event) => event.eventType === 'step_completed')
      );
      const step = [...h.steps.values()][0];
      step.status = 'running';
      delete step.output;
      await h.deliver(undefined, 'owner');
      expect(await h.result()).toBe(4);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(h.messages).toHaveLength(0);
    });

    it('recovers an interrupted queued attempt and enforces the total attempt limit', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
      const calls = vi.fn(
        async (state: { value: string }, n: number) => `${state.value}:${n}`
      );
      Object.assign(calls, { maxRetries: 1 });
      registerStepFunction('replay_turn', calls);
      const h = await harness(
        source(
          `return await Promise.all([turn({ value: 'state' }, 1), turn({ value: 'state' }, 2)]);`
        )
      );
      await h.deliver();
      const target = h.messages[0].message;
      // Durable state left by a process killed after claiming its queued step.
      await h.create(h.runId, {
        eventType: 'step_started',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: target.stepId,
        eventData: { stepName: 'replay_turn' },
      });
      await h.next();
      expect(await h.result()).toEqual(['state:1', 'state:2']);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(h.steps.get(target.stepId!)?.attempt).toBe(2);

      const exhausted = await harness(
        source(
          `return await Promise.all([turn({ value: 'state' }, 1), turn({ value: 'state' }, 2)]);`
        )
      );
      await exhausted.deliver();
      const exhaustedTarget = exhausted.messages[0].message;
      for (let attempt = 0; attempt < 2; attempt++) {
        await exhausted.create(exhausted.runId, {
          eventType: 'step_started',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: exhaustedTarget.stepId,
          eventData: { stepName: 'replay_turn' },
        });
      }
      const before = calls.mock.calls.length;
      await exhausted.next();
      expect(calls).toHaveBeenCalledTimes(before);
      expect(
        exhausted.events.some(
          (e) =>
            e.eventType === 'step_failed' &&
            e.correlationId === exhaustedTarget.stepId
        )
      ).toBe(true);
    });

    it('keeps recorded ordinary inputs on cold recovery even when replay computes a different ordinary value', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const calls = vi.fn(
        async (state: { value: string }, ordinary: string) => {
          if (calls.mock.calls.length === 1) throw new Error('retry');
          return `${state.value}:${ordinary}`;
        }
      );
      registerStepFunction('replay_turn', calls);
      const h = await harness(
        source(`return await turn({ value: 'state' }, 'recorded');`)
      );
      await h.deliver();
      await h.next(source(`return await turn({ value: 'state' }, 'changed');`));
      expect(await h.result()).toBe('state:recorded');
    });

    it('a concurrent wake does not execute a step while its inline owner is running', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      let release!: () => void;
      let entered!: () => void;
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const calls = vi.fn(async (state: { n: number }) => {
        entered();
        await gate;
        return state.n;
      });
      registerStepFunction('replay_turn', calls);
      const h = await harness(source('return await turn({ n: 9 });'));
      const owner = h.deliver(undefined, 'owner');
      await enteredPromise;
      try {
        await h.deliver(undefined, 'wake');
        expect(calls).toHaveBeenCalledTimes(1);
      } finally {
        release();
      }
      await owner;
      expect(await h.result()).toBe(9);
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it('does not execute a queued reconstruction after cancellation', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      vi.stubEnv('WORKFLOW_MAX_INLINE_STEPS', '1');
      const calls = vi.fn(async (state: { n: number }) => state.n);
      registerStepFunction('replay_turn', calls);
      const h = await harness(
        source('return await Promise.all([turn({ n: 1 }), turn({ n: 2 })]);')
      );
      await h.deliver();
      h.run.status = 'cancelled';
      await h.next();
      expect(calls).toHaveBeenCalledTimes(1);
    });

    it('benchmarks linear persisted bytes against full snapshots with fixed-size output deltas', async () => {
      vi.stubEnv('WORKFLOW_VM', engine);
      const measurements: Array<{
        count: number;
        replay: number;
        snapshots: number;
      }> = [];
      for (const count of [8, 16, 32]) {
        const row = { count, replay: 0, snapshots: 0 };
        for (const mode of ['replay', 'snapshots'] as const) {
          const calls = vi.fn(
            async (state: string[]) =>
              `${String(state.length).padStart(4, '0')}:${'x'.repeat(251)}`
          );
          registerStepFunction('replay_turn', calls);
          const h = await harness(
            source(
              `const state = []; for (let i = 0; i < ${count}; i++) state.push(await turn(state)); return state.length;`,
              mode === 'replay' ? '[0]' : '[]'
            )
          );
          await h.deliver();
          expect(await h.result()).toBe(count);
          expect(calls).toHaveBeenCalledTimes(count);
          row[mode] = [...h.steps.values()].reduce(
            (sum, step) =>
              sum +
              (step.input as Uint8Array).byteLength +
              (step.output as Uint8Array).byteLength,
            0
          );
        }
        measurements.push(row);
      }
      expect(measurements[2].replay).toBe(measurements[0].replay * 4);
      expect(measurements[2].snapshots).toBeGreaterThan(
        measurements[0].snapshots * 10
      );
      console.table(measurements);
    });
  });
