/**
 * Pins that the QuickJS engine reports its log position on writes and feeds
 * the live VM from what the World hands back, the way the node:vm engine
 * merges the same pages into its replay log (see the "Who names a position"
 * table above `slotSnapshotParams` in helpers.ts).
 *
 * The QuickJS VM is mocked; the World is a real `@workflow/world-local`, which
 * numbers events by slot and implements both the skipped-slot report and the
 * inline delta, so what is under test is the engine's side of the exchange:
 * which writes name a position, and whether a page on the response reaches the
 * VM without an `events.list`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  eventIdToSlot,
  SPEC_VERSION_CURRENT,
  type World,
} from '@workflow/world';
import { createWorld } from '@workflow/world-local';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerStepFunction } from '../private.js';
import {
  dehydrateStepArguments,
  dehydrateStepReturnValue,
} from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

let counter = 0;

async function setupRun() {
  counter += 1;
  const dataDir = mkdtempSync(join(tmpdir(), 'wf-quickjs-slot-report-'));
  const world: World = createWorld({ dataDir, tag: `t${counter}` });
  setWorld(world);

  const runInput = await dehydrateStepArguments([], 'run', undefined);
  const created = await world.events.create(null, {
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {
      deploymentId: 'dpl_quickjs_slot_report',
      workflowName: 'workflow',
      input: runInput,
    },
  });
  const workflowRun = created.run!;
  await world.events.create(workflowRun.runId, {
    eventType: 'run_started',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: {},
  } as never);
  const loaded = await world.events.list({
    runId: workflowRun.runId,
    pagination: { sortOrder: 'asc', limit: 1000 },
  });

  const writes: Array<{
    request: CreateEventRequest;
    params: CreateEventParams | undefined;
  }> = [];
  /** World calls in order: `write:<eventType>` and `list`. */
  const sequence: string[] = [];
  const originalCreate = world.events.create.bind(world.events);
  world.events.create = (async (
    runId: string | null,
    request: CreateEventRequest,
    params?: CreateEventParams
  ) => {
    writes.push({ request, params });
    sequence.push(`write:${request.eventType}`);
    return originalCreate(runId, request, params);
  }) as World['events']['create'];
  const originalList = world.events.list.bind(world.events);
  const listSpy = vi.fn((...args: Parameters<World['events']['list']>) => {
    sequence.push('list');
    return originalList(...args);
  });
  world.events.list = listSpy as World['events']['list'];

  const fed: Event[][] = [];
  const completedResult = await dehydrateStepReturnValue(
    'done',
    workflowRun.runId,
    undefined
  );

  return {
    world,
    workflowRun,
    preload: { events: loaded.data, cursor: loaded.cursor },
    writes,
    sequence,
    listSpy,
    fed,
    completedResult,
  };
}

async function runEngine(setup: Awaited<ReturnType<typeof setupRun>>) {
  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName: 'workflow',
    workflowRun: setup.workflowRun,
    preloadedEvents: setup.preload.events,
    preloadedEventsComplete: true,
    preloadedCursor: setup.preload.cursor,
  });
}

const slotsOf = (events: readonly Event[]) =>
  events.map((e) => eventIdToSlot(e.eventId));

afterEach(() => {
  startQuickJSWorkflow.mockReset();
});

