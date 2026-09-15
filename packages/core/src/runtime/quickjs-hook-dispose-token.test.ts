/**
 * Pins that the QuickJS engine sends the disposed hook's token on
 * `hook_disposed`, the way the node:vm engine always has.
 *
 * A hook's token can be claimed separately from the hook itself, so a world
 * that has to release both needs to be told which token this disposal is for.
 * The two engines disagreeing about that means the same workflow does different
 * work depending on which VM ran it, which is the kind of difference that shows
 * up as a backend-only bug report.
 *
 * The QuickJS VM is mocked: what is under test is the request the entrypoint
 * builds from a pending operation, not the VM that produced the operation.
 */
import {
  type CreateEventRequest,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { describe, expect, it, vi } from 'vitest';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

/** Drive the entrypoint over a single `hook_dispose` pending operation. */
async function disposeWith(op: Record<string, unknown>) {
  const runId = 'wrun_dispose_token';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  const workflowRun: WorkflowRun = {
    runId,
    workflowName: 'workflow',
    status: 'running',
    input: [],
    deploymentId: 'dpl_dispose_token',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  const createdEvents: CreateEventRequest[] = [];
  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: vi.fn(async () => ({ data: [], cursor: null, hasMore: false })),
      create: vi.fn(async (_runId: string, request: CreateEventRequest) => {
        createdEvents.push(request);
        return { event: { ...request, runId, eventId: 'evnt_created' } };
      }),
    },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_dispose_token' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  startQuickJSWorkflow.mockResolvedValue({
    result: { suspended: { pendingOperations: [op] } },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  });

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun,
    preloadedEvents: [],
  });

  return createdEvents.filter((e) => e.eventType === 'hook_disposed');
}

describe('QuickJS hook_disposed', () => {
  it('carries the disposed hook’s token', async () => {
    const disposals = await disposeWith({
      type: 'hook_dispose',
      correlationId: 'hook_01JCHOOK',
      token: 'order-42-approve',
      hasCreatedEvent: false,
    });

    expect(disposals).toHaveLength(1);
    expect(disposals[0].eventData).toEqual({ token: 'order-42-approve' });
  });

  it('omits eventData entirely when the operation carries no token', async () => {
    // `PendingHookDispose.token` is optional. Sending `{ token: undefined }`
    // would encode differently across the JSON and CBOR wire formats, so the
    // field is left off instead — indistinguishable from a client too old to
    // send one, which is the case a world already has to handle.
    const disposals = await disposeWith({
      type: 'hook_dispose',
      correlationId: 'hook_01JCHOOK',
      hasCreatedEvent: false,
    });

    expect(disposals).toHaveLength(1);
    expect(disposals[0].eventData).toBeUndefined();
    expect('eventData' in disposals[0]).toBe(false);
  });
});
