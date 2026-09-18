import { EntityConflictError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type Step,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sequence } from './sequence.js';
import { splitSequenceEnvelope } from './serialization/sequence-envelope.js';
import { registerStepFunction } from './private.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import { dehydrateWorkflowArguments } from './serialization.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => p.catch(() => {}),
}));

describe('Sequence workflowEntrypoint integration', () => {
  afterEach(() => setWorld(undefined));
  it('seeds, appends, takes, and branches through authoritative inline results', async () => {
    const runId = 'wrun_history_runtime',
      now = new Date('2026-01-01');
    const run: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      deploymentId: 'dpl_test',
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
    };
    const events: Event[] = [];
    const steps = new Map<string, Step>();
    const append = (data: any) => {
      const event = {
        ...data,
        runId,
        eventId: slotToEventId(events.length + 1),
        createdAt: now,
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
        deploymentId: 'dpl_test',
      },
    });
    const stepsGet = vi.fn(async (_r: string, id: string) => steps.get(id)!);
    const create = vi.fn(async (_r: string, data: any, params?: any) => {
      if (data.eventType === 'run_started')
        return {
          run,
          events: [...events],
          cursor: String(events.length),
          hasMore: false,
        };
      let step = steps.get(data.correlationId);
      if (
        data.eventType === 'step_started' &&
        data.eventData.input !== undefined
      ) {
        if (step) throw new EntityConflictError('exists');
        step = {
          runId,
          stepId: data.correlationId,
          stepName: data.eventData.stepName,
          input: data.eventData.input,
          status: 'running',
          attempt: 1,
          createdAt: now,
          updatedAt: now,
          startedAt: now,
        };
        steps.set(data.correlationId, step);
        append({ ...data, eventType: 'step_created' });
      }
      if (data.eventType === 'step_completed' && step) {
        step.status = 'completed';
        step.output = data.eventData.result;
      }
      const event = append(data);
      return {
        event,
        step,
        stepCreated: data.eventType === 'step_started' ? true : undefined,
        ...(params?.sinceCursor !== undefined
          ? {
              events: events.slice(Number(params.sinceCursor)),
              cursor: String(events.length),
              hasMore: false,
            }
          : {}),
      };
    });
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      createQueueHandler:
        (_p: string, handler: any) => async (req: Request) => {
          await handler(await req.json(), {
            messageId: 'msg',
            requestId: 'req',
            attempt: 1,
            queueName: '__wkf_workflow_workflow',
          });
          return new Response(null, { status: 204 });
        },
      events: {
        create,
        list: async (opts: any) => {
          const data = events.slice(Number(opts?.pagination?.cursor ?? 0));
          for (const event of data) opts?.replayEventObserver?.(event);
          return { data, cursor: String(events.length), hasMore: false };
        },
      },
      runs: { get: async () => run },
      steps: { get: stepsGet },
      queue: async () => ({ messageId: null }),
      getEncryptionKeyForRun: async () => undefined,
    } as any);
    registerStepFunction('seed', async () => ({
      history: Sequence.from([{ n: 1 }, { n: 2 }]),
      ordinary: 'seed',
    }));
    registerStepFunction(
      'extend',
      async (input: { history: Sequence<{ n: number }>; ordinary: string }) => {
        expect(await input.history.toArray()).toEqual([{ n: 1 }, { n: 2 }]);
        return {
          history: input.history.append({ n: 3 }),
          prefix: input.history.take(1),
          ordinary: `${input.ordinary}:extended`,
        };
      }
    );
    const code = `const seed=globalThis[Symbol.for('WORKFLOW_USE_STEP')]('seed');const extend=globalThis[Symbol.for('WORKFLOW_USE_STEP')]('extend');async function workflow(){const first=await seed();const second=await extend(first);return {length:second.history.length,prefixLength:second.prefix.length,ordinary:second.ordinary};}globalThis.__private_workflows=new Map([['workflow',workflow]]);`;
    await workflowEntrypoint(code)(
      new Request('https://test', {
        method: 'POST',
        body: JSON.stringify({ runId, workflowName: 'workflow' }),
      })
    );
    expect(
      events.find((e) => e.eventType === 'run_completed')?.eventData.output
    ).toBeDefined();
    const recipes = [...steps.values()]
      .filter((step) => step.output)
      .flatMap((step) =>
        splitSequenceEnvelope(step.output as Uint8Array).parseRecipes()
      );
    const appended = recipes.find((recipe) => recipe.base);
    expect(appended?.base).toMatchObject({
      runId,
      stepId: expect.stringMatching(/^step_/),
      slot: 'hslot_0',
      length: 2,
    });
    expect(appended?.additions).toEqual([{ n: 3 }]);
    expect(stepsGet).not.toHaveBeenCalled();
  });
});
