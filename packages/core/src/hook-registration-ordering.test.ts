import type {
  CreateEventRequest,
  Event,
  HookConflictEvent,
  WorkflowRun,
} from '@workflow/world';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { type QueueItem, WorkflowSuspension } from './global.js';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from './serialization.js';
import { replayWorkflow, resumeWorkflow, runWorkflow } from './workflow.js';

afterEach(() => vi.unstubAllEnvs());

describe('hook registration delivery ordering', () => {
  describe.each(['1', '0'])('WORKFLOW_LOG_ORDER_DRAWS=%s', (logOrderDraws) => {
    it.each([
      { eventType: 'hook_created', awaitHook: false, buffered: 'none' },
      { eventType: 'hook_created', awaitHook: false, buffered: 'unread' },
      { eventType: 'hook_created', awaitHook: false, buffered: 'claimed' },
      { eventType: 'hook_conflict', awaitHook: false, buffered: 'none' },
      { eventType: 'hook_conflict', awaitHook: true, buffered: 'none' },
    ] as const)('preserves IDs across $eventType (awaitHook=$awaitHook, buffered=$buffered)', async ({
      eventType,
      awaitHook,
      buffered,
    }) => {
      vi.stubEnv('WORKFLOW_LOG_ORDER_DRAWS', logOrderDraws);
      vi.stubEnv('VERCEL_URL', 'localhost');
      const runId = 'wrun_hook_registration_ordering';
      const startedAt = new Date('2025-01-01T00:00:00Z');
      const run: WorkflowRun = {
        runId,
        workflowName: 'parent',
        status: 'running',
        attributes: {},
        createdAt: startedAt,
        updatedAt: startedAt,
        startedAt,
        deploymentId: 'test-deployment',
        input: await dehydrateWorkflowArguments([], runId, undefined),
      };
      const stepInput = await dehydrateStepArguments([], runId, undefined);
      const code = `
      const step = globalThis[Symbol.for('WORKFLOW_USE_STEP')];
      const sleep = globalThis[Symbol.for('WORKFLOW_SLEEP')];
      const createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
      const read = step('read'), save = step('save'), start = step('start');
      globalThis.__private_workflows = new Map([['parent', async () => {
        const dispatch = (async () => {
          await sleep('5s');
          const bufferedHook = ${buffered === 'none' ? 'null' : "createHook({ token: 'buffered' })"};
          const hook = createHook({ token: 'config' });
          try {
            await ${awaitHook ? 'hook' : 'hook.getConflict()'};
            if (${JSON.stringify(eventType)} === 'hook_conflict') {
              throw new Error('Expected HookConflictError');
            }
          } catch (error) {
            if (${JSON.stringify(eventType)} !== 'hook_conflict' ||
                error.name !== 'HookConflictError') throw error;
          }
          if (${buffered === 'claimed'}) {
            if (await bufferedHook !== 'buffered') throw new Error('Lost payload');
          }
          await start();
        })();
        const supervision = (async () => {
          await read();
          await Promise.resolve().then(async () => { await save(); });
        })();
        await Promise.all([dispatch, supervision]);
      }]]);
    `;
      const events: Event[] = [];
      const append = (
        request:
          | CreateEventRequest
          | Pick<HookConflictEvent, 'eventType' | 'correlationId' | 'eventData'>
      ) => {
        events.push({
          ...request,
          eventId: `evnt_${String(events.length + 1).padStart(26, '0')}`,
          runId,
          createdAt: new Date(+startedAt + (events.length + 1) * 100),
          specVersion: 3,
        } as Event);
      };
      const suspend = async (cache = new ReplayPayloadCache(undefined)) => {
        try {
          await runWorkflow(code, run, events, undefined, cache);
        } catch (error) {
          if (!(error instanceof WorkflowSuspension)) throw error;
          return error.items;
        }
        throw new Error('Expected workflow suspension');
      };
      const findStep = (items: QueueItem[], stepName: string) => {
        const item = items.find(
          (item) => item.type === 'step' && item.stepName === stepName
        );
        assert(item?.type === 'step');
        return item;
      };

      const initial = await suspend();
      const wait = initial.find((item) => item.type === 'wait');
      assert(wait?.type === 'wait');
      const read = findStep(initial, 'read');
      append({
        eventType: 'wait_created',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      });
      append({
        eventType: 'step_created',
        correlationId: read.correlationId,
        eventData: { stepName: 'read', input: stepInput },
      });
      append({
        eventType: 'wait_completed',
        correlationId: wait.correlationId,
        eventData: { resumeAt: wait.resumeAt },
      });
      append({
        eventType: 'step_completed',
        correlationId: read.correlationId,
        eventData: {
          result: await dehydrateStepReturnValue('ready', runId, undefined),
        },
      });

      // Learn the IDs from the shorter history, just as the suspension handler
      // does. Extending the history must not change which branch draws them.
      const options = {
        workflowCode: code,
        workflowRun: run,
        encryptionKey: undefined,
        replayPayloadCache: new ReplayPayloadCache(undefined),
      };
      const retained = await replayWorkflow({
        ...options,
        events: [...events],
      });
      assert(retained.type === 'suspended');
      const beforeRegistration = retained.suspension.items;
      const hook = beforeRegistration.find(
        (item) => item.type === 'hook' && item.token === 'config'
      );
      assert(hook?.type === 'hook');
      const save = findStep(beforeRegistration, 'save');
      if (buffered !== 'none') {
        const bufferedHook = beforeRegistration.find(
          (item) => item.type === 'hook' && item.token === 'buffered'
        );
        assert(bufferedHook?.type === 'hook');
        append({
          eventType: 'hook_created',
          correlationId: bufferedHook.correlationId,
          eventData: { token: 'buffered', isWebhook: false },
        });
        append({
          eventType: 'hook_received',
          correlationId: bufferedHook.correlationId,
          eventData: {
            payload: await dehydrateStepReturnValue(
              'buffered',
              runId,
              undefined
            ),
          },
        });
      }
      append({
        eventType,
        correlationId: hook.correlationId,
        eventData: { token: hook.token },
      });
      append({
        eventType: 'step_created',
        correlationId: save.correlationId,
        eventData: { stepName: 'save', input: stepInput },
      });

      const resumed = await resumeWorkflow(retained.session, [...events]);
      assert(resumed.type === 'suspended');
      const start = findStep(resumed.suspension.items, 'start');
      expect(findStep(resumed.suspension.items, 'save').correlationId).toBe(
        save.correlationId
      );

      // Fresh VMs with cold and warm primitive-result caches must agree with
      // the retained VM that emitted save before registration was committed.
      const cache = new ReplayPayloadCache(undefined);
      for (let attempt = 0; attempt < 4; attempt++) {
        const pending = await suspend(cache);
        expect(findStep(pending, 'save').correlationId).toBe(
          save.correlationId
        );
        expect(findStep(pending, 'save').hasCreatedEvent).toBe(true);
        expect(findStep(pending, 'start').correlationId).toBe(
          start.correlationId
        );
      }
      append({
        eventType: 'step_created',
        correlationId: start.correlationId,
        eventData: { stepName: 'start', input: stepInput },
      });
      for (const step of [save, start]) {
        append({
          eventType: 'step_completed',
          correlationId: step.correlationId,
          eventData: {
            result: await dehydrateStepReturnValue(null, runId, undefined),
          },
        });
      }
      expect((await resumeWorkflow(resumed.session, [...events])).type).toBe(
        'completed'
      );
      expect(
        (
          await replayWorkflow({
            ...options,
            events,
            replayPayloadCache: cache,
          })
        ).type
      ).toBe('completed');
    });
  });
});
