import type { Event, RunInput, WorkflowRun } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const RUN_ID = 'wrun_01JEXAMPLE0000000000000000';

const workflowRun: WorkflowRun = {
  runId: RUN_ID,
  status: 'running',
  deploymentId: 'dpl_creator',
  workflowName: 'testWorkflow',
  specVersion: SPEC_VERSION_CURRENT,
  startedAt: new Date('2026-07-30T00:00:00.000Z'),
  createdAt: new Date('2026-07-30T00:00:00.000Z'),
  updatedAt: new Date('2026-07-30T00:00:00.000Z'),
} as WorkflowRun;

const runInput: RunInput = {
  input: undefined,
  deploymentId: 'dpl_creator',
  workflowName: 'testWorkflow',
  specVersion: SPEC_VERSION_CURRENT,
  encryptionPublicKey: 'pk_base64',
};

/** Delivers the queued copy of a start once and returns what it wrote. */
async function deliver(attempt: number) {
  const created: { eventType: string; eventData?: Record<string, unknown> }[] =
    [];
  const events: Event[] = [];
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    getDeploymentId: vi.fn(async () => 'dpl_creator'),
    createQueueHandler: vi.fn(
      (
        _prefix: string,
        handler: (message: unknown, metadata: unknown) => Promise<unknown>
      ) =>
        async () => {
          await handler(
            {
              runId: RUN_ID,
              requestedAt: new Date('2026-07-30T00:00:00.000Z'),
              runInput,
            },
            {
              requestId: 'req_test',
              attempt,
              queueName: '__wkf_workflow_testWorkflow',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: vi.fn(async (_runId: string, data: any) => {
        created.push(data);
        if (data.eventType === 'run_started') {
          return { run: workflowRun, events };
        }
        return { event: { eventId: `event-${created.length}`, ...data } };
      }),
      list: vi.fn(async () => ({
        data: events,
        hasMore: false,
        cursor: 'cursor_test',
      })),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const handler = workflowEntrypoint(
    `async function testWorkflow() { return undefined; }
     ;globalThis.__private_workflows = new Map();
     globalThis.__private_workflows.set('testWorkflow', testWorkflow);`
  );
  await handler(new Request('https://example.test'));
  return created;
}

describe('resilient run_started', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // If run_created never landed, this run_started creates the run, and the
  // run's public key is what lets other runs seal writes to it.
  it.each([
    ['the first delivery', 1],
    ['a redelivery', 2],
  ])('forwards the run public key on %s', async (_label, attempt) => {
    const created = await deliver(attempt);
    const runStarted = created.find((e) => e.eventType === 'run_started');
    expect(runStarted?.eventData?.encryptionPublicKey).toBe('pk_base64');
  });
});
