import { waitForHook, waitForSleep } from '@workflow/vitest';
import { describe, expect, it } from 'vitest';
import { getRun, resumeHook, start } from 'workflow/api';
import { durableAgentWorkflow } from '../workflows/cookbook/durable-agent.js';
import { toolStreamingWorkflow } from '../workflows/cookbook/tool-streaming.js';
import {
  approvalHook,
  humanInTheLoopWorkflow,
} from '../workflows/cookbook/human-in-the-loop.js';
import { toolOrchestrationWorkflow } from '../workflows/cookbook/tool-orchestration.js';
import {
  stopHook,
  stopWorkflowDemo,
} from '../workflows/cookbook/stop-workflow.js';

describe('durable-agent pattern', () => {
  it('steps execute as tool calls and return results', async () => {
    const run = await start(durableAgentWorkflow, ['SFO', 'LAX']);
    const result = await run.returnValue;

    expect(result).toEqual({
      flightId: 'FL-100',
      confirmationId: 'CONF-FL-100',
    });
  });
});

describe('tool-streaming pattern', () => {
  it('getWritable() is available inside a step and workflow completes', async () => {
    const run = await start(toolStreamingWorkflow, ['test query']);
    const result = await run.returnValue;

    expect(result).toEqual({ count: 2, query: 'test query' });
  });
});

describe('human-in-the-loop pattern', () => {
  it('defineHook suspends, resumeHook with approval resumes', async () => {
    const run = await start(humanInTheLoopWorkflow, ['item-1']);

    const hook = await waitForHook(run, { token: 'approval:item-1' });
    expect(hook.token).toBe('approval:item-1');

    await approvalHook.resume('approval:item-1', {
      approved: true,
      comment: 'Looks good',
    });

    const result = await run.returnValue;
    expect(result).toEqual({
      status: 'approved',
      itemId: 'item-1',
      confirmed: true,
    });
  });

  it('defineHook suspends, resumeHook with rejection resumes', async () => {
    const run = await start(humanInTheLoopWorkflow, ['item-2']);

    await waitForHook(run, { token: 'approval:item-2' });

    await approvalHook.resume('approval:item-2', {
      approved: false,
      comment: 'Too expensive',
    });

    const result = await run.returnValue;
    expect(result).toEqual({
      status: 'rejected',
      itemId: 'item-2',
      comment: 'Too expensive',
    });
  });

  it('times out when no approval arrives (via sleep wakeUp)', async () => {
    const run = await start(humanInTheLoopWorkflow, ['item-3']);

    // The workflow races hook vs sleep('24h'). Wake up the sleep to simulate timeout.
    await waitForHook(run, { token: 'approval:item-3' });
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ status: 'expired', itemId: 'item-3' });
  });
});

describe('tool-orchestration pattern', () => {
  it('step-level tool executes directly, combined tool uses sleep', async () => {
    const run = await start(toolOrchestrationWorkflow, ['mykey']);

    // The workflow has a sleep(5000) in the combined path — wake it up
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({
      direct: 'data-for-mykey',
      delayed: 'data-for-mykey-delayed',
    });
  });
});

describe('stop-workflow pattern', () => {
  it('hook signal causes workflow to exit loop gracefully', async () => {
    const run = await start(stopWorkflowDemo, [10, 'stop:run-1']);

    // Wait for the stop hook to be created, then signal it after some work
    const hook = await waitForHook(run, { token: 'stop:run-1' });
    expect(hook.token).toBe('stop:run-1');

    await stopHook.resume('stop:run-1', { reason: 'User cancelled' });

    const result = await run.returnValue;
    expect(result.stopped).toBe(true);
    expect(result.stopReason).toBe('User cancelled');
    expect(result.completed).toBeLessThan(10);
  });

  it('completes all iterations when no stop signal', async () => {
    const run = await start(stopWorkflowDemo, [3, 'stop:run-2']);

    // Don't signal the stop hook — workflow should complete all iterations
    // But the hook is created, so we need to handle it. The workflow will
    // finish the loop before the hook resolves.
    const result = await run.returnValue;

    expect(result.stopped).toBe(false);
    expect(result.completed).toBe(3);
    expect(result.results).toHaveLength(3);
  });
});
