import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { reportWorkflowInvocation } from './platform-attribution.js';
import { setWorld } from './world.js';

const RUNTIME_IPC = Symbol.for('@vercel/rusty-runtime-ipc');
const globals = globalThis as Record<symbol, unknown>;

afterEach(() => {
  delete globals[RUNTIME_IPC];
  setWorld(undefined);
  vi.restoreAllMocks();
});

describe('reportWorkflowInvocation', () => {
  it('reports the run to the runtime', () => {
    const report = vi.fn();
    globals[RUNTIME_IPC] = { reportWorkflowInvocation: report };

    reportWorkflowInvocation('wrun_01KV1XZ14MKB1CVSBRY60WYDMT');

    expect(report).toHaveBeenCalledExactlyOnceWith({
      runId: 'wrun_01KV1XZ14MKB1CVSBRY60WYDMT',
    });
  });

  it('does nothing without the runtime hook', () => {
    expect(() => reportWorkflowInvocation('wrun_x')).not.toThrow();
    globals[RUNTIME_IPC] = { sendMetric: vi.fn() };
    expect(() => reportWorkflowInvocation('wrun_x')).not.toThrow();
  });

  it('never throws into the delivery', () => {
    globals[RUNTIME_IPC] = {
      reportWorkflowInvocation: () => {
        throw new Error('socket closed');
      },
    };
    expect(() => reportWorkflowInvocation('wrun_x')).not.toThrow();
  });
});

describe('orchestrator delivery', () => {
  it('reports its run before running it, so the platform attributes the request', async () => {
    const runId = 'wrun_01KV1XZ14MKB1CVSBRY60WYDMT';
    const report = vi.fn();
    globals[RUNTIME_IPC] = { reportWorkflowInvocation: report };
    // A run the World no longer has: the delivery stops early, after the report.
    setWorld({
      capabilities: { inBandFence: true },
      specVersion: SPEC_VERSION_CURRENT,
      events: {
        create: vi.fn().mockRejectedValue(new Error('stop here')),
        list: async () => ({ data: [], hasMore: false, cursor: null }),
      },
      runs: {
        get: vi.fn().mockRejectedValue(new Error('stop here')),
      },
      createQueueHandler: (_prefix, handler) => async () => {
        await handler(
          {
            runId,
            requestedAt: new Date(),
            runSpecVersion: SPEC_VERSION_CURRENT,
          },
          {
            requestId: 'req_test',
            attempt: 1,
            queueName: '__wkf_workflow_workflow',
            messageId: 'msg_test',
          }
        ).catch(() => {});
        return new Response(null, { status: 204 });
      },
    } as unknown as World);

    await workflowEntrypoint('')(new Request('http://localhost/'));

    expect(report).toHaveBeenCalledWith({ runId });
  });
});
