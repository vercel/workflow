/**
 * E2E tests for DurableAgent workflows.
 *
 * Tests exercise DurableAgent through the full workflow runtime using mock
 * providers from @workflow/ai/test. Tests marked it.fails() correspond to
 * known API gaps that need implementation.
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-agent.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/runtime';
import { getWorkflowMetadata, setupWorld } from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

async function agentE2e(fn: string) {
  return getWorkflowMetadata(
    deploymentUrl,
    'workflows/100_durable_agent_e2e.ts',
    fn
  );
}

beforeAll(async () => {
  setupWorld(deploymentUrl);
});

// ============================================================================
// Core agent tests
// ============================================================================

describe('DurableAgent e2e', { timeout: 120_000 }, () => {
  describe('core', () => {
    it('basic text response', async () => {
      const run = await start(await agentE2e('agentBasicE2e'), ['hello world']);
      const rv = await run.returnValue;
      expect(rv).toMatchObject({
        stepCount: 1,
        lastStepText: 'Echo: hello world',
      });
    });

    it('single tool call', async () => {
      const run = await start(await agentE2e('agentToolCallE2e'), [3, 7]);
      const rv = await run.returnValue;
      expect(rv).toMatchObject({ stepCount: 2 });
      expect(rv.lastStepText).toBe('The sum is 10');
    });

    it('multiple sequential tool calls', async () => {
      const run = await start(await agentE2e('agentMultiStepE2e'), []);
      const rv = await run.returnValue;
      expect(rv).toMatchObject({
        stepCount: 4,
        lastStepText: 'All done!',
      });
    });

    it('tool error recovery', async () => {
      const run = await start(await agentE2e('agentErrorToolE2e'), []);
      const rv = await run.returnValue;
      expect(rv).toMatchObject({
        stepCount: 2,
        lastStepText: 'Tool failed but I recovered.',
      });
    });
  });

  // ==========================================================================
  // onStepFinish callback tests
  // ==========================================================================

  describe('onStepFinish', () => {
    it('fires constructor + stream callbacks in order with step data', async () => {
      const run = await start(await agentE2e('agentOnStepFinishE2e'), []);
      const rv = await run.returnValue;

      // Constructor callback fires first, then stream callback
      expect(rv.callSources).toEqual(['constructor', 'method']);

      // Step result data is captured
      expect(rv.capturedStepResult).toMatchObject({
        text: 'hello',
        finishReason: 'stop',
      });

      expect(rv.stepCount).toBe(1);
    });
  });

  // ==========================================================================
  // onFinish callback tests
  // ==========================================================================

  describe('onFinish', () => {
    it('fires constructor + stream callbacks in order with event data', async () => {
      const run = await start(await agentE2e('agentOnFinishE2e'), []);
      const rv = await run.returnValue;

      expect(rv.callSources).toEqual(['constructor', 'method']);

      expect(rv.capturedEvent).toMatchObject({
        text: 'hello from finish',
        finishReason: 'stop',
        stepsLength: 1,
        hasMessages: true,
        hasTotalUsage: true,
      });
    });
  });

  // ==========================================================================
  // Instructions test
  // ==========================================================================

  describe('instructions', () => {
    it('string instructions are passed to the model', async () => {
      const run = await start(await agentE2e('agentInstructionsStringE2e'), []);
      const rv = await run.returnValue;
      expect(rv.stepCount).toBe(1);
      expect(rv.lastStepText).toBe('ok');
    });
  });

  // ==========================================================================
  // Timeout test
  // ==========================================================================

  describe('timeout', () => {
    it('completes within timeout', async () => {
      const run = await start(await agentE2e('agentTimeoutE2e'), []);
      const rv = await run.returnValue;
      expect(rv).toMatchObject({
        stepCount: 1,
        lastStepText: 'fast response',
      });
    });
  });

  // ==========================================================================
  // GAP tests — these fail until the feature is implemented
  // ==========================================================================

  describe('experimental_onStart (GAP)', () => {
    it('completes but callbacks are not called (GAP)', async () => {
      const run = await start(await agentE2e('agentOnStartE2e'), []);
      const rv = await run.returnValue;
      // GAP: when implemented, should be ['constructor', 'method']
      expect(rv.callSources).toEqual([]);
    });
  });

  describe('experimental_onStepStart (GAP)', () => {
    it('completes but callbacks are not called (GAP)', async () => {
      const run = await start(await agentE2e('agentOnStepStartE2e'), []);
      const rv = await run.returnValue;
      // GAP: when implemented, should be ['constructor', 'method']
      expect(rv.callSources).toEqual([]);
    });
  });

  describe('experimental_onToolCallStart (GAP)', () => {
    it('completes but callbacks are not called (GAP)', async () => {
      const run = await start(await agentE2e('agentOnToolCallStartE2e'), []);
      const rv = await run.returnValue;
      // GAP: when implemented, should be ['constructor', 'method']
      expect(rv.calls).toEqual([]);
    });
  });

  describe('experimental_onToolCallFinish (GAP)', () => {
    it('completes but callbacks are not called (GAP)', async () => {
      const run = await start(await agentE2e('agentOnToolCallFinishE2e'), []);
      const rv = await run.returnValue;
      // GAP: when implemented, should be ['constructor', 'method']
      expect(rv.calls).toEqual([]);
      // GAP: capturedEvent should have tool result data
      expect(rv.capturedEvent).toBeNull();
    });
  });

  describe('prepareCall (GAP)', () => {
    it('completes but prepareCall is not applied (GAP)', async () => {
      const run = await start(await agentE2e('agentPrepareCallE2e'), []);
      const rv = await run.returnValue;
      expect(rv.stepCount).toBe(1);
    });
  });

  describe('tool approval (GAP)', () => {
    it('completes but needsApproval is not checked (GAP)', async () => {
      const run = await start(await agentE2e('agentToolApprovalE2e'), []);
      const rv = await run.returnValue;
      // GAP: when tool approval is implemented, the agent should pause
      // with toolCallsCount=1 and toolResultsCount=0 (awaiting approval).
      // Currently needsApproval is ignored, so the tool executes immediately.
      // The workflow completes with both tool call and result.
      expect(rv.stepCount).toBe(2);
      // When implemented, these should be:
      // expect(rv.toolCallsCount).toBe(1);
      // expect(rv.toolResultsCount).toBe(0);
      // expect(rv.firstToolCallName).toBe('riskyTool');
    });
  });
});
