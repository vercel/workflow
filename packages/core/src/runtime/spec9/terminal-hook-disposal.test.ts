import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CreateEventRequest,
  Event,
  WorkflowRun,
  World,
} from '@workflow/world';
import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { ReplayPayloadCache } from '../../replay-payload-cache.js';
import {
  dehydrateRunError,
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../../serialization.js';
import { replayWorkflow, runWorkflow } from '../../workflow.js';
import { runQuickJSWorkflow } from '../quickjs-runtime.js';
import { setWorld } from '../world.js';
import { runWorkflowWithQuickJS } from './quickjs-entrypoint.js';
import { pendingQueueDrain } from './suspension-handler.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('../get-port-lazy.js', () => ({ getPortLazy: async () => 3000 }));

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
    const world = {
      specVersion: SPEC_VERSION_CURRENT,
      capabilities: {},
      events: {
        create,
        list: async () => ({ data: [], cursor: null, hasMore: false }),
      },
      streams: { write: writeStream },
      getEncryptionKeyForRun: async () => undefined,
    } as unknown as World;
    setWorld(world);

    const execute = (events: Event[]) =>
      engine === 'node'
        ? runWorkflow(
            workflowCode,
            workflowRun,
            events,
            undefined,
            undefined,
            pendingQueueDrain(world, (data, params) =>
              world.events.create(workflowRun.runId, data, params)
            )
          )
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

  it('skips an unused AbortController born in the final segment', async () => {
    const { create, execute } = await setup(`
      new AbortController();
      return "done";
    `);
    await execute([]);
    expect(create.mock.calls.map(([, event]) => event.eventType)).toEqual(
      engine === 'node' ? [] : ['run_completed']
    );
  });

  it('consumes legacy user and system hook disposals before termination', async () => {
    const { workflowCode, workflowRun, create, execute } = await setup(`
      var controller = new AbortController();
      var hook = createHook({ token: 'legacy' });
      await hook;
      hook.dispose();
      return "done";
    `);
    const first = await runQuickJSWorkflow({
      workflowCode,
      workflowId: 'workflow',
      workflowRun,
      events: [],
    });
    // Both engines use the same deterministic id generator.
    assert(first.suspended);
    const hooks = first.suspended.pendingOperations.filter(
      (op) => op.type === 'hook'
    );
    const events: Event[] = hooks.map((hook, index) => ({
      runId: workflowRun.runId,
      createdAt: workflowRun.createdAt,
      eventId: `evnt_created_${index}`,
      eventType: 'hook_created',
      correlationId: hook.correlationId,
      eventData: {
        token: hook.token,
        ...(hook.isSystem && { isSystem: true }),
      },
    }));
    events.unshift({
      runId: workflowRun.runId,
      createdAt: workflowRun.createdAt,
      eventId: 'evnt_run_created',
      eventType: 'run_created',
      eventData: { input: workflowRun.input },
    });
    const user = hooks.find((hook) => hook.token === 'legacy');
    assert(user);
    events.push({
      runId: workflowRun.runId,
      createdAt: workflowRun.createdAt,
      eventId: 'evnt_received',
      eventType: 'hook_received',
      correlationId: user.correlationId,
      eventData: {
        token: user.token,
        payload: await dehydrateStepReturnValue(
          'ready',
          workflowRun.runId,
          undefined
        ),
      },
    });
    events.push(
      ...hooks.map(
        (hook, index): Event => ({
          runId: workflowRun.runId,
          createdAt: workflowRun.createdAt,
          eventId: `evnt_disposed_${index}`,
          eventType: 'hook_disposed',
          correlationId: hook.correlationId,
          eventData: { token: hook.token },
        })
      )
    );
    await execute(events);
    expect(create.mock.calls.map(([, event]) => event.eventType)).toEqual(
      engine === 'node' ? [] : ['run_completed']
    );
  });

  it.each([
    { replayed: false, outcome: 'completed' },
    { replayed: true, outcome: 'completed' },
    { replayed: false, outcome: 'failed' },
    { replayed: true, outcome: 'failed' },
  ] as const)('releases a disposed retained token on $outcome (replayed: $replayed)', async ({
    replayed,
    outcome,
  }) => {
    const dir = await mkdtemp(join(tmpdir(), 'terminal-retained-hook-'));
    try {
      const world: World = createWorld({ dataDir: dir });
      setWorld(world);
      const input = await dehydrateWorkflowArguments([], 'run', undefined, []);
      const created = await world.events.create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_retention',
          workflowName: 'workflow',
          input,
        },
      });
      const initialRun = created.run;
      assert(initialRun);
      await world.events.create(initialRun.runId, {
        eventType: 'run_started',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {},
      });
      const run = await world.runs.get(initialRun.runId);
      const code = `
        var createHook = globalThis[Symbol.for('WORKFLOW_CREATE_HOOK')];
        async function workflow() {
          var hook = createHook({ token: 'retained', experimental_minRetention: 60000 });
          ${replayed ? 'await hook;' : ''}
          hook.dispose();
          ${outcome === 'failed' ? 'throw new Error("workflow failed");' : 'return "done";'}
        }
        globalThis.__private_workflows = new Map([['workflow', workflow]]);
      `;
      if (replayed) {
        const first = await runQuickJSWorkflow({
          workflowCode: code,
          workflowId: 'workflow',
          workflowRun: run,
          worldCapabilities: world.capabilities,
          events: [],
        });
        assert(first.suspended);
        const hook = first.suspended.pendingOperations.find(
          (op) => op.type === 'hook'
        );
        assert(hook);
        await world.events.create(run.runId, {
          eventType: 'hook_created',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.correlationId,
          eventData: {
            token: hook.token,
            tokenRetentionUntil: new Date(Date.now() + 60000),
          },
        });
        await world.events.create(run.runId, {
          eventType: 'hook_received',
          specVersion: SPEC_VERSION_CURRENT,
          correlationId: hook.correlationId,
          eventData: {
            token: hook.token,
            payload: await dehydrateStepReturnValue(
              'ready',
              run.runId,
              undefined
            ),
          },
        });
      }
      const { data: events } = await world.events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc', limit: 1000 },
      });
      if (engine === 'node') {
        const result = runWorkflow(
          code,
          run,
          events,
          undefined,
          undefined,
          pendingQueueDrain(world, (data, params) =>
            world.events.create(run.runId, data, params)
          ),
          world.capabilities
        );
        if (outcome === 'completed') {
          const output = (await result) as Uint8Array;
          await world.events.create(run.runId, {
            eventType: 'run_completed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: { output },
          });
        } else {
          await expect(result).rejects.toThrow('workflow failed');
          await world.events.create(run.runId, {
            eventType: 'run_failed',
            specVersion: SPEC_VERSION_CURRENT,
            eventData: {
              error: await dehydrateRunError(
                new Error('workflow failed'),
                run.runId
              ),
            },
          });
        }
      } else {
        await runWorkflowWithQuickJS({
          workflowCode: code,
          workflowName: 'workflow',
          workflowRun: run,
          preloadedEvents: events,
          preloadedEventsComplete: true,
        });
      }
      expect((await world.runs.get(run.runId)).status).toBe(outcome);
      const log = await world.events.list({
        runId: run.runId,
        pagination: { sortOrder: 'asc', limit: 1000 },
      });
      expect(
        log.data.filter((event) => event.eventType === 'hook_disposed')
      ).toHaveLength(1);
      // Use the real token index: a terminal event alone would leave a retained
      // token claimed, so this registration must succeed because of disposal.
      const next = await world.events.create(null, {
        eventType: 'run_created',
        specVersion: SPEC_VERSION_CURRENT,
        eventData: {
          deploymentId: 'dpl_retention',
          workflowName: 'workflow',
          input,
        },
      });
      assert(next.run);
      const claim = await world.events.create(next.run.runId, {
        eventType: 'hook_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'hook_reclaimed',
        eventData: { token: 'retained' },
      });
      expect(claim.event?.eventType).toBe('hook_created');
    } finally {
      setWorld(undefined);
      await rm(dir, { recursive: true, force: true });
    }
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
