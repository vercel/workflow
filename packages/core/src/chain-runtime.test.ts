import { EntityConflictError } from '@workflow/errors';
import {
  type Event,
  SPEC_VERSION_CURRENT,
  type Step,
  slotToEventId,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Chain } from './chain.js';
import { registerStepFunction } from './private.js';
import { setWorld } from './runtime/world.js';
import { workflowEntrypoint } from './runtime.js';
import { splitChainEnvelope } from './serialization/chain-envelope.js';
import {
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: (p: Promise<unknown>) => p.catch(() => {}),
}));

describe('Chain workflowEntrypoint integration', () => {
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
    const bodyCounts = { seed: 0, extend: 0, verify: 0 };
    registerStepFunction('seed', async () => {
      bodyCounts.seed++;
      return {
        chain: Chain.from([{ n: 1 }, { n: 2 }]),
        ordinary: 'seed',
      };
    });
    registerStepFunction(
      'extend',
      async (chain: Chain<{ n: number }>, n: number, label: string) => {
        bodyCounts.extend++;
        return { chain: chain.append({ n }), ordinary: label };
      }
    );
    registerStepFunction(
      'verify',
      async (input: {
        base: Chain<{ n: number }>;
        main: { chain: Chain<{ n: number }>; ordinary: string };
        aside: { chain: Chain<{ n: number }>; ordinary: string };
      }) => {
        bodyCounts.verify++;
        expect(await input.base.toArray()).toEqual([{ n: 1 }, { n: 2 }]);
        expect(await input.main.chain.toArray()).toEqual([
          { n: 1 },
          { n: 2 },
          { n: 3 },
        ]);
        expect(await input.aside.chain.toArray()).toEqual([{ n: 1 }, { n: 4 }]);
        expect(input.main.ordinary).toBe('main');
        expect(input.aside.ordinary).toBe('aside');
        return { base: 2, main: 3, aside: 2, checked: true };
      }
    );
    const { build } = await import('esbuild');
    const bootstrap = await build({
      entryPoints: [new URL('workflow/bootstrap.ts', import.meta.url).pathname],
      bundle: true,
      format: 'cjs',
      platform: 'neutral',
      conditions: ['workflow'],
      write: false,
    });
    const code = `${bootstrap.outputFiles[0].text};const seed=globalThis[Symbol.for('WORKFLOW_USE_STEP')]('seed');const extend=globalThis[Symbol.for('WORKFLOW_USE_STEP')]('extend');const verify=globalThis[Symbol.for('WORKFLOW_USE_STEP')]('verify');async function workflow(){const first=await seed();const main=await extend(first.chain,3,'main');const aside=await extend(first.chain.take(1),4,'aside');return await verify({base:first.chain,main,aside});}globalThis.__private_workflows=new Map([['workflow',workflow]]);`;
    await workflowEntrypoint(code)(
      new Request('https://test', {
        method: 'POST',
        body: JSON.stringify({ runId, workflowName: 'workflow' }),
      })
    );
    const completed = events.find((e) => e.eventType === 'run_completed');
    expect(completed).toBeDefined();
    expect(
      await hydrateWorkflowReturnValue(
        completed!.eventData.output,
        runId,
        undefined
      )
    ).toEqual({ base: 2, main: 3, aside: 2, checked: true });
    expect(bodyCounts).toEqual({ seed: 1, extend: 2, verify: 1 });
    const recipes = [...steps.values()]
      .filter((step) => step.output)
      .flatMap((step) =>
        splitChainEnvelope(step.output as Uint8Array).parseRecipes()
      );
    const seedStep = [...steps.values()].find(
      (step) => step.stepName === 'seed'
    )!;
    const extensions = recipes.filter((recipe) => recipe.base);
    expect(extensions).toHaveLength(2);
    expect(extensions.map((recipe) => recipe.base)).toEqual([
      { runId, stepId: seedStep.stepId, slot: 'hslot_0', length: 2 },
      { runId, stepId: seedStep.stepId, slot: 'hslot_0', length: 1 },
    ]);
    expect(extensions.map((recipe) => recipe.take)).toEqual([2, 1]);
    expect(extensions.map((recipe) => recipe.additions)).toEqual([
      [{ n: 3 }],
      [{ n: 4 }],
    ]);
    const seedRecipe = recipes.find((recipe) => !recipe.base)!;
    expect(seedRecipe.additions).toEqual([{ n: 1 }, { n: 2 }]);
    expect(stepsGet).not.toHaveBeenCalled();
  });
});
