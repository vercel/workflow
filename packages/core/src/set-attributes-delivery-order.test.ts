import type { CreateEventRequest, Event, WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type QueueItem, WorkflowSuspension } from './global.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

afterEach(() => vi.unstubAllEnvs());

// Regression for #4770: resolving `setAttributes()` bypassed the delivery
// barriers, so a branch awaiting it could resume ahead of a step result that
// is earlier in the log and draw another branch's correlation ID. When both
// branches then call the same step, the step consumer accepts the swapped
// events and the branches silently receive each other's results.
const PRELUDE = `
  const step = globalThis[Symbol.for('WORKFLOW_USE_STEP')];
  const quickStep = step('quickStep');
  const delayedStep = step('delayedStep');
  const setAttributes = globalThis[Symbol.for('WORKFLOW_SET_ATTRIBUTES')];
  const sleep = globalThis[Symbol.for('WORKFLOW_SLEEP')];
  const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
`;

const SWAP_WORKFLOW = (hops: number) => `${PRELUDE}
  globalThis.__private_workflows = new Map([['workflow', async () => {
    const attributeBranch = async () => {
      await quickStep('before-attribute');
      await setAttributes([{ key: 'phase', value: 'attribute-branch' }]);
      return await quickStep('after-attribute');
    };
    const sleepBranch = async () => {
      await delayedStep(0);
      for (let hop = 0; hop < ${hops}; hop++) await Promise.resolve();
      const other = await quickStep('other-branch');
      await sleep('300ms');
      return other;
    };
    const [a, b] = await Promise.all([attributeBranch(), sleepBranch()]);
    return a + '|' + b;
  }]]);
`;

const HOOK_WORKFLOW = (hops: number) => `${PRELUDE}
  globalThis.__private_workflows = new Map([['workflow', async () => {
    const attributeBranch = async () => {
      await quickStep('before-attribute');
      await setAttributes([{ key: 'phase', value: 'attribute-branch' }]);
      await quickStep('after-attribute');
    };
    const hookBranch = async () => {
      await delayedStep(0);
      for (let hop = 0; hop < ${hops}; hop++) await Promise.resolve();
      const hook = createHook({ token: 'attr-vs-hook' });
      await hook;
    };
    await Promise.all([attributeBranch(), hookBranch()]);
    return 'completed';
  }]]);
`;

const RUN_ID = 'wrun_set_attributes_delivery_order';

/** The events a world records when the workflow first asks for `item`. */
async function creationEvents(item: QueueItem): Promise<CreateEventRequest[]> {
  switch (item.type) {
    case 'step':
      return [
        {
          eventType: 'step_created',
          correlationId: item.correlationId,
          eventData: {
            stepName: item.stepName,
            input: await dehydrateStepArguments(item.args, RUN_ID, undefined),
          },
        },
      ];
    case 'wait':
      return [
        {
          eventType: 'wait_created',
          correlationId: item.correlationId,
          eventData: { resumeAt: item.resumeAt },
        },
      ];
    case 'hook':
      return [
        {
          eventType: 'hook_created',
          correlationId: item.correlationId,
          eventData: { token: item.token, isWebhook: false },
        },
      ];
    case 'attribute':
      return [
        {
          eventType: 'attr_set',
          correlationId: item.correlationId,
          eventData: { changes: item.changes, writer: { type: 'workflow' } },
        },
      ];
  }
}

/** The events that complete `item`. Each step echoes its first argument. */
async function completionEvents(
  item: QueueItem
): Promise<CreateEventRequest[]> {
  switch (item.type) {
    case 'step':
      return [
        {
          eventType: 'step_started',
          correlationId: item.correlationId,
          eventData: { stepName: item.stepName },
        } as CreateEventRequest,
        {
          eventType: 'step_completed',
          correlationId: item.correlationId,
          eventData: {
            result: await dehydrateStepReturnValue(
              item.args[0],
              RUN_ID,
              undefined
            ),
          },
        },
      ];
    case 'wait':
      return [
        {
          eventType: 'wait_completed',
          correlationId: item.correlationId,
          eventData: { resumeAt: item.resumeAt },
        } as CreateEventRequest,
      ];
    case 'hook':
      return [
        {
          eventType: 'hook_received',
          correlationId: item.correlationId,
          eventData: {
            payload: await dehydrateStepReturnValue(
              { done: true },
              RUN_ID,
              undefined
            ),
          },
        } as CreateEventRequest,
      ];
    default:
      return [];
  }
}

/**
 * Drives a workflow to completion against an in-memory event log, the way a
 * world does: every round replays the full log in a fresh VM, records the
 * events for whatever the suspension asks for, and completes what is pending.
 * Returns the final output plus the log, so the caller can replay it again.
 */
async function drive(code: string) {
  const startedAt = new Date('2025-01-01T00:00:00Z');
  const run: WorkflowRun = {
    runId: RUN_ID,
    workflowName: 'workflow',
    status: 'running',
    attributes: {},
    createdAt: startedAt,
    updatedAt: startedAt,
    startedAt,
    deploymentId: 'test-deployment',
    input: await dehydrateWorkflowArguments([], RUN_ID, undefined),
  };
  const events: Event[] = [];
  const append = (request: CreateEventRequest) => {
    events.push({
      ...request,
      eventId: `evnt_${String(events.length + 1).padStart(26, '0')}`,
      runId: RUN_ID,
      createdAt: new Date(+startedAt + (events.length + 1) * 100),
      specVersion: 3,
    } as Event);
  };
  const replay = async (cache = new ReplayPayloadCache(undefined)) => {
    try {
      const output = await runWorkflow(
        code,
        run,
        [...events],
        undefined,
        cache
      );
      return { output: await hydrateWorkflowReturnValue(output, RUN_ID) };
    } catch (error) {
      if (!(error instanceof WorkflowSuspension)) throw error;
      return { items: error.items };
    }
  };

  const recorded = new Set<string>();
  let pending: QueueItem[] = [];
  for (let round = 0; round < 20; round++) {
    const result = await replay();
    if ('output' in result) return { output: result.output, replay };
    const fresh = result.items.filter(
      (item) => !recorded.has(item.correlationId)
    );
    for (const item of fresh) {
      recorded.add(item.correlationId);
      for (const event of await creationEvents(item)) append(event);
    }
    for (const item of pending) {
      for (const event of await completionEvents(item)) append(event);
    }
    pending = fresh.filter((item) => item.type !== 'attribute');
  }
  throw new Error('Workflow did not complete');
}

describe('setAttributes() delivery ordering', () => {
  describe.each(['1', '0'])('WORKFLOW_LOG_ORDER_DRAWS=%s', (logOrderDraws) => {
    it.each([
      0, 3, 12, 48,
    ])('does not swap step results between branches (hops=%i)', async (hops) => {
      vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', logOrderDraws);
      const { output, replay } = await drive(SWAP_WORKFLOW(hops));
      expect(output).toBe('after-attribute|other-branch');
      // Fresh replays of the committed log, with cold and warm caches, must
      // keep handing each branch its own step result.
      const cache = new ReplayPayloadCache(undefined);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await replay(cache)).toEqual({
          output: 'after-attribute|other-branch',
        });
      }
    });

    it.each([
      0, 3, 12, 48,
    ])('does not diverge when racing a hook registration (hops=%i)', async (hops) => {
      vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', logOrderDraws);
      const { output, replay } = await drive(HOOK_WORKFLOW(hops));
      expect(output).toBe('completed');
      const cache = new ReplayPayloadCache(undefined);
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(await replay(cache)).toEqual({ output: 'completed' });
      }
    });
  });
});
