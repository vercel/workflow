/**
 * Hook `ttl` on the QuickJS engine: the same expiry the node:vm engine
 * implements in workflow/hook.ts (see workflow/hook-ttl.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

function runCreatedEvent(run: { runId: string }) {
  return {
    eventId: 'evnt_run_created',
    runId: run.runId,
    eventType: 'run_created' as const,
    eventData: { input: serialize([]) },
    createdAt: new Date('2025-01-01T00:00:00Z'),
  };
}

function makeRun() {
  return {
    runId: 'wrun_ttl',
    deploymentId: 'dpl_test',
    workflowName: 'test-workflow',
    input: undefined,
    status: 'running' as const,
    output: undefined,
    error: undefined,
    completedAt: undefined,
    startedAt: new Date('2025-01-01T00:00:00Z'),
    createdAt: new Date('2025-01-01T00:00:00Z'),
    updatedAt: new Date('2025-01-01T00:00:00Z'),
    specVersion: 2,
  };
}

function workflowCode(options: string) {
  return `
    async function workflow() {
      var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")](${options});
      var seen = [];
      try {
        for await (var payload of hook) seen.push(payload);
        return { seen: seen, ended: "done" };
      } catch (error) {
        return { seen: seen, ended: error.name, token: error.token };
      }
    }
    workflow.workflowId = "workflow//test//workflow";
    globalThis.__private_workflows.set("workflow//test//workflow", workflow);
  `;
}

describe('QuickJS hook ttl', () => {
  it('records a 30-day expiry wait tagged with the hook by default', async () => {
    const run = makeRun();
    const result = await runQuickJSWorkflow({
      workflowCode: workflowCode('{ token: "tok" }'),
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    const ops = result.suspended!.pendingOperations;
    const hook = ops.find((o) => o.type === 'hook')!;
    const wait = ops.find((o) => o.type === 'wait') as
      | { correlationId: string; resumeAt: string; hookId?: string }
      | undefined;
    expect(wait).toBeDefined();
    expect(wait!.hookId).toBe(hook.correlationId);
    expect(wait!.correlationId).toBe(
      hook.correlationId.replace(/^hook_/, 'wait_')
    );
    const ttlMs =
      new Date(wait!.resumeAt).getTime() -
      new Date('2025-01-01T00:00:00Z').getTime();
    expect(ttlMs).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
    expect(ttlMs).toBeLessThan(30 * 24 * 60 * 60 * 1000 + 60_000);
  });

  it('records no expiry for ttl: Infinity', async () => {
    const run = makeRun();
    const result = await runQuickJSWorkflow({
      workflowCode: workflowCode('{ token: "tok", ttl: Infinity }'),
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    const ops = result.suspended!.pendingOperations;
    expect(ops.map((o) => o.type)).toEqual(['hook']);
  });

  it('delivers earlier payloads, rejects with HookExpiredError, drops later ones', async () => {
    const run = makeRun();
    const code = workflowCode('{ token: "tok" }');
    const first = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [runCreatedEvent(run)],
    });
    const ops = first.suspended!.pendingOperations;
    const hookCid = ops.find((o) => o.type === 'hook')!.correlationId;
    const wait = ops.find((o) => o.type === 'wait') as unknown as {
      correlationId: string;
      resumeAt: string;
    };
    const resumeAt = new Date(wait.resumeAt);
    const second = await runQuickJSWorkflow({
      workflowCode: code,
      workflowId: 'workflow//test//workflow',
      workflowRun: run,
      events: [
        runCreatedEvent(run),
        {
          eventId: 'evnt_001',
          runId: run.runId,
          eventType: 'hook_created',
          correlationId: hookCid,
          eventData: { token: 'tok', isWebhook: false },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          eventId: 'evnt_002',
          runId: run.runId,
          eventType: 'wait_created',
          correlationId: wait.correlationId,
          eventData: { resumeAt, hookId: hookCid },
          createdAt: new Date('2025-01-01T00:00:01Z'),
        },
        {
          eventId: 'evnt_003',
          runId: run.runId,
          eventType: 'hook_received',
          correlationId: hookCid,
          eventData: { payload: serialize('early') },
          createdAt: new Date('2025-01-01T00:00:02Z'),
        },
        {
          eventId: 'evnt_004',
          runId: run.runId,
          eventType: 'wait_completed',
          correlationId: wait.correlationId,
          eventData: { resumeAt },
          createdAt: resumeAt,
        },
        {
          eventId: 'evnt_005',
          runId: run.runId,
          eventType: 'hook_received',
          correlationId: hookCid,
          eventData: { payload: serialize('late') },
          createdAt: resumeAt,
        },
      ],
    });
    expect(second.completed).toBeDefined();
    expect(deserialize(second.completed!.result)).toEqual({
      seen: ['early'],
      ended: 'HookExpiredError',
      token: 'tok',
    });
  });
});
