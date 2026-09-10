/**
 * Pins the QuickJS engine's event-log sourcing for the lazy hook resume
 * fast path: a caller-attested complete preload (`preloadedEventsComplete`)
 * is trusted as the full log — no `events.list` — while a non-attested
 * hook-containing preload is NOT trusted (the first-invocation heuristic
 * only recognizes run_created/run_started-only preloads) and the engine
 * fetches the log itself. Also pins the non-empty guard on the attestation.
 *
 * The QuickJS VM itself is mocked (its WASM import chain is irrelevant to
 * the sourcing decision): `startQuickJSWorkflow` records which events the
 * engine handed it and completes immediately.
 */
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dehydrateStepReturnValue } from '../serialization.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const startQuickJSWorkflow = vi.fn();
vi.mock('./quickjs-runtime.js', () => ({
  startQuickJSWorkflow: (...args: unknown[]) => startQuickJSWorkflow(...args),
}));

async function runQuickJSScenario(options: {
  preloadedEvents?: Event[];
  preloadedEventsComplete?: boolean;
}) {
  const runId = 'wrun_quickjs_preload';
  const workflowName = 'workflow';
  const startedAt = new Date('2026-05-19T12:00:00.000Z');

  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: [],
    deploymentId: 'dpl_quickjs_preload',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  const durableEvents = options.preloadedEvents ?? [];

  const createdEvents: CreateEventRequest[] = [];
  let listCallCount = 0;
  const listEvents = vi.fn(async () => {
    // Model real pagination: the full log on the first page, then an empty
    // terminal page (a fake that always returns rows would loop the
    // engine's fetch-all forever).
    listCallCount++;
    if (listCallCount === 1) {
      return {
        data: [...durableEvents],
        cursor: durableEvents.at(-1)?.eventId ?? null,
        hasMore: false,
      };
    }
    return { data: [], cursor: null, hasMore: false };
  });
  const createEvent = vi.fn(
    async (_runId: string, request: CreateEventRequest) => {
      createdEvents.push(request);
      return { event: { ...request, runId, eventId: 'evnt_created' } };
    }
  );

  setWorld({
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: { list: listEvents, create: createEvent },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_quickjs' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World);

  const completedResult = await dehydrateStepReturnValue(
    'done',
    runId,
    undefined
  );
  startQuickJSWorkflow.mockResolvedValue({
    result: { completed: { result: completedResult } },
    continueWithEvents: vi.fn(),
    dispose: vi.fn(),
  });

  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  await runWorkflowWithQuickJS({
    workflowCode: '// not evaluated: the VM is mocked',
    workflowName,
    workflowRun,
    preloadedEvents: options.preloadedEvents,
    preloadedEventsComplete: options.preloadedEventsComplete,
  });

  expect(startQuickJSWorkflow).toHaveBeenCalledTimes(1);
  const vmEvents = (
    startQuickJSWorkflow.mock.calls[0][0] as { events: Event[] }
  ).events;

  return { listEvents, createdEvents, vmEvents };
}

function makeHookResumeLog(runId: string): Event[] {
  const hostUlid = monotonicFactory();
  const startedAt = new Date('2026-05-19T12:00:00.000Z');
  let eventIndex = 0;
  const event = (data: Record<string, unknown>): Event => {
    const t = +startedAt + ++eventIndex * 100;
    return {
      specVersion: SPEC_VERSION_CURRENT,
      ...data,
      runId,
      eventId: `evnt_${hostUlid(t)}`,
      createdAt: new Date(t),
    } as Event;
  };
  return [
    event({
      eventType: 'run_created',
      eventData: {
        deploymentId: 'dpl_quickjs_preload',
        workflowName: 'workflow',
        input: [],
      },
    }),
    event({ eventType: 'run_started' }),
    event({
      eventType: 'hook_created',
      correlationId: 'hook_1',
      eventData: { token: 'tok-quickjs' },
    }),
    event({
      eventType: 'hook_received',
      correlationId: 'hook_1',
      resumeId: 'resume-quickjs-1',
      eventData: { token: 'tok-quickjs', payload: new Uint8Array() },
    }),
  ];
}

describe('QuickJS lazy hook preload sourcing', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('trusts an attested complete preload: no events.list, VM gets the provided log', async () => {
    const log = makeHookResumeLog('wrun_quickjs_preload');
    const { listEvents, createdEvents, vmEvents } = await runQuickJSScenario({
      preloadedEvents: log,
      preloadedEventsComplete: true,
    });

    expect(listEvents).not.toHaveBeenCalled();
    expect(vmEvents.map((e) => e.eventId)).toEqual(log.map((e) => e.eventId));
    // The engine never posts run_started itself; the only write on this
    // invocation is the completion.
    expect(createdEvents.map((e) => e.eventType)).toEqual(['run_completed']);
  });

  it('does not trust a hook-containing preload without the attestation: fetches via events.list', async () => {
    const log = makeHookResumeLog('wrun_quickjs_preload');
    const { listEvents, vmEvents } = await runQuickJSScenario({
      preloadedEvents: log,
      preloadedEventsComplete: false,
    });

    // The first-invocation heuristic rejects a log with hook events, so the
    // engine fetched the authoritative log itself...
    expect(listEvents).toHaveBeenCalled();
    // ...and replayed what the fetch returned.
    expect(vmEvents.map((e) => e.eventId)).toEqual(log.map((e) => e.eventId));
  });

  it('does not trust an attested but empty preload: fetches via events.list', async () => {
    const { listEvents } = await runQuickJSScenario({
      preloadedEvents: [],
      preloadedEventsComplete: true,
    });

    expect(listEvents).toHaveBeenCalled();
  });
});
