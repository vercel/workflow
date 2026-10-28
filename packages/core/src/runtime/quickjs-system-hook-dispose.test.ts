/**
 * A system hook is an ordinary hook to the QuickJS VM: once its disposal is
 * durably recorded, its pending ops are released like a user hook's. Only an
 * AbortController's hook keeps its op, because `abort()` finds it later.
 * (The child-run completion hook is disposed and registered again between
 * waits, so a retained op would leak one per wait.)
 */
import type { Event } from '@workflow/world';
import { assert, describe, expect, it } from 'vitest';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';

const runId = 'wrun_system_hook_dispose';
const at = (seconds: number) => new Date(Date.UTC(2025, 0, 1, 0, 0, seconds));
const workflowRun = {
  runId,
  deploymentId: 'dpl_test',
  workflowName: 'workflow//test//workflow',
  input: undefined,
  status: 'running' as const,
  output: undefined,
  error: undefined,
  completedAt: undefined,
  startedAt: at(0),
  createdAt: at(0),
  updatedAt: at(0),
  specVersion: 2,
};

const workflowCode = `
globalThis.__private_workflows = new Map();
async function workflow() {
  var hook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")]({ token: "system-token", isSystem: true });
  await hook.getConflict();
  hook.dispose();
  await globalThis[Symbol.for("WORKFLOW_SLEEP")](60000);
  // By now hook_disposed has been processed.
  return globalThis.__pendingList().filter(function (p) {
    return p.type === "hook" || p.type === "hook_dispose";
  }).length;
}
workflow.workflowId = "workflow//test//workflow";
globalThis.__private_workflows.set("workflow//test//workflow", workflow);`;

describe('QuickJS system hook disposal', () => {
  it('records the hook as a system hook and releases it once disposed', async () => {
    const first = await runQuickJSWorkflow({
      workflowCode,
      workflowId: 'workflow//test//workflow',
      workflowRun,
      events: [],
    });
    const hook = first.suspended?.pendingOperations.find(
      (op) => op.type === 'hook'
    );
    expect(hook).toMatchObject({ token: 'system-token', isSystem: true });

    const events = [
      {
        eventId: 'evnt_0',
        runId,
        eventType: 'run_created',
        eventData: { input: serialize([]) },
        createdAt: at(0),
      },
      {
        eventId: 'evnt_1',
        runId,
        eventType: 'hook_created',
        correlationId: hook?.correlationId,
        eventData: { token: 'system-token', isSystem: true },
        createdAt: at(1),
      },
      {
        eventId: 'evnt_2',
        runId,
        eventType: 'hook_disposed',
        correlationId: hook?.correlationId,
        eventData: { token: 'system-token' },
        createdAt: at(2),
      },
    ] as Event[];
    const second = await runQuickJSWorkflow({
      workflowCode,
      workflowId: 'workflow//test//workflow',
      workflowRun,
      events,
    });
    const wait = second.suspended?.pendingOperations.find(
      (op) => op.type === 'wait'
    );
    expect(second.suspended?.pendingOperations.map((op) => op.type)).toEqual([
      'wait',
    ]);

    const third = await runQuickJSWorkflow({
      workflowCode,
      workflowId: 'workflow//test//workflow',
      workflowRun,
      events: [
        ...events,
        {
          eventId: 'evnt_3',
          runId,
          eventType: 'wait_created',
          correlationId: wait?.correlationId,
          eventData: { resumeAt: (wait as { resumeAt: Date }).resumeAt },
          createdAt: at(3),
        },
        {
          eventId: 'evnt_4',
          runId,
          eventType: 'wait_completed',
          correlationId: wait?.correlationId,
          eventData: { resumeAt: (wait as { resumeAt: Date }).resumeAt },
          createdAt: at(4),
        },
      ] as Event[],
    });
    // No hook op left in the VM once the disposal was recorded.
    assert(third.completed);
    expect(deserialize(third.completed.result)).toBe(0);
  });
});
