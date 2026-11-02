import {
  type RunInput,
  SPEC_VERSION_CURRENT,
  SPEC_VERSION_SINGLE_ORCHESTRATOR,
  type WorkflowRun,
} from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { AppendOnlyWorld } from '../test-support/append-only-world.js';
import {
  ORCHESTRATOR_QUEUE,
  registerWorkflow,
} from '../test-support/orchestrator-harness.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));

/** Delivers the queued copy of a start once and returns its run_started. */
async function runStartedOf(specVersion: number, deliveryCount: number) {
  const runId = `wrun_pk_${Math.random().toString(36).slice(2)}`;
  const started: Record<string, unknown>[] = [];
  const world = new AppendOnlyWorld({
    beforeCreate: (data) => {
      if (data.eventType === 'run_started') started.push(data.eventData ?? {});
    },
  });
  const input = await dehydrateWorkflowArguments([], runId, undefined, []);
  world.seedRun({
    runId,
    workflowName: 'workflow',
    deploymentId: 'dpl_test',
    status: 'pending',
    specVersion,
    input,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as WorkflowRun);
  setWorld(world.asWorld());
  await workflowEntrypoint(
    `async function workflow() { return undefined; }${registerWorkflow()}`
  )(new Request('https://example.test'));
  const runInput: RunInput = {
    input,
    deploymentId: 'dpl_test',
    workflowName: 'workflow',
    specVersion,
    encryptionPublicKey: 'pk_base64',
  };
  const message = world.enqueue(ORCHESTRATOR_QUEUE, {
    runId,
    requestedAt: new Date(),
    runInput,
  });
  await world.deliver({ ...message, deliveryCount }).catch(() => undefined);
  return started[0];
}

afterEach(() => {
  vi.restoreAllMocks();
});

// If run_created never landed, this run_started creates the run, and the
// run's public key is what lets other runs seal writes to it.
describe.each([
  ['spec 8', SPEC_VERSION_SINGLE_ORCHESTRATOR - 1],
  ['spec 9', SPEC_VERSION_CURRENT],
])('resilient run_started (%s)', (_label, specVersion) => {
  it.each([
    ['the first delivery', 1],
    ['a redelivery', 2],
  ])('forwards the run public key on %s', async (_l, deliveryCount) => {
    const eventData = await runStartedOf(specVersion, deliveryCount);
    expect(eventData?.encryptionPublicKey).toBe('pk_base64');
  });
});
