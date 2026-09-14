/**
 * E2E tests for WorkflowAgent workflows.
 *
 * Tests exercise AI SDK 7's WorkflowAgent through the full workflow runtime
 * using a serializable mock provider.
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-agent.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Run, start as rawStart } from '../src/runtime';
import {
  getWorkflowMetadata,
  setupRunTracking,
  setupWorld,
  startTracked,
  writeInfraSidecar,
} from './utils';

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

async function start<T>(
  ...args: Parameters<typeof rawStart<T>>
): Promise<Run<T>> {
  return startTracked<T>(...args);
}

afterAll(() => {
  writeInfraSidecar();
});

// WorkflowAgent tests are only supported on Next.js and SvelteKit deployments.
// Nitro-based BOA deployments use the V2 combined handler which needs
// additional work for WorkflowAgent support on these frameworks.
const supportedApps = new Set([
  'nextjs-turbopack',
  'nextjs-webpack',
  'sveltekit',
]);
const isUnsupportedApp =
  process.env.APP_NAME && !supportedApps.has(process.env.APP_NAME);

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

describe.skipIf(isUnsupportedApp)(
  'WorkflowAgent e2e',
  { timeout: 120_000 },
  () => {
    describe('core', () => {
      it('basic text response', async () => {
        const run = await start(await agentE2e('agentBasicE2e'), [
          'hello world',
        ]);
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
    // onStepEnd callback tests
    // ==========================================================================

    describe('onStepEnd', () => {
      it('fires constructor + stream callbacks in order with step data', async () => {
        const run = await start(await agentE2e('agentOnStepEndE2e'), []);
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
    // onEnd callback tests
    // ==========================================================================

    describe('onEnd', () => {
      it('fires constructor + stream callbacks in order with event data', async () => {
        const run = await start(await agentE2e('agentOnEndE2e'), []);
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
    // Provider tool tests
    // ==========================================================================

    describe('provider tools', () => {
      it('provider tool identity preserved across step boundaries', async () => {
        const run = await start(await agentE2e('agentProviderToolE2e'), []);
        const rv = await run.returnValue;
        expect(rv).toMatchObject({
          stepCount: 2,
          lastStepText: 'I found a result for you.',
        });
      });

      it('mixed provider and function tools', async () => {
        const run = await start(await agentE2e('agentMixedToolsE2e'), [3, 7]);
        const rv = await run.returnValue;
        expect(rv).toMatchObject({
          stepCount: 3,
          lastStepText: 'The answer is 10',
        });
      });
    });

    // ==========================================================================
    // Instructions test
    // ==========================================================================

    describe('instructions', () => {
      it('string instructions are passed to the model', async () => {
        const run = await start(
          await agentE2e('agentInstructionsStringE2e'),
          []
        );
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
    // Additional WorkflowAgent callbacks
    // ==========================================================================

    describe('experimental_onStart', () => {
      it('fires constructor + stream callbacks in order', async () => {
        const run = await start(await agentE2e('agentOnStartE2e'), []);
        const rv = await run.returnValue;
        expect(rv.callSources).toEqual(['constructor', 'method']);
      });
    });

    describe('experimental_onStepStart', () => {
      it('fires constructor + stream callbacks in order', async () => {
        const run = await start(await agentE2e('agentOnStepStartE2e'), []);
        const rv = await run.returnValue;
        expect(rv.callSources).toEqual(['constructor', 'method']);
      });
    });

    describe('onToolExecutionStart', () => {
      it('fires constructor + stream callbacks in order', async () => {
        const run = await start(
          await agentE2e('agentOnToolExecutionStartE2e'),
          []
        );
        const rv = await run.returnValue;
        expect(rv.calls).toEqual(['constructor', 'method']);
      });
    });

    describe('onToolExecutionEnd', () => {
      it('fires constructor + stream callbacks with the tool result', async () => {
        const run = await start(
          await agentE2e('agentOnToolExecutionEndE2e'),
          []
        );
        const rv = await run.returnValue;
        expect(rv.calls).toEqual(['constructor', 'method']);
        expect(rv.capturedEvent).toMatchObject({
          toolName: 'addNumbers',
          success: true,
          output: 3,
        });
      });
    });

    describe('prepareCall', () => {
      it('applies prepareCall before streaming', async () => {
        const run = await start(await agentE2e('agentPrepareCallE2e'), []);
        const rv = await run.returnValue;
        expect(rv.stepCount).toBe(1);
        expect(rv.prepareCallCount).toBe(1);
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
      it('passes through LanguageModelV4ToolResultOutput from tools', async () => {
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
    // Tool approval
    // ==========================================================================

    describe('tool approval', () => {
      it('pauses before executing a tool that needs approval', async () => {
        const run = await start(await agentE2e('agentToolApprovalE2e'), []);
        const rv = await run.returnValue;
        expect(rv.stepCount).toBe(1);
        expect(rv.toolCallsCount).toBe(1);
        expect(rv.toolResultsCount).toBe(0);
        expect(rv.firstToolCallName).toBe('riskyTool');
      });
    });
  }
);