describe('QuickJS engine: log position on writes', () => {
  it('names the loaded position on a suspension write and lists for the event itself', async () => {
    const setup = await setupRun();
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    startQuickJSWorkflow.mockResolvedValue({
      result: {
        suspended: {
          pendingOperations: [
            {
              type: 'wait',
              correlationId: 'wait_1',
              resumeAt,
              hasCreatedEvent: false,
            },
          ],
        },
      },
      continueWithEvents: vi.fn(async (events: Event[]) => {
        setup.fed.push(events);
        return { completed: { result: setup.completedResult } };
      }),
      dispose: vi.fn(),
    });

    await runEngine(setup);

    const waitCreated = setup.writes.find(
      (w) => w.request.eventType === 'wait_created'
    );
    // The log held run_created and run_started, so the write says it stood
    // at position 2.
    expect(waitCreated?.params?.eventCount).toBe(2);

    // The VM got the wait_created (position 3) from a listing, not off the
    // write's response: a create response may carry the event with its
    // payload unresolved, so the created event is never fed from there. The
    // listing read forward from the preload's cursor rather than from the
    // top of the log.
    expect(setup.fed.map(slotsOf)).toEqual([[3]]);
    expect(setup.listSpy.mock.calls[0][0].pagination?.cursor).toBe(
      setup.preload.cursor
    );
    // No listing before the write: the preload was the whole log.
    expect(setup.sequence.indexOf('list')).toBeGreaterThan(
      setup.sequence.indexOf('write:wait_created')
    );

    // The run-terminal write names nothing: nothing replays the log after it.
    const runCompleted = setup.writes.find(
      (w) => w.request.eventType === 'run_completed'
    );
    expect(runCompleted).toBeDefined();
    expect(runCompleted?.params?.eventCount).toBeUndefined();
    expect(runCompleted?.params?.sinceCursor).toBeUndefined();
  });

  it('delivers the span a write skipped over ahead of the write, without a listing', async () => {
    const setup = await setupRun();
    const resumeAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    startQuickJSWorkflow.mockImplementation(async () => {
      // Another writer appends to the log after this invocation loaded it
      // and before it writes: the shape of a concurrent replay or an
      // out-of-band hook delivery.
      await setup.world.events.create(setup.workflowRun.runId, {
        eventType: 'wait_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: 'wait_foreign',
        eventData: { resumeAt: new Date(resumeAt) },
      });
      return {
        result: {
          suspended: {
            pendingOperations: [
              {
                type: 'wait',
                correlationId: 'wait_1',
                resumeAt,
                hasCreatedEvent: false,
              },
            ],
          },
        },
        continueWithEvents: vi.fn(async (events: Event[]) => {
          setup.fed.push(events);
          // Suspend again until the VM has been given the wait it asked for.
          const sawOwnWait = setup.fed
            .flat()
            .some((e) => e.correlationId === 'wait_1');
          return sawOwnWait
            ? { completed: { result: setup.completedResult } }
            : {
                suspended: {
                  pendingOperations: [
                    {
                      type: 'wait',
                      correlationId: 'wait_1',
                      resumeAt,
                      hasCreatedEvent: true,
                    },
                  ],
                },
              };
        }),
        dispose: vi.fn(),
      };
    });

    await runEngine(setup);

    const waitCreated = setup.writes.find(
      (w) =>
        w.request.eventType === 'wait_created' &&
        w.request.correlationId === 'wait_1'
    );
    // Still names position 2: the foreign write at 3 was not in its view.
    expect(waitCreated?.params?.eventCount).toBe(2);
    // The write landed at 4 and the World reported 3 back. The foreign event
    // is fed off the response, ahead of anything else; the write itself
    // (which this World's report excludes) follows from a listing. The VM
    // saw them in position order.
    expect(setup.fed.map(slotsOf)).toEqual([[3], [4]]);
    // The foreign event was fed before any listing ran.
    expect(setup.sequence.indexOf('write:wait_created')).toBeLessThan(
      setup.sequence.indexOf('list')
    );
    expect(setup.listSpy.mock.calls[0][0].pagination?.cursor).toBe(
      setup.preload.cursor
    );
  });

  it('asks a single inline step for the inline delta and feeds the VM from it', async () => {
    const setup = await setupRun();
    const stepName = `step//./quickjs-slot-report//inline${counter}`;
    registerStepFunction(stepName, async () => 'ok');
    const stepInput = await dehydrateStepArguments(
      { args: [], closureVars: undefined, thisVal: undefined },
      setup.workflowRun.runId,
      undefined
    );
    startQuickJSWorkflow.mockResolvedValue({
      result: {
        suspended: {
          pendingOperations: [
            {
              type: 'step',
              correlationId: 'step_1',
              stepId: stepName,
              input: stepInput,
              hasCreatedEvent: false,
            },
          ],
        },
      },
      continueWithEvents: vi.fn(async (events: Event[]) => {
        setup.fed.push(events);
        return { completed: { result: setup.completedResult } };
      }),
      dispose: vi.fn(),
    });

    await runEngine(setup);

    const stepCompleted = setup.writes.find(
      (w) => w.request.eventType === 'step_completed'
    );
    // The terminal write asked for everything after the cursor the engine
    // held (the preload's), and named no position: the executor holds no
    // log, so the page it gets is the delta, not a report.
    expect(stepCompleted?.params?.sinceCursor).toBe(setup.preload.cursor);
    expect(stepCompleted?.params?.eventCount).toBeUndefined();
    const stepStarted = setup.writes.find(
      (w) => w.request.eventType === 'step_started'
    );
    expect(stepStarted?.params?.eventCount).toBeUndefined();

    // The lazy claim (which this World materializes as step_created +
    // step_started, positions 3 and 4) and the terminal at 5 all reached the
    // VM off the terminal write's response; no listing ran.
    expect(setup.fed.map(slotsOf)).toEqual([[3, 4, 5]]);
    expect(setup.fed[0].map((e) => e.eventType)).toEqual([
      'step_created',
      'step_started',
      'step_completed',
    ]);
    // The one listing is the loop's probe for cheap progress before it runs
    // a step body, which found nothing. After the terminal write, the delta
    // carried the log forward and nothing was listed.
    const afterTerminal = setup.sequence.slice(
      setup.sequence.indexOf('write:step_completed') + 1
    );
    expect(setup.listSpy).toHaveBeenCalledTimes(1);
    expect(afterTerminal).not.toContain('list');
  });
});
