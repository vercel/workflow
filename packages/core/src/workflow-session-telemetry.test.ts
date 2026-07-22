import { trace as otelTrace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { WorkflowRun } from '@workflow/world';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ReplayPayloadCache } from './replay-payload-cache.js';
import { dehydrateWorkflowArguments } from './serialization.js';
import { executeWorkflow } from './workflow.js';

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider();

beforeAll(() => {
  provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
  otelTrace.setGlobalTracerProvider(provider);
});

afterAll(async () => {
  await provider.shutdown();
  otelTrace.disable();
});

afterEach(() => {
  exporter.reset();
});

describe('retained workflow telemetry', () => {
  it('records suspension attributes on workflow.run spans', async () => {
    const runId = 'wrun_retained_telemetry';
    const workflowRun: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      startedAt: new Date('2024-01-01T00:00:00.000Z'),
      deploymentId: 'test-deployment',
    };
    const workflowCode = `
      const step = globalThis[Symbol.for("WORKFLOW_USE_STEP")]("step");
      async function workflow() { await step(); }
      globalThis.__private_workflows = new Map([["workflow", workflow]]);`;

    const result = await executeWorkflow({
      type: 'replay',
      workflowCode,
      workflowRun,
      events: [],
      encryptionKey: undefined,
      replayPayloadCache: new ReplayPayloadCache(undefined),
    });
    expect(result.type).toBe('suspended');

    const span = exporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === 'workflow.run workflow');
    expect(span?.attributes).toMatchObject({
      'workflow.execution.mode': 'replay',
      'workflow.suspension.state': 'suspended',
      'workflow.suspension.step_count': 1,
      'workflow.suspension.hook_count': 0,
      'workflow.suspension.wait_count': 0,
    });
  });
});
