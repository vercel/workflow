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
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { start } from '../src/runtime';
import {
  getProtectionBypassHeaders,
  getWorkbenchAppPath,
  isLocalDeployment,
} from './utils';

// ============================================================================
// Setup (same pattern as e2e.test.ts)
// ============================================================================

interface WorkflowManifest {
  version: string;
  workflows: Record<
    string,
    Record<string, { workflowId: string; graph?: unknown }>
  >;
  steps: Record<string, Record<string, { stepId: string }>>;
}

const deploymentUrl = process.env.DEPLOYMENT_URL;
if (!deploymentUrl) {
  throw new Error('`DEPLOYMENT_URL` environment variable is not set');
}

let cachedManifest: WorkflowManifest | null = null;

async function fetchManifest(): Promise<WorkflowManifest> {
  if (cachedManifest) return cachedManifest;
  const url = new URL('/.well-known/workflow/v1/manifest.json', deploymentUrl);
  const res = await fetch(url, { headers: getProtectionBypassHeaders() });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch manifest from ${url}: ${res.status} ${await res.text()}`
    );
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
  return cachedManifest;
}

function findWorkflowInManifest(
  manifest: WorkflowManifest,
  workflowFile: string,
  workflowFn: string
): { workflowId: string } | null {
  for (const [file, fns] of Object.entries(manifest.workflows)) {
    if (file.endsWith(workflowFile) || workflowFile.endsWith(file)) {
      if (fns[workflowFn]) return fns[workflowFn];
    }
  }
  const noExt = workflowFile.replace(/\.tsx?$/, '');
  for (const [file, fns] of Object.entries(manifest.workflows)) {
    const mNoExt = file.replace(/\.tsx?$/, '');
    if (mNoExt.endsWith(noExt) || noExt.endsWith(mNoExt)) {
      if (fns[workflowFn]) return fns[workflowFn];
    }
  }
  return null;
}

const manifestRetryMs = Number(
  process.env.WORKFLOW_E2E_MANIFEST_RETRY_MS ?? '10000'
);

async function getWorkflowMetadata(
  workflowFile: string,
  workflowFn: string
): Promise<{ workflowId: string }> {
  try {
    const manifest = await fetchManifest();
    const meta = findWorkflowInManifest(manifest, workflowFile, workflowFn);
    if (meta) return meta;
  } catch {
    // fall through
  }
  const deadline = Date.now() + manifestRetryMs;
  while (Date.now() < deadline) {
    cachedManifest = null;
    try {
      const manifest = await fetchManifest();
      const meta = findWorkflowInManifest(manifest, workflowFile, workflowFn);
      if (meta) return meta;
    } catch {
      // keep retrying
    }
    await sleep(250);
  }
  const noExt = workflowFile.replace(/\.tsx?$/, '');
  return { workflowId: `workflow//./${noExt}//${workflowFn}` };
}

async function agentE2e(fn: string) {
  return getWorkflowMetadata('workflows/100_durable_agent_e2e.ts', fn);
}

// ============================================================================
// Setup: configure world based on environment
// ============================================================================

beforeAll(async () => {
  if (isLocalDeployment()) {
    const appPath = getWorkbenchAppPath();
    process.env.WORKFLOW_LOCAL_BASE_URL = deploymentUrl;
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(
      appPath,
      '.next/workflow-data'
    );
  }
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
      const run = await start(
        await agentE2e('agentOnToolCallStartE2e'),
        []
      );
      const rv = await run.returnValue;
      // GAP: when implemented, should be ['constructor', 'method']
      expect(rv.calls).toEqual([]);
    });
  });

  describe('experimental_onToolCallFinish (GAP)', () => {
    it('completes but callbacks are not called (GAP)', async () => {
      const run = await start(
        await agentE2e('agentOnToolCallFinishE2e'),
        []
      );
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
