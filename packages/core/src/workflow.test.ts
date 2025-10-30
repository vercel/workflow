import { types } from 'node:util';
import type { Event, WorkflowRun } from '@workflow/world';
import { assert, describe, expect, it } from 'vitest';
import type { WorkflowSuspension } from './global.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
  hydrateWorkflowReturnValue,
} from './serialization.js';
import { runWorkflow } from './workflow.js';

describe('runWorkflow', () => {
  const getWorkflowTransformCode = (workflowName?: string) =>
    `;globalThis.__private_workflows = new Map();
    ${
      workflowName
        ? `
      globalThis.__private_workflows.set(${JSON.stringify(workflowName)}, ${workflowName})
    `
        : ''
    }
    `;

  describe('successful workflow execution', () => {
    it('should execute a simple workflow successfully', async () => {
      const ops: Promise<any>[] = [];
      const workflowCode = `function workflow() { return "success"; }${getWorkflowTransformCode('workflow')}`;

      const workflowRun: WorkflowRun = {
        runId: 'wrun_123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(workflowCode, workflowRun, events);
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual('success');
    });

    it('should execute workflow with arguments', async () => {
      const ops: Promise<any>[] = [];
      const workflowCode = `function workflow(a, b) { return a + b; }${getWorkflowTransformCode('workflow')}`;

      const workflowRun: WorkflowRun = {
        runId: 'wrun_123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([1, 2], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(workflowCode, workflowRun, events);
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(3);
    });

    it('allow user code to handle user-defined errors', async () => {
      const ops: Promise<any>[] = [];
      const workflowCode = `function workflow() {
        try {
          throw new TypeError("my workflow error");
        } catch (err) {
          return err;
        }
      }${getWorkflowTransformCode('workflow')}`;

      const workflowRun: WorkflowRun = {
        runId: 'wrun_123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = hydrateWorkflowReturnValue(
        (await runWorkflow(workflowCode, workflowRun, events)) as any,
        ops
      );
      assert(types.isNativeError(result));
      expect(result.name).toEqual('TypeError');
      expect(result.message).toEqual('my workflow error');
    });
  });

  it('should resolve a step that has a `step_completed` event', async () => {
    const ops: Promise<any>[] = [];
    const workflowRunId = 'wrun_123';
    const workflowRun: WorkflowRun = {
      runId: workflowRunId,
      workflowName: 'workflow',
      status: 'running',
      input: dehydrateWorkflowArguments([], ops),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    const events: Event[] = [
      {
        eventId: 'event-0',
        runId: workflowRunId,
        eventType: 'step_started',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HF',
        createdAt: new Date(),
      },
      {
        eventId: 'event-1',
        runId: workflowRunId,
        eventType: 'step_completed',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HF',
        eventData: {
          result: dehydrateStepReturnValue(3, ops),
        },
        createdAt: new Date(),
      },
    ];

    const result = await runWorkflow(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            // 'add()' will throw a 'WorkflowSuspension' because it has not been run yet
            const a = await add(1, 2);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events
    );
    expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(3);
  });

  it('should update the timestamp in the vm context as events are replayed', async () => {
    const ops: Promise<any>[] = [];
    const workflowRunId = 'wrun_123';
    const workflowRun: WorkflowRun = {
      runId: workflowRunId,
      workflowName: 'workflow',
      status: 'running',
      input: dehydrateWorkflowArguments([], ops),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };

    const events: Event[] = [
      {
        eventId: 'event-0',
        runId: workflowRunId,
        eventType: 'step_started',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HF',
        createdAt: new Date('2024-01-01T00:00:01.000Z'),
      },
      {
        eventId: 'event-1',
        runId: workflowRunId,
        eventType: 'step_completed',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HF',
        eventData: {
          result: dehydrateStepReturnValue(3, ops),
        },
        createdAt: new Date('2024-01-01T00:00:02.000Z'),
      },
      {
        eventId: 'event-2',
        runId: workflowRunId,
        eventType: 'step_started',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HG',
        createdAt: new Date('2024-01-01T00:00:03.000Z'),
      },
      {
        eventId: 'event-3',
        runId: workflowRunId,
        eventType: 'step_completed',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HG',
        eventData: {
          result: dehydrateStepReturnValue(3, ops),
        },
        createdAt: new Date('2024-01-01T00:00:04.000Z'),
      },
      {
        eventId: 'event-4',
        runId: workflowRunId,
        eventType: 'step_started',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HH',
        createdAt: new Date('2024-01-01T00:00:05.000Z'),
      },
      {
        eventId: 'event-5',
        runId: workflowRunId,
        eventType: 'step_completed',
        correlationId: 'step_01HK153X00Y11PCQTCHQRK34HH',
        eventData: {
          result: dehydrateStepReturnValue(3, ops),
        },
        createdAt: new Date('2024-01-01T00:00:06.000Z'),
      },
    ];

    const result = await runWorkflow(
      `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            const timestamps = [];
            timestamps.push(new Date());
            await add(1, 2);
            timestamps.push(Date.now());
            await add(3, 4);
            timestamps.push(Date.now());
            await add(5, 6);
            timestamps.push(new Date());
            return timestamps;
          }${getWorkflowTransformCode('workflow')}`,
      workflowRun,
      events
    );
    expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual([
      new Date('2024-01-01T00:00:00.000Z'),
      1704067203000,
      1704067205000,
      new Date('2024-01-01T00:00:06.000Z'),
    ]);
  });

  // TODO: Date.now determinism is currently broken in the workflow!!
  it.fails(
    'should maintain determinism of `Date` across executions',
    async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            resumeAt: new Date('2024-01-01T00:00:01.000Z'),
          },
          createdAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            resumeAt: new Date('2024-01-01T00:00:02.000Z'),
          },
          createdAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        {
          eventId: 'event-2',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date('2024-01-01T00:00:03.000Z'),
        },
      ];

      const workflowCode = `
      const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
      async function workflow() {
        await Promise.race([sleep(1), sleep(2)]);
        return Date.now();
      }${getWorkflowTransformCode('workflow')}`;

      // Execute the workflow with only sleep(1) resolved
      const result1 = await runWorkflow(workflowCode, workflowRun, events);

      // Execute again with both sleeps resolved this time
      const result2 = await runWorkflow(workflowCode, workflowRun, [
        ...events,
        {
          eventId: 'event-3',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date('2024-01-01T00:00:04.000Z'),
        },
      ]);

      // The date should be the same
      const date1 = hydrateWorkflowReturnValue(result1 as any, ops);
      const date2 = hydrateWorkflowReturnValue(result2 as any, ops);
      expect(date1).toEqual(date2);
    }
  );

  describe('concurrency', () => {
    it('should resolve `Promise.all()` steps that have `step_completed` events', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date(),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date(),
        },
        {
          eventId: 'event-2',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            result: dehydrateStepReturnValue(3, ops),
          },
          createdAt: new Date(),
        },
        {
          eventId: 'event-3',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            result: dehydrateStepReturnValue(7, ops),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            const a = await Promise.all([add(1, 2), add(3, 4)]);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual([3, 7]);
    });

    it('should resolve `Promise.race()` steps that have `step_completed` events (first promise resolves first)', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date(),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date(),
        },
        {
          eventId: 'event-2',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            result: dehydrateStepReturnValue(3, ops),
          },
          createdAt: new Date(),
        },
        {
          eventId: 'event-3',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            result: dehydrateStepReturnValue(7, ops),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            const a = await Promise.race([add(1, 2), add(3, 4)]);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(3);
    });

    it('should resolve `Promise.race()` steps that have `step_completed` events (second promise resolves first)', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date(),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date(),
        },
        {
          eventId: 'event-2',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            result: dehydrateStepReturnValue(7, ops),
          },
          createdAt: new Date(),
        },
        {
          eventId: 'event-3',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            result: dehydrateStepReturnValue(3, ops),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            const a = await Promise.race([add(1, 2), add(3, 4)]);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(7);
    });

    it('should handle Promise.race with multiple concurrent steps completing out of order', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'wrun_01K75533W56DAE35VY3082DN3P',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventType: 'step_started',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGD',
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K755385N02MMWXYHFCQSP9P0',
          createdAt: new Date('2025-10-09T18:52:51.253Z'),
        },
        {
          eventType: 'step_started',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGE',
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K755386GHGAFYYDC58V17E3T',
          createdAt: new Date('2025-10-09T18:52:51.280Z'),
        },
        {
          eventType: 'step_started',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGF',
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K75538D4Q4X8PJ1ZNDZD5R0W',
          createdAt: new Date('2025-10-09T18:52:51.492Z'),
        },
        {
          eventType: 'step_started',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGG',
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K75538Y9GEHXJQXT3JB89M4C',
          createdAt: new Date('2025-10-09T18:52:52.041Z'),
        },
        {
          eventType: 'step_started',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGH',
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K75539CD2PAH419SKJ2X5V5T',
          createdAt: new Date('2025-10-09T18:52:52.493Z'),
        },
        {
          eventType: 'step_completed',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGH',
          eventData: {
            result: dehydrateStepReturnValue(4, ops),
          },
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K7553EABWCK00JQ9R8P1FTK7',
          createdAt: new Date('2025-10-09T18:52:57.547Z'),
        },
        {
          eventType: 'step_completed',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGG',
          eventData: {
            result: dehydrateStepReturnValue(3, ops),
          },
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K7553F31YS6C94NG23WGEEMV',
          createdAt: new Date('2025-10-09T18:52:58.337Z'),
        },
        {
          eventType: 'step_completed',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGF',
          eventData: {
            result: dehydrateStepReturnValue(2, ops),
          },
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K7553G0XEE4R440QS5SV89YE',
          createdAt: new Date('2025-10-09T18:52:59.293Z'),
        },
        {
          eventType: 'step_completed',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGE',
          eventData: {
            result: dehydrateStepReturnValue(1, ops),
          },
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K7553HS9R1XJQKVVW0ZRCMNP',
          createdAt: new Date('2025-10-09T18:53:01.097Z'),
        },
        {
          eventType: 'step_completed',
          correlationId: 'step_01HK153X00DKMJB5AQEJZ3FQGD',
          eventData: {
            result: dehydrateStepReturnValue(0, ops),
          },
          runId: 'wrun_01K75533W56DAE35VY3082DN3P',
          eventId: 'evnt_01K7553K67FQG02YCFE9QDKJ90',
          createdAt: new Date('2025-10-09T18:53:02.535Z'),
        },
      ];

      const result = await runWorkflow(
        `
        const promiseRaceStressTestDelayStep = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("promiseRaceStressTestDelayStep");

        async function workflow() {
  const promises = new Map();
  const done = [];
  for (let i = 0; i < 5; i++) {
    const dur = 1000 * (10 - i);
    promises.set(i, promiseRaceStressTestDelayStep(dur, i));
  }

  while (promises.size > 0) {
    const res = await Promise.race(promises.values());
    done.push(res);
    promises.delete(res);
  }
    return done;
}${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual([
        4, 3, 2, 1, 0,
      ]);
    });
  });

  describe('error handling', () => {
    it('should throw ReferenceError when workflow code does not return a function', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'value',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `const value = "test"${getWorkflowTransformCode()}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('ReferenceError');
      expect(error.message).toEqual(
        'Workflow "value" must be a function, but got "undefined" instead'
      );
    });

    it('should throw user-defined error when workflow code throws an error', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `function workflow() { throw new Error("test"); }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('Error');
      expect(error.message).toEqual('test');
    });

    it('should throw `WorkflowSuspension` when a step does not have an event result entry', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            // 'add()' will throw a 'WorkflowSuspension' because it has not been run yet
            const a = await add(1, 2);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('1 step has not been run yet');
      expect((error as WorkflowSuspension).steps).toEqual([
        {
          type: 'step',
          stepName: 'add',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          args: [1, 2],
        },
      ]);
    });

    it('should throw `WorkflowSuspension` when a step has only a "step_started" event', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [
          {
            eventId: 'event-0',
            runId: workflowRun.runId,
            eventType: 'step_started',
            correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
            createdAt: new Date(),
          },
        ];

        await runWorkflow(
          `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            // 'add()' will throw a 'WorkflowSuspension' because it has not been run yet
            const a = await add(1, 2);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('0 steps have not been run yet');
      expect((error as WorkflowSuspension).steps).toEqual([]);
    });

    it('should throw `WorkflowSuspension` for multiple steps with `Promise.all()`', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            const a = await Promise.all([add(1, 2), add(3, 4)]);
            return a;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('2 steps have not been run yet');
      expect((error as WorkflowSuspension).steps).toEqual([
        {
          type: 'step',
          stepName: 'add',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          args: [1, 2],
        },
        {
          type: 'step',
          stepName: 'add',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          args: [3, 4],
        },
      ]);
    });

    it('`WorkflowSuspension` should not be catchable by user code', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
          async function workflow() {
            try {
              // 'add()' will throw a 'WorkflowSuspension' because it has not been run yet
              const a = await add(1, 2);
              return a;
            } catch (err) {
              return err;
            }
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('1 step has not been run yet');
    });
  });

  describe('hook', () => {
    it('should throw `WorkflowSuspension` when a hook is awaiting without a "hook_received" event', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
          async function workflow() {
            const hook = createHook();
            const payload = await hook;
            return payload.message;
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('1 hook has not been created yet');
      expect((error as WorkflowSuspension).steps).toHaveLength(1);
      expect((error as WorkflowSuspension).steps[0].type).toEqual('hook');
    });

    it('should resolve `createHook` await upon "hook_received" event', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue(
              { message: 'Hello from hook' },
              ops
            ),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook();
        const payload = await hook;
        return payload.message;
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(
        'Hello from hook'
      );
    });

    it('should resolve multiple `createHook` awaits upon "hook_received" events', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue(
              { message: 'First payload' },
              ops
            ),
          },
          createdAt: new Date(),
        },
        {
          eventId: 'event-1',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue(
              { message: 'Second payload' },
              ops
            ),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook();
        const payload1 = await hook;
        const payload2 = await hook;
        return [payload1.message, payload2.message];
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual([
        'First payload',
        'Second payload',
      ]);
    });

    it('should support `for await` loops with `createHook`', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue(
              { count: 1, status: 'active' },
              ops
            ),
          },
          createdAt: new Date(),
        },
        {
          eventId: 'event-1',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue(
              { count: 2, status: 'complete' },
              ops
            ),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook();
        const payloads = [];
        for await (const payload of hook) {
          payloads.push({ count: payload.count, status: payload.status });
          if (payloads.length === 2) {
            break;
          }
        }
        return payloads;
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual([
        { count: 1, status: 'active' },
        { count: 2, status: 'complete' },
      ]);
    });

    it('should support multiple "hook_received" events even when the workflow is only interested in one', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue({ value: 100 }, ops),
          },
          createdAt: new Date(),
        },
        {
          eventId: 'event-1',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue({ value: 200 }, ops),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook();
        const payload = await hook;
        return payload.value;
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(100);
    });

    it('should support multiple queued "hook_received" events with step events in between', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue({ data: 'first' }, ops),
          },
          createdAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue({ data: 'second' }, ops),
          },
          createdAt: new Date('2024-01-01T00:00:02.000Z'),
        },
        {
          eventId: 'event-2',
          runId: workflowRun.runId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date('2024-01-01T00:00:03.000Z'),
        },
        {
          eventId: 'event-3',
          runId: workflowRun.runId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            result: dehydrateStepReturnValue(42, ops),
          },
          createdAt: new Date('2024-01-01T00:00:04.000Z'),
        },
      ];

      const result = await runWorkflow(
        `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
      async function workflow() {
        const hook = createHook();
        const payload1 = await hook;
        const stepResult = await add(1, 2);
        const payload2 = await hook;
        return {
          data1: payload1.data,
          stepResult,
          data2: payload2.data,
        };
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual({
        data1: 'first',
        stepResult: 42,
        data2: 'second',
      });
    });

    it('should throw `WorkflowSuspension` when a hook is awaited after the event log is empty', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue({ iteration: 1 }, ops),
          },
          createdAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRun.runId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date('2024-01-01T00:00:02.000Z'),
        },
        {
          eventId: 'event-2',
          runId: workflowRun.runId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            result: dehydrateStepReturnValue(10, ops),
          },
          createdAt: new Date('2024-01-01T00:00:03.000Z'),
        },
      ];

      let error: Error | undefined;
      try {
        await runWorkflow(
          `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
      async function workflow() {
        const hook = createHook();
        for await (const payload of hook) {
          await add(payload.iteration, 2);
        }
      }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('1 hook has not been created yet');
      expect((error as WorkflowSuspension).steps).toHaveLength(1);
      expect((error as WorkflowSuspension).steps[0].type).toEqual('hook');
    });

    it('should handle hook with custom token', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRun.runId,
          eventType: 'hook_received',
          correlationId: 'hook_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            payload: dehydrateStepReturnValue({ result: 'success' }, ops),
          },
          createdAt: new Date(),
        },
      ];

      const result = await runWorkflow(
        `const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
      async function workflow() {
        const hook = createHook({ token: 'my-custom-token' });
        const payload = await hook;
        return { token: hook.token, result: payload.result };
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual({
        token: 'my-custom-token',
        result: 'success',
      });
    });
  });

  describe('Response', () => {
    it('should support new Response with body', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return new Response('Hello, world!', { status: 201 });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const res = hydrateWorkflowReturnValue(result as any, ops);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toEqual(201);
      expect(res.body).toBeInstanceOf(ReadableStream);

      // Verify body can be consumed
      const text = await res.text();
      expect(text).toEqual('Hello, world!');
    });

    it('should support Response.json() static method', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return Response.json({ message: 'success', count: 42 }, { status: 201 });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const res = hydrateWorkflowReturnValue(result as any, ops);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toEqual(201);
      expect(res.headers.get('content-type')).toEqual('application/json');

      // Verify body can be parsed as JSON
      const json = await res.json();
      expect(json).toEqual({ message: 'success', count: 42 });
    });

    it('should support Response with custom headers', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return new Response('test', {
          status: 202,
          headers: { 'X-Custom-Header': 'custom-value', 'Content-Type': 'text/plain' }
        });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const res = hydrateWorkflowReturnValue(result as any, ops);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toEqual(202);
      expect(res.headers.get('X-Custom-Header')).toEqual('custom-value');
      expect(res.headers.get('Content-Type')).toEqual('text/plain');
    });

    it('should support Response with 204 No Content', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return new Response(null, { status: 204 });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const res = hydrateWorkflowReturnValue(result as any, ops);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toEqual(204);
      expect(res.body).toBeNull();
    });

    it('should support Response with Uint8Array body', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        return new Response(data, { status: 200 });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const res = hydrateWorkflowReturnValue(result as any, ops);
      expect(res).toBeInstanceOf(Response);
      expect(res.status).toEqual(200);
      expect(res.body).toBeInstanceOf(ReadableStream);

      // Verify body can be consumed
      const text = await res.text();
      expect(text).toEqual('Hello');
    });

    it('should throw error when creating Response with body and status 204', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      await expect(
        runWorkflow(
          `async function workflow() {
          return new Response('hello', { status: 204 });
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        )
      ).rejects.toThrow(
        'Response constructor: Invalid response status code 204'
      );
    });

    describe('Response.redirect()', () => {
      it('should create redirect response with default 302 status', async () => {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        const result = await runWorkflow(
          `async function workflow() {
          return Response.redirect('https://example.com/redirect');
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
        const res = hydrateWorkflowReturnValue(result as any, ops);
        expect(res).toBeInstanceOf(Response);
        expect(res.status).toEqual(302);
        expect(res.headers.get('Location')).toEqual(
          'https://example.com/redirect'
        );
        expect(res.body).toBeNull();
      });

      it('should create redirect response with custom status', async () => {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        const result = await runWorkflow(
          `async function workflow() {
          return Response.redirect('https://example.com/moved', 301);
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
        const res = hydrateWorkflowReturnValue(result as any, ops);
        expect(res).toBeInstanceOf(Response);
        expect(res.status).toEqual(301);
        expect(res.headers.get('Location')).toEqual(
          'https://example.com/moved'
        );
      });

      it('should support all valid redirect status codes', async () => {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        const result = await runWorkflow(
          `async function workflow() {
          return [301, 302, 303, 307, 308].map(status =>
            Response.redirect('https://example.com', status).status
          );
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
        const statuses = hydrateWorkflowReturnValue(result as any, ops);
        expect(statuses).toEqual([301, 302, 303, 307, 308]);
      });

      it('should throw error for invalid redirect status code', async () => {
        const ops: Promise<any>[] = [];
        const workflowRun: WorkflowRun = {
          runId: 'test-run-123',
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await expect(
          runWorkflow(
            `async function workflow() {
            return Response.redirect('https://example.com', 200);
          }${getWorkflowTransformCode('workflow')}`,
            workflowRun,
            events
          )
        ).rejects.toThrow(
          'Invalid redirect status code: 200. Must be one of: 301, 302, 303, 307, 308'
        );
      });
    });
  });

  describe('Request', () => {
    it('should support new Request with GET method', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return new Request('https://example.com/api');
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const req = hydrateWorkflowReturnValue(result as any, ops);
      expect(req).toBeInstanceOf(Request);
      expect(req.method).toEqual('GET');
      expect(req.url).toEqual('https://example.com/api');
      expect(req.body).toBeNull();
    });

    it('should support Request with POST method and body', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return new Request('https://example.com/api', {
          method: 'POST',
          body: JSON.stringify({ name: 'test' })
        });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const req = hydrateWorkflowReturnValue(result as any, ops);
      expect(req).toBeInstanceOf(Request);
      expect(req.method).toEqual('POST');
      expect(req.url).toEqual('https://example.com/api');
      expect(req.body).toBeInstanceOf(ReadableStream);

      // Verify body can be consumed
      const text = await req.text();
      expect(text).toEqual(JSON.stringify({ name: 'test' }));
    });

    it('should support Request with custom headers', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        return new Request('https://example.com/api', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Custom-Header': 'custom-value'
          },
          body: 'test'
        });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const req = hydrateWorkflowReturnValue(result as any, ops);
      expect(req).toBeInstanceOf(Request);
      expect(req.headers.get('Content-Type')).toEqual('application/json');
      expect(req.headers.get('X-Custom-Header')).toEqual('custom-value');
    });

    it('should support Request with Uint8Array body', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
        return new Request('https://example.com/api', {
          method: 'PUT',
          body: data
        });
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      const req = hydrateWorkflowReturnValue(result as any, ops);
      expect(req).toBeInstanceOf(Request);
      expect(req.method).toEqual('PUT');
      expect(req.body).toBeInstanceOf(ReadableStream);

      // Verify body can be consumed
      const text = await req.text();
      expect(text).toEqual('Hello');
    });

    it('should throw error when creating GET Request with body', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      await expect(
        runWorkflow(
          `async function workflow() {
          return new Request('https://example.com/api', {
            method: 'GET',
            body: 'test'
          });
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        )
      ).rejects.toThrow('Request with GET/HEAD method cannot have body.');
    });

    it('should throw error when creating HEAD Request with body', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      await expect(
        runWorkflow(
          `async function workflow() {
          return new Request('https://example.com/api', {
            method: 'HEAD',
            body: 'test'
          });
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        )
      ).rejects.toThrow('Request with GET/HEAD method cannot have body.');
    });

    it('should throw error when creating Request with invalid URL', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-run-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      await expect(
        runWorkflow(
          `async function workflow() {
          return new Request('/');
        }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        )
      ).rejects.toThrow('Failed to parse URL from /');
    });

    it('should preserve Request properties when cloning with init override', async () => {
      const ops: Promise<any>[] = [];
      const workflowRun: WorkflowRun = {
        runId: 'test-clone-bug-123',
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [];

      const result = await runWorkflow(
        `async function workflow() {
        // Create a Request with specific properties
        const req1 = new Request('https://api.example.com', {
          mode: 'no-cors',
          cache: 'no-cache',
          credentials: 'include',
          method: 'GET'
        });

        // Clone the Request with only method override
        const req2 = new Request(req1, { method: 'POST' });

        // Return the properties that were inherited
        return {
          url: req2.url,
          method: req2.method,
          mode: req2.mode,
          cache: req2.cache,
          credentials: req2.credentials,
          redirect: req2.redirect
        };
      }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );

      const result_obj = hydrateWorkflowReturnValue(result as any, ops);

      // According to MDN, the req1 properties should be inherited
      // and only the method should be overridden by the init options
      expect(result_obj.url).toEqual('https://api.example.com');
      expect(result_obj.method).toEqual('POST'); // overridden by init
      expect(result_obj.mode).toEqual('no-cors'); // from req1, NOT default
      expect(result_obj.cache).toEqual('no-cache'); // from req1, NOT default 'default'
      expect(result_obj.credentials).toEqual('include'); // from req1, NOT default 'same-origin'
      expect(result_obj.redirect).toEqual('follow'); // default, since not set in req1
    });
  });

  describe('sleep', () => {
    it('should suspend and resume a basic single sleep', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const resumeAt = new Date('2024-01-01T00:00:05.000Z');
      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            resumeAt,
          },
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date('2024-01-01T00:00:05.000Z'),
        },
      ];

      const result = await runWorkflow(
        `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
        async function workflow() {
          await sleep('5s');
          return 'sleep completed';
        }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(
        'sleep completed'
      );
    });

    it('should throw `WorkflowSuspension` when sleep has no wait_completed event', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRunId = 'test-run-123';
        const workflowRun: WorkflowRun = {
          runId: workflowRunId,
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [];

        await runWorkflow(
          `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
          async function workflow() {
            await sleep('5s');
            return 'done';
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect(error.message).toEqual('1 wait has not been created yet');
      expect((error as WorkflowSuspension).steps).toHaveLength(1);
      expect((error as WorkflowSuspension).steps[0].type).toEqual('wait');
    });

    it('should handle multiple simultaneous sleeps with Promise.all()', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            resumeAt: new Date('2024-01-01T00:00:02.000Z'),
          },
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            resumeAt: new Date('2024-01-01T00:00:05.000Z'),
          },
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          eventId: 'event-2',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date('2024-01-01T00:00:02.000Z'),
        },
        {
          eventId: 'event-3',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date('2024-01-01T00:00:05.000Z'),
        },
      ];

      const result = await runWorkflow(
        `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
        async function workflow() {
          const results = await Promise.all([sleep('2s'), sleep('5s')]);
          return 'all sleeps completed';
        }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(
        'all sleeps completed'
      );
    });

    it('should suspend with multiple sleeps but only one wait_completed event (partial completion)', async () => {
      let error: Error | undefined;
      try {
        const ops: Promise<any>[] = [];
        const workflowRunId = 'test-run-123';
        const workflowRun: WorkflowRun = {
          runId: workflowRunId,
          workflowName: 'workflow',
          status: 'running',
          input: dehydrateWorkflowArguments([], ops),
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
          updatedAt: new Date('2024-01-01T00:00:00.000Z'),
          startedAt: new Date('2024-01-01T00:00:00.000Z'),
          deploymentId: 'test-deployment',
        };

        const events: Event[] = [
          {
            eventId: 'event-0',
            runId: workflowRunId,
            eventType: 'wait_created',
            correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
            eventData: {
              resumeAt: new Date('2024-01-01T00:00:02.000Z'),
            },
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
          },
          {
            eventId: 'event-1',
            runId: workflowRunId,
            eventType: 'wait_created',
            correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
            eventData: {
              resumeAt: new Date('2024-01-01T00:00:05.000Z'),
            },
            createdAt: new Date('2024-01-01T00:00:00.000Z'),
          },
          {
            eventId: 'event-2',
            runId: workflowRunId,
            eventType: 'wait_completed',
            correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
            createdAt: new Date('2024-01-01T00:00:02.000Z'),
          },
        ];

        await runWorkflow(
          `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
          async function workflow() {
            const results = await Promise.all([sleep('2s'), sleep('5s')]);
            return 'all sleeps completed';
          }${getWorkflowTransformCode('workflow')}`,
          workflowRun,
          events
        );
      } catch (err) {
        error = err as Error;
      }
      assert(error);
      expect(error.name).toEqual('WorkflowSuspension');
      expect((error as WorkflowSuspension).steps).toHaveLength(1);
      expect((error as WorkflowSuspension).steps[0].type).toEqual('wait');
    });

    it('should handle sleep combined with steps', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'step_started',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'step_completed',
          correlationId: 'step_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            result: dehydrateStepReturnValue(42, ops),
          },
          createdAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        {
          eventId: 'event-2',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
          eventData: {
            resumeAt: new Date('2024-01-01T00:00:03.000Z'),
          },
          createdAt: new Date('2024-01-01T00:00:01.000Z'),
        },
        {
          eventId: 'event-3',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JY',
          createdAt: new Date('2024-01-01T00:00:03.000Z'),
        },
      ];

      const result = await runWorkflow(
        `const add = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("add");
        const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
        async function workflow() {
          const stepResult = await add(1, 2);
          await sleep('2s');
          return { step: stepResult, slept: true };
        }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual({
        step: 42,
        slept: true,
      });
    });

    it('should handle sleep with Date parameter', async () => {
      const ops: Promise<any>[] = [];
      const workflowRunId = 'test-run-123';
      const resumeAt = new Date('2024-01-01T00:00:05.000Z');
      const workflowRun: WorkflowRun = {
        runId: workflowRunId,
        workflowName: 'workflow',
        status: 'running',
        input: dehydrateWorkflowArguments([], ops),
        createdAt: new Date('2024-01-01T00:00:00.000Z'),
        updatedAt: new Date('2024-01-01T00:00:00.000Z'),
        startedAt: new Date('2024-01-01T00:00:00.000Z'),
        deploymentId: 'test-deployment',
      };

      const events: Event[] = [
        {
          eventId: 'event-0',
          runId: workflowRunId,
          eventType: 'wait_created',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          eventData: {
            resumeAt,
          },
          createdAt: new Date('2024-01-01T00:00:00.000Z'),
        },
        {
          eventId: 'event-1',
          runId: workflowRunId,
          eventType: 'wait_completed',
          correlationId: 'wait_01HK153X008RT6YEW43G8QX6JX',
          createdAt: resumeAt,
        },
      ];

      const result = await runWorkflow(
        `const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
        async function workflow() {
          const resumeDate = new Date('2024-01-01T00:00:05.000Z');
          await sleep(resumeDate);
          return 'sleep with date completed';
        }${getWorkflowTransformCode('workflow')}`,
        workflowRun,
        events
      );
      expect(hydrateWorkflowReturnValue(result as any, ops)).toEqual(
        'sleep with date completed'
      );
    });
  });
});
