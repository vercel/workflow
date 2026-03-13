/**
 * E2E tests for DurableAgent workflows.
 *
 * These tests exercise DurableAgent through the full workflow runtime using
 * mock LLM providers from @workflow/ai/test (no real API calls).
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-agent.test.ts
 */
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, test } from 'vitest';
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
    // fall through to retry
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

  // Fallback to deterministic ID
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
// Tests
// ============================================================================

describe('DurableAgent e2e', { timeout: 120_000 }, () => {
  test('agentBasicE2e - basic text response', async () => {
    const meta = await agentE2e('agentBasicE2e');
    const run = await start(meta, ['hello world']);
    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({
      stepCount: 1,
      lastStepText: 'Echo: hello world',
    });
  });

  test('agentToolCallE2e - single tool call', async () => {
    const meta = await agentE2e('agentToolCallE2e');
    const run = await start(meta, [3, 7]);
    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({ stepCount: 2 });
    expect(returnValue.lastStepText).toBe('The sum is 10');
  });

  test('agentMultiStepE2e - multiple sequential tool calls', async () => {
    const meta = await agentE2e('agentMultiStepE2e');
    const run = await start(meta, []);
    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({
      stepCount: 4,
      lastStepText: 'All done!',
    });
  });

  test('agentErrorToolE2e - tool error recovery', async () => {
    const meta = await agentE2e('agentErrorToolE2e');
    const run = await start(meta, []);
    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({
      stepCount: 2,
      lastStepText: 'Tool failed but I recovered.',
    });
  });
});
