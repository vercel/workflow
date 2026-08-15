import { EntityConflictError, RUN_ERROR_CODES } from '@workflow/errors';
import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { monotonicFactory } from 'ulid';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import { createContext } from '../vm/index.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const startedAt = new Date('2026-05-19T12:00:00.000Z');
// 20s after the run started: past a `sleep("5s")`'s resumeAt by 15s, before a
// `sleep("60s")`'s.
const fixedNow = new Date('2026-05-19T12:00:20.000Z');

function getWorkflowTransformCode(workflowName: string) {
  return `;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, ${workflowName}]]);`;
}

/**
 * Drives the real workflow queue handler with a fake World that models a
 * wedged wait: the wait event write conflicts (409) while the event log never
 * produces the row the conflict attests to.
 */
async function runWaitWedgeScenario(options: {
  /** Which wait write conflicts. */
  wedge: 'wait_completed' | 'wait_created';
  /** Sleep duration in the workflow (controls resumeAt). */
  sleepDuration: string;
  /**
   * The conflicting row IS durably in the log (the benign concurrent-winner
   * race), so the post-conflict read finds it. For `wait_completed` the row
   * is durable from the start (just absent from the stale preload); for
   * `wait_created` it lands at the moment the create conflicts, modeling the
   * winner's write racing this handler's snapshot.
   */
  rowReadableAfterConflict?: boolean;
}) {
  vi.spyOn(Date, 'now').mockReturnValue(+fixedNow);

  const runId = 'wrun_wait_wedge';
  const workflowName = 'workflow';
  const deploymentId = 'dpl_wait_wedge';
  const workflowArgs = await dehydrateWorkflowArguments([], runId, undefined);

  const { globalThis: vmGlobalThis } = createContext({
    seed: `${runId}:${workflowName}:${deploymentId}`,
    fixedTimestamp: +startedAt,
  });
  const ulid = monotonicFactory(() => vmGlobalThis.Math.random());
  // The sleep is the workflow's first (only) id consumer.
  const waitCorrelationId = `wait_${ulid(+startedAt)}`;

  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: workflowArgs,
    deploymentId,
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  let eventIndex = 0;
  const event = (data: CreateEventRequest): Event =>
    ({
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(++eventIndex),
      createdAt: new Date(+startedAt + eventIndex * 100),
    }) as Event;

  const sleepMs =
    Number.parseInt(options.sleepDuration, 10) *
    (options.sleepDuration.endsWith('s') ? 1000 : 1);
  const resumeAt = new Date(+startedAt + sleepMs);

  const durableEvents: Event[] = [
    event({
      eventType: 'run_created',
      specVersion: SPEC_VERSION_CURRENT,
      eventData: { deploymentId, workflowName, input: workflowArgs },
    }),
    event({ eventType: 'run_started', specVersion: SPEC_VERSION_CURRENT }),
  ];
  if (options.wedge === 'wait_completed') {
    // The wait exists in the log; only its completion is wedged (or raced).
    durableEvents.push(
      event({
        eventType: 'wait_created',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: waitCorrelationId,
        eventData: { resumeAt },
      })
    );
  }
  // The stale snapshot the handler starts from (never contains a completion).
  const preloadedEvents = [...durableEvents];
  if (options.wedge === 'wait_completed' && options.rowReadableAfterConflict) {
    // A concurrent handler's completion is durable, just not in the preload.
    durableEvents.push(
      event({
        eventType: 'wait_completed',
        specVersion: SPEC_VERSION_CURRENT,
        correlationId: waitCorrelationId,
        eventData: { resumeAt },
      })
    );
  }

  const createdEvents: Event[] = [];

  const eventsAfterCursor = (cursor?: string): Event[] => {
    if (!cursor) return [...durableEvents];
    const index = durableEvents.findIndex((e) => e.eventId === cursor);
    return index >= 0 ? durableEvents.slice(index + 1) : [...durableEvents];
  };

  const listEvents = vi.fn(
    async (params: { pagination?: { cursor?: string } }) => {
      const data = eventsAfterCursor(params.pagination?.cursor);
      return {
        data,
        hasMore: false,
        cursor: data.at(-1)?.eventId ?? params.pagination?.cursor ?? null,
      };
    }
  );

  const createEvent = vi.fn(
    async (_runId: string, request: CreateEventRequest) => {
      if (request.eventType === 'run_started') {
        // Legacy shape (no cursor): the handler falls back to full reloads.
        return { run: workflowRun, events: preloadedEvents };
      }
      if (request.eventType === options.wedge) {
        if (
          options.wedge === 'wait_created' &&
          options.rowReadableAfterConflict &&
          !durableEvents.some(
            (e) =>
              e.eventType === 'wait_created' &&
              e.correlationId === request.correlationId
          )
        ) {
          // The concurrent winner's row lands durably just as this handler's
          // create conflicts — the fresh verification read must find it.
          durableEvents.push(
            event({
              eventType: 'wait_created',
              specVersion: SPEC_VERSION_CURRENT,
              correlationId: request.correlationId,
              eventData: request.eventData,
            })
          );
        }
        throw new EntityConflictError(
          `${options.wedge} already exists for ${request.correlationId}`
        );
      }
      const created = event(request);
      durableEvents.push(created);
      createdEvents.push(created);
      return { event: created };
    }
  );

  const queue = vi.fn().mockResolvedValue({ messageId: 'msg_continuation' });
  let capturedHandler:
    | ((
        message: unknown,
        metadata: { queueName: string; messageId: string; attempt: number }
      ) => Promise<unknown>)
    | undefined;
  const fakeWorld = {
    specVersion: SPEC_VERSION_CURRENT,
    createQueueHandler: vi.fn((_prefix, handler) => {
      capturedHandler = handler;
      return vi.fn();
    }),
    events: { list: listEvents, create: createEvent },
    queue,
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;

  setWorld(fakeWorld);

  const workflowCode = `
    const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];

    async function workflow() {
      await sleep(${JSON.stringify(options.sleepDuration)});
      return "done";
    }

    ${getWorkflowTransformCode(workflowName)}
  `;

  const handler = workflowEntrypoint(workflowCode);
  await handler(new Request('http://localhost', { method: 'POST' }));
  expect(capturedHandler).toBeDefined();

  await capturedHandler?.(
    { runId },
    {
      queueName: `__wkf_workflow_${workflowName}`,
      messageId: 'msg_workflow',
      attempt: 1,
    }
  );

  return { createdEvents, queue, waitCorrelationId };
}

const wedgeWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter((call) =>
    String(call[0]).includes('suspecting a wedged wait')
  );

const runFailedEvents = (createdEvents: Event[]) =>
  createdEvents.filter((e) => e.eventType === 'run_failed');

describe('wait wedge detection', () => {
  afterEach(() => {
    setWorld(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('wait_completed conflicts', () => {
    it('stays silent when the conflicting completion is readable after reload', async () => {
      const warn = vi.spyOn(console, 'warn');
      const result = await runWaitWedgeScenario({
        wedge: 'wait_completed',
        sleepDuration: '5s',
        rowReadableAfterConflict: true,
      });

      // The benign race: replay observes the winner's completion and the
      // workflow runs to completion.
      expect(result.createdEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ eventType: 'run_completed' }),
        ])
      );
      expect(runFailedEvents(result.createdEvents)).toEqual([]);
      expect(wedgeWarnings(warn)).toEqual([]);
    });

    it('warns but keeps retrying inside the escalation threshold', async () => {
      const warn = vi.spyOn(console, 'warn');
      const result = await runWaitWedgeScenario({
        wedge: 'wait_completed',
        sleepDuration: '5s', // 15s past resumeAt, default threshold 600s
      });

      expect(wedgeWarnings(warn).length).toBeGreaterThan(0);
      expect(runFailedEvents(result.createdEvents)).toEqual([]);
      // The run keeps going: the replay suspends on the sleep again and arms
      // a wake continuation instead of failing.
      expect(result.queue).toHaveBeenCalled();
    });

    it('fails the run as CORRUPTED_EVENT_LOG past the threshold', async () => {
      vi.stubEnv('WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS', '10');
      const result = await runWaitWedgeScenario({
        wedge: 'wait_completed',
        sleepDuration: '5s', // 15s past resumeAt > 10s threshold
      });

      const failed = runFailedEvents(result.createdEvents);
      expect(failed).toHaveLength(1);
      expect(failed[0]?.eventData).toEqual(
        expect.objectContaining({
          errorCode: RUN_ERROR_CODES.CORRUPTED_EVENT_LOG,
        })
      );
    });
  });

  describe('wait_created conflicts', () => {
    // This site is WARN-ONLY. The ULID inside a wait's correlation id is
    // minted from the workflow VM's fixed timestamp — the RUN's creation
    // epoch, a run-wide constant kept stable for replay — so it says nothing
    // about when the individual wait was scheduled and cannot anchor a
    // per-wait escalation (and an uncreated wait's resumeAt is recomputed
    // from the live clock on every replay, so it cannot either). The run
    // epoch works only as a cheap pre-filter: conflicts in runs younger than
    // the threshold skip the verification read entirely; in older runs a
    // fresh log read gates the warning. Here the id is ~20s old at fixedNow,
    // which the scenarios below tune the threshold around.

    it('stays silent inside the threshold (concurrent-suspension race)', async () => {
      const warn = vi.spyOn(console, 'warn');
      const result = await runWaitWedgeScenario({
        wedge: 'wait_created',
        sleepDuration: '5s', // id is ~20s old, default threshold 600s
      });

      expect(wedgeWarnings(warn)).toEqual([]);
      expect(runFailedEvents(result.createdEvents)).toEqual([]);
      // Suspension proceeds normally and arms the wait continuation.
      expect(result.queue).toHaveBeenCalled();
    });

    it('stays silent when the verification read finds the concurrent winner’s row', async () => {
      const warn = vi.spyOn(console, 'warn');
      vi.stubEnv('WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS', '1');
      const result = await runWaitWedgeScenario({
        wedge: 'wait_created',
        sleepDuration: '5s', // id ~20s old > 1s threshold → verification runs
        rowReadableAfterConflict: true,
      });

      expect(wedgeWarnings(warn)).toEqual([]);
      expect(runFailedEvents(result.createdEvents)).toEqual([]);
      expect(result.queue).toHaveBeenCalled();
    });

    it('warns — but never fails the run — when no row is readable in an old run', async () => {
      const warn = vi.spyOn(console, 'warn');
      vi.stubEnv('WORKFLOW_WAIT_WEDGE_FAIL_AFTER_SECONDS', '10');
      const result = await runWaitWedgeScenario({
        wedge: 'wait_created',
        sleepDuration: '5s', // id ~20s old > 10s threshold, row unreadable
      });

      // Warn-only: the run-epoch anchor cannot distinguish a stale wedge
      // from a benign race in an old run, so escalation is the backend's
      // job. The run keeps its normal suspension behavior (continuation
      // armed, no terminal event).
      expect(wedgeWarnings(warn).length).toBeGreaterThan(0);
      expect(runFailedEvents(result.createdEvents)).toEqual([]);
      expect(result.queue).toHaveBeenCalled();
    });
  });
});
