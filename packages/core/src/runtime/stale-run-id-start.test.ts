import { WorkflowWorldError } from '@workflow/errors';
import type { RunInput } from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeLogger } from '../logger.js';
import { workflowEntrypoint } from '../runtime.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    p.catch(() => {});
  }),
}));

const DAY_MS = 24 * 60 * 60 * 1000;

const runInput: RunInput = {
  input: undefined,
  deploymentId: 'dpl_creator',
  workflowName: 'testWorkflow',
  specVersion: SPEC_VERSION_CURRENT,
};

/** What world-vercel throws for the backend's 400 on a run ID it won't accept. */
function runIdTimestampRejection(): WorkflowWorldError {
  return new WorkflowWorldError(
    'Invalid runId timestamp: embedded timestamp is 172800s in the past (threshold: 86400s)',
    { status: 400, code: 'invalid-run-id-timestamp' }
  );
}

/**
 * Deliver a message carrying `runInput` (the shape whose `run_started` makes the
 * backend create a run whose `run_created` never landed) and reject that
 * `run_started` with `rejection`. A redelivery by default: turbo only engages on
 * the first attempt, and a message only outlives its run ID's window by being
 * redelivered.
 */
async function runHandler(options: {
  runId: string;
  rejection: Error;
  attempt?: number;
}) {
  const createdEvents: { eventType: string }[] = [];
  const eventsCreate = vi.fn(async (_runId: string, data: any) => {
    createdEvents.push(data);
    if (data.eventType === 'run_started') throw options.rejection;
    return { event: { eventId: `event-${createdEvents.length}`, ...data } };
  });

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
              runId: options.runId,
              requestedAt: new Date(),
              runInput,
            },
            {
              requestId: 'req_test',
              attempt: options.attempt ?? 2,
              queueName: '__wkf_workflow_testWorkflow',
              messageId: 'msg_test',
            }
          );
          return new Response(null, { status: 204 });
        }
    ),
    events: {
      create: eventsCreate,
      list: vi.fn(async () => ({ data: [], hasMore: false, cursor: null })),
    },
    runs: { get: vi.fn() },
    queue: vi.fn(async () => ({ messageId: null })),
    getEncryptionKeyForRun: vi.fn(async () => undefined),
  } as any);

  const handler = workflowEntrypoint(
    `async function testWorkflow() { return undefined; }
     ;globalThis.__private_workflows = new Map();
     globalThis.__private_workflows.set('testWorkflow', testWorkflow);`
  );
  const response = await handler(new Request('https://example.test'));
  return { createdEvents, response };
}

describe('a run_started refused for its run ID timestamp', () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  const discardLogs = () =>
    errorLog.mock.calls.filter(([message]) =>
      String(message).includes('whose run was never created')
    );

  beforeEach(() => {
    errorLog = vi.spyOn(runtimeLogger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('acks the message when the run ID is too old, instead of redelivering it', async () => {
    const runId = `wrun_${ulid(Date.now() - 2 * DAY_MS)}`;

    const { createdEvents, response } = await runHandler({
      runId,
      rejection: runIdTimestampRejection(),
    });

    expect(response.status).toBe(204);
    // There is no run to fail: the rejected write was the one creating it.
    expect(createdEvents.map((e) => e.eventType)).toEqual(['run_started']);
    expect(discardLogs()).toHaveLength(1);
    expect(discardLogs()[0]?.[1]).toMatchObject({
      workflowRunId: runId,
      attempt: 2,
    });
  });

  // A run ID minted ahead of the backend's clock is refused too, but time
  // fixes that one, so a redelivery may succeed.
  it('still redelivers when the run ID is ahead of the clock', async () => {
    const runId = `wrun_${ulid(Date.now() + 10 * 60 * 1000)}`;

    await expect(
      runHandler({ runId, rejection: runIdTimestampRejection() })
    ).rejects.toThrow('Invalid runId timestamp');
    expect(discardLogs()).toHaveLength(0);
  });

  it('still redelivers on any other 400', async () => {
    const runId = `wrun_${ulid(Date.now() - 2 * DAY_MS)}`;

    await expect(
      runHandler({
        runId,
        rejection: new WorkflowWorldError('bad request', {
          status: 400,
          code: 'validation-error',
        }),
      })
    ).rejects.toThrow('bad request');
    expect(discardLogs()).toHaveLength(0);
  });
});
