import type {
  CreateEventRequest,
  Event,
  WorkflowRun,
  World,
} from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { ReplayPayloadCache } from '../replay-payload-cache.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { replayWorkflow, runWorkflow } from '../workflow.js';
import { runWorkflowWithQuickJS } from './quickjs-entrypoint.js';
import { runQuickJSWorkflow } from './quickjs-runtime.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({ getPortLazy: async () => 3000 }));

afterEach(() => setWorld(undefined));

describe.each([
  'node',
  'quickjs',
] as const)('%s terminal hook cleanup', (engine) => {
  async function setup(body: string) {
    const runId = 'wrun_terminal_hook';
    const now = new Date('2025-01-01T00:00:00Z');
    const workflowRun: WorkflowRun = {
      runId,
      workflowName: 'workflow',
      status: 'running',
      input: await dehydrateWorkflowArguments([], runId, undefined, []),
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      deploymentId: 'dpl_terminal_hook',
      specVersion: SPEC_VERSION_CURRENT,
    };
    const workflowCode = `
      var createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
      async function workflow() { ${body} }
      globalThis.__private_workflows = new Map([['workflow', workflow]]);
    `;
    const create = vi.fn(
      async (_runId: string, request: CreateEventRequest) => ({
        event: { ...request, runId, eventId: 'evnt_written', createdAt: now },
      })
    );
    const writeStream = vi.fn();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: {},
      events: {
        create,
        list: async () => ({ data: [], cursor: null, hasMore: false }),
      },
      streams: { write: writeStream },
      getEncryptionKeyForRun: async () => undefined,
    } as unknown as World);

    const execute = (events: Event[]) =>
      engine === 'node'
        ? runWorkflow(workflowCode, workflowRun, events, undefined)
        : runWorkflowWithQuickJS({
            workflowCode,
            workflowName: 'workflow',
            workflowRun,
            preloadedEvents: events,
            preloadedEventsComplete: true,
          });

    return { workflowCode, workflowRun, create, writeStream, execute };
  }

  it.each([
    'completed',
    'failed',
  ] as const)('omits disposal of a registered hook when the run %s', async (outcome) => {
    const { workflowCode, workflowRun, create, execute } = await setup(`
        var hook = createHook({ token: 'registered' });
        try {
          await hook;
          ${outcome === 'failed' ? 'throw new Error("workflow failed");' : 'return "done";'}
        } finally {
          // The runtime behavior produced by a function-scoped using hook.
          hook.dispose();
        }
      `);
    let correlationId: string;
    if (engine === 'node') {
      const first = await replayWorkflow({
        workflowCode,
        workflowRun,
        events: [],
        encryptionKey: undefined,
        replayPayloadCache: new ReplayPayloadCache(undefined),
      });
      assert(first.type === 'suspended');
      correlationId = first.suspension.items[0].correlationId;
    } else {
      const first = await runQuickJSWorkflow({
        workflowCode,
        workflowId: 'workflow',
        workflowRun,
        events: [],
      });
      assert(first.suspended);
      correlationId = first.suspended.pendingOperations[0].correlationId;
    }

    const base = {
      runId: workflowRun.runId,
      createdAt: workflowRun.createdAt,
    };
    const events: Event[] = [
      {
        ...base,
        eventId: 'evnt_created',
        eventType: 'run_created',
        eventData: { input: workflowRun.input },
      },
      {
        ...base,
        eventId: 'evnt_hook_created',
        eventType: 'hook_created',
        correlationId,
        eventData: { token: 'registered' },
      },
      {
        ...base,
        eventId: 'evnt_hook_received',
        eventType: 'hook_received',
        correlationId,
        eventData: {
          token: 'registered',
          payload: await dehydrateStepReturnValue(
            'ready',
            workflowRun.runId,
            undefined
          ),
        },
      },
    ];
    if (engine === 'node' && outcome === 'failed') {
      await expect(execute(events)).rejects.toThrow('workflow failed');
    } else {
      await execute(events);
    }
    // The node VM returns its outcome to the caller; the QuickJS entrypoint
    // also writes the terminal event. Neither needs a separate disposal.
    expect(create.mock.calls.map(([, event]) => event.eventType)).toEqual(
      engine === 'node' ? [] : [`run_${outcome}`]
    );
  });

  it.each([
    'completed',
    'failed',
  ] as const)('keeps the disposal needed to reuse a token when the run %s', async (outcome) => {
    const { create, execute } = await setup(`
        var first = createHook({ token: 'reused' });
        first.dispose();
        var second = createHook({ token: 'reused' });
        second.dispose();
        var other = createHook({ token: 'other' });
        other.dispose();
        ${outcome === 'failed' ? 'throw new Error("workflow failed");' : 'return "done";'}
      `);
    if (engine === 'node' && outcome === 'failed') {
      await expect(execute([])).rejects.toThrow('workflow failed');
    } else {
      await execute([]);
    }
    const hookWrites = create.mock.calls
      .map(([, event]) => event)
      .filter(
        (event) =>
          event.eventType === 'hook_created' ||
          event.eventType === 'hook_disposed'
      );
    expect(
      hookWrites
        .filter((event) => event.eventData?.token === 'reused')
        .map((event) => event.eventType)
    ).toEqual(['hook_created', 'hook_disposed', 'hook_created']);
    expect(
      hookWrites
        .filter((event) => event.eventData?.token === 'other')
        .map((event) => event.eventType)
    ).toEqual(['hook_created']);
  });

  it.each([
    'completed',
    'failed',
  ] as const)('still propagates a final abort when the run %s', async (outcome) => {
    const { create, writeStream, execute } = await setup(`
      var controller = new AbortController();
      controller.abort('stop');
      ${outcome === 'failed' ? 'throw new Error("workflow failed");' : 'return "done";'}
    `);
    if (engine === 'node' && outcome === 'failed') {
      await expect(execute([])).rejects.toThrow('workflow failed');
    } else {
      await execute([]);
    }
    expect(create.mock.calls.map(([, event]) => event.eventType)).toEqual([
      'hook_created',
      'hook_received',
      ...(engine === 'quickjs' ? [`run_${outcome}`] : []),
    ]);
    expect(writeStream).toHaveBeenCalledOnce();
  });
});
