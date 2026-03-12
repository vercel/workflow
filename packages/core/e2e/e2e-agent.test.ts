/**
 * E2E tests for DurableAgent workflows.
 *
 * These tests exercise DurableAgent through the full workflow runtime using
 * mock LLM providers (no real API calls). They validate that the agent loop,
 * tool execution, multi-step, and error handling work correctly end-to-end.
 *
 * Run locally:
 *   1. cd workbench/nextjs-turbopack && pnpm dev
 *   2. DEPLOYMENT_URL=http://localhost:3000 APP_NAME=nextjs-turbopack \
 *      pnpm vitest run packages/core/e2e/e2e-agent.test.ts
 */
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, test } from 'vitest';
import { getRun, start } from '../src/runtime';
import {
  cliInspectJson,
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
  const res = await fetch(url, {
    headers: getProtectionBypassHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch manifest from ${url}: ${res.status} ${await res.text()}`
    );
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
  return cachedManifest;
}

function findWorkflowMetadataInManifest(
  manifest: WorkflowManifest,
  workflowFile: string,
  workflowFn: string
): { workflowId: string } | null {
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    if (
      manifestFile.endsWith(workflowFile) ||
      workflowFile.endsWith(manifestFile)
    ) {
      const entry = functions[workflowFn];
      if (entry) return entry;
    }
  }

  const fileWithoutExt = workflowFile.replace(/\.tsx?$/, '');
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    const manifestFileWithoutExt = manifestFile.replace(/\.tsx?$/, '');
    if (
      manifestFileWithoutExt.endsWith(fileWithoutExt) ||
      fileWithoutExt.endsWith(manifestFileWithoutExt)
    ) {
      const entry = functions[workflowFn];
      if (entry) return entry;
    }
  }

  return null;
}

function getFallbackWorkflowId(
  workflowFile: string,
  workflowFn: string
): string {
  const fileWithoutExt = workflowFile.replace(/\.tsx?$/, '');
  return `workflow//./${fileWithoutExt}//${workflowFn}`;
}

const manifestRetryTimeoutMs = Number(
  process.env.WORKFLOW_E2E_MANIFEST_RETRY_MS ?? '10000'
);
const manifestRetryIntervalMs = 250;

async function getWorkflowMetadata(
  workflowFile: string,
  workflowFn: string
): Promise<{ workflowId: string }> {
  let manifest: WorkflowManifest;
  try {
    manifest = await fetchManifest();
  } catch {
    return { workflowId: getFallbackWorkflowId(workflowFile, workflowFn) };
  }

  let metadata = findWorkflowMetadataInManifest(
    manifest,
    workflowFile,
    workflowFn
  );
  if (metadata) return metadata;

  // Retry with cache bust for deferred discovery
  const deadline = Date.now() + manifestRetryTimeoutMs;
  while (Date.now() < deadline) {
    cachedManifest = null;
    manifest = await fetchManifest();
    metadata = findWorkflowMetadataInManifest(
      manifest,
      workflowFile,
      workflowFn
    );
    if (metadata) return metadata;
    await sleep(manifestRetryIntervalMs);
  }

  return { workflowId: getFallbackWorkflowId(workflowFile, workflowFn) };
}

// Shorthand for getting agent e2e workflow metadata
async function agentE2e(workflowFn: string) {
  return getWorkflowMetadata('workflows/100_durable_agent_e2e.ts', workflowFn);
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
    expect(returnValue).toMatchObject({
      stepCount: 2, // Step 1: tool call, Step 2: text response
    });
    // The last step should contain the final text
    expect(returnValue.lastStepText).toBe('The sum is 10');
  });

  test('agentMultiStepE2e - multiple sequential tool calls', async () => {
    const meta = await agentE2e('agentMultiStepE2e');
    const run = await start(meta, []);

    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({
      stepCount: 4, // 3 tool call steps + 1 text response step
      lastStepText: 'All done!',
    });
  });

  test('agentErrorToolE2e - tool error recovery', async () => {
    const meta = await agentE2e('agentErrorToolE2e');
    const run = await start(meta, []);

    const returnValue = await run.returnValue;
    expect(returnValue).toMatchObject({
      stepCount: 2, // Step 1: tool call (error), Step 2: text response
      lastStepText: 'Tool failed but I recovered.',
    });
  });
});
