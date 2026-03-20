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
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run } from '../src/runtime';
import { start as rawStart } from '../src/runtime';
import {
  getWorkflowMetadata,
  setupRunTracking,
  setupWorld,
  trackRun,
} from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

async function start<T>(
  ...args: Parameters<typeof rawStart<T>>
): Promise<Run<T>> {
  const run = await rawStart<T>(...args);
  trackRun(run);
  return run;
}

// Next.js canary builds (16.2.0-canary.100+) have a regression where
// @workflow/ai step files are missing from the step bundle, causing
// "doStreamStep not found" errors. Skip agent tests on canary until fixed.
const isCanary = process.env.NEXT_CANARY === '1';

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

beforeEach((ctx) => {
  setupRunTracking(ctx.task.name);
});

// ============================================================================
// Core agent tests
// ============================================================================

describe.skipIf(isCanary)('DurableAgent e2e', { timeout: 120_000 }, () => {
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

  // ==========================================================================
  // prepareStep on constructor (#1303)
  // ==========================================================================

  describe('prepareStep on constructor', () => {
    it('agent-level prepareStep is called for each LLM step', async () => {
      const run = await start(
        await agentE2e('agentConstructorPrepareStepE2e'),
        []
      );
      const rv = await run.returnValue;
      // 2 LLM steps: tool-call + final text
      expect(rv.stepCount).toBe(2);
      expect(rv.prepareStepCallCount).toBe(2);
      expect(rv.prepareStepNumbers).toEqual([0, 1]);
    });

    it('stream-level prepareStep overrides constructor-level', async () => {
      const run = await start(
        await agentE2e('agentStreamPrepareStepOverrideE2e'),
        []
      );
      const rv = await run.returnValue;
      // Only the stream-level callback should have fired
      expect(rv.source).toEqual(['stream']);
    });
  });

  // ==========================================================================
  // Multimodal tool results (#848)
  // ==========================================================================

  describe('multimodal tool results', () => {
    it('passes through LanguageModelV3ToolResultOutput from tools', async () => {
      const run = await start(
        await agentE2e('agentMultimodalToolResultE2e'),
        []
      );
      const rv = await run.returnValue;
      expect(rv.stepCount).toBe(2);
      expect(rv.lastStepText).toBe('I see the image');
    });
  });

  // ==========================================================================
  // GAP tests
  // ==========================================================================

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
