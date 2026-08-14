import { PreconditionFailedError, WorkflowWorldError } from '@workflow/errors';
import type { Event, World } from '@workflow/world';
import { slotToEventId } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64, deriveRunKeyPair, seal } from '../sealed-box.js';
import {
  decrypt,
  encodeWithFormatPrefix,
  encrypt,
  peekFormatPrefix,
  SerializationFormat,
} from '../serialization.js';
import {
  appendUniqueEvents,
  findEventSlotGap,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  healthCheck,
  insertEventByEventId,
  loadWorkflowRunEvents,
  maxEventSlot,
  memoizeEncryptionKey,
  mergeReportedEvents,
  preconditionEventDelta,
  SLOT_GAP_RECHECK_ATTEMPTS,
  settleEventSlotGap,
  slotSnapshotParams,
} from './helpers.js';

// Mock the logger to suppress output during tests
vi.mock('../logger.js', () => ({
  runtimeLogger: {
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

const eventsListMock = vi.fn();

vi.mock('./get-world-lazy.js', () => ({
  getWorldLazy: vi.fn(async () => ({
    events: {
      list: eventsListMock,
    },
  })),
}));

const makeEvent = (eventId: string): Event =>
  ({
    eventId,
    runId: 'wrun_mockidnumber0001',
    eventType: 'step_created',
    correlationId: 'step_mock',
    createdAt: new Date(),
  }) as unknown as Event;

describe('insertEventByEventId', () => {
  it('keeps ascending eventId order when splicing a late-committing earlier event', () => {
    // The lazy-resume consumer may splice a hook_received whose eventId sorts
    // BEFORE events already in the ascending-loaded preload. A plain push would
    // corrupt replay order; insertEventByEventId must place it correctly.
    const events = [makeEvent('evnt_a'), makeEvent('evnt_c')];
    insertEventByEventId(events, makeEvent('evnt_b'));
    expect(events.map((e) => e.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
      'evnt_c',
    ]);
  });

  it('appends an event that sorts at the tail (the common case)', () => {
    const events = [makeEvent('evnt_a'), makeEvent('evnt_b')];
    insertEventByEventId(events, makeEvent('evnt_c'));
    expect(events.map((e) => e.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
      'evnt_c',
    ]);
  });

  it('inserts at the head when the event sorts before everything', () => {
    const events = [makeEvent('evnt_b'), makeEvent('evnt_c')];
    insertEventByEventId(events, makeEvent('evnt_a'));
    expect(events.map((e) => e.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
      'evnt_c',
    ]);
  });

  it('is idempotent when the eventId is already present', () => {
    const events = [makeEvent('evnt_a'), makeEvent('evnt_b')];
    insertEventByEventId(events, makeEvent('evnt_b'));
    expect(events.map((e) => e.eventId)).toEqual(['evnt_a', 'evnt_b']);
  });

  it('inserts into an empty log', () => {
    const events: Event[] = [];
    insertEventByEventId(events, makeEvent('evnt_a'));
    expect(events.map((e) => e.eventId)).toEqual(['evnt_a']);
  });
});

describe('getWorkflowQueueName', () => {
  it('should return a valid queue name for a simple workflow name', () => {
    expect(getWorkflowQueueName('myWorkflow')).toBe(
      '__wkf_workflow_myWorkflow'
    );
  });

  it('should allow alphanumeric characters', () => {
    expect(getWorkflowQueueName('workflow123')).toBe(
      '__wkf_workflow_workflow123'
    );
  });

  it('should allow underscores and hyphens', () => {
    expect(getWorkflowQueueName('my_workflow-name')).toBe(
      '__wkf_workflow_my_workflow-name'
    );
  });

  it('should allow dots', () => {
    expect(getWorkflowQueueName('my.workflow')).toBe(
      '__wkf_workflow_my.workflow'
    );
  });

  it('should allow forward slashes', () => {
    expect(getWorkflowQueueName('workflow//module//fn')).toBe(
      '__wkf_workflow_workflow//module//fn'
    );
  });

  it('should allow at signs for scoped package names', () => {
    expect(
      getWorkflowQueueName('workflow//@internal/agent@0.0.0//myWorkflow')
    ).toBe('__wkf_workflow_workflow//@internal/agent@0.0.0//myWorkflow');
  });

  it('should allow scoped packages with subpath exports', () => {
    expect(
      getWorkflowQueueName(
        'workflow//@scope/package/subpath@1.2.3//handleRequest'
      )
    ).toBe(
      '__wkf_workflow_workflow//@scope/package/subpath@1.2.3//handleRequest'
    );
  });

  it('should throw for names containing spaces', () => {
    expect(() => getWorkflowQueueName('my workflow')).toThrow(
      'Invalid workflow name'
    );
  });

  it('should throw for names containing special characters', () => {
    expect(() => getWorkflowQueueName('workflow$name')).toThrow(
      'Invalid workflow name'
    );
    expect(() => getWorkflowQueueName('workflow#name')).toThrow(
      'Invalid workflow name'
    );
    expect(() => getWorkflowQueueName('workflow!name')).toThrow(
      'Invalid workflow name'
    );
  });

  it('should throw for empty string', () => {
    expect(() => getWorkflowQueueName('')).toThrow('Invalid workflow name');
  });

  it('should use default prefix when no namespace is provided', () => {
    expect(getWorkflowQueueName('myFlow')).toBe('__wkf_workflow_myFlow');
    expect(getWorkflowQueueName('myFlow', undefined)).toBe(
      '__wkf_workflow_myFlow'
    );
  });

  it('should use namespaced prefix when namespace is provided', () => {
    expect(getWorkflowQueueName('myFlow', 'custom')).toBe(
      '__custom_wkf_workflow_myFlow'
    );
  });

  it('should reject invalid namespace in queue name construction', () => {
    expect(() => getWorkflowQueueName('myFlow', '123bad')).toThrow();
  });
});

describe('healthCheck response parsing', () => {
  /**
   * Builds a minimal `World` whose `streams.get(...)` returns a stream of
   * the supplied response text, simulating what the responding deployment
   * would write via `handleHealthCheckMessage`. Just enough surface for
   * `healthCheck()` to exercise its parse path.
   */
  function makeWorldWithResponse(responseText: string): World {
    return {
      queue: vi.fn().mockResolvedValue(undefined),
      streams: {
        get: vi.fn(async () => {
          let delivered = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!delivered) {
                controller.enqueue(new TextEncoder().encode(responseText));
                delivered = true;
              } else {
                controller.close();
              }
            },
          });
        }),
      },
    } as unknown as World;
  }

  it('surfaces workflowCoreVersion when present in the response', async () => {
    const world = makeWorldWithResponse(
      JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 3,
        workflowCoreVersion: '5.0.0-beta.7',
        timestamp: Date.now(),
      })
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.specVersion).toBe(3);
    expect(result.workflowCoreVersion).toBe('5.0.0-beta.7');
  });

  it('omits workflowCoreVersion when the response does not include the field', async () => {
    // Independent of specVersion — the field is omitted by any responder
    // running an older `@workflow/core` that predates the addition of
    // `workflowCoreVersion` to the health response payload.
    const world = makeWorldWithResponse(
      JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 3,
        // No workflowCoreVersion field
        timestamp: Date.now(),
      })
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.specVersion).toBe(3);
    expect(result.workflowCoreVersion).toBeUndefined();
  });

  it('omits workflowCoreVersion when the field is the wrong type', async () => {
    // Defensive: the parser only accepts strings. Anything else is dropped
    // rather than surfaced as garbage.
    const world = makeWorldWithResponse(
      JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 3,
        workflowCoreVersion: 12345,
        timestamp: Date.now(),
      })
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.workflowCoreVersion).toBeUndefined();
  });

  it('surfaces hookResumeInputVersion from the target so the caller stamps the consumer value', async () => {
    // Blocker 1: the marker must reflect the TARGET deployment (the queue
    // consumer that re-ensures the event), not the caller. The responder
    // stamps its own `HOOK_RESUME_INPUT_VERSION`; the parser passes it through
    // so a cross-deployment start records the consumer's real capability.
    const world = makeWorldWithResponse(
      JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 3,
        hookResumeInputVersion: 1,
        timestamp: Date.now(),
      })
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.hookResumeInputVersion).toBe(1);
  });

  it('omits hookResumeInputVersion for an older target that does not attest it', async () => {
    // An older target deployment predates the marker in the health response.
    // The field is absent, and the caller must fail closed (stamp nothing) so
    // the cross-deployment resume stays sequential.
    const world = makeWorldWithResponse(
      JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 3,
        // No hookResumeInputVersion field
        timestamp: Date.now(),
      })
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.hookResumeInputVersion).toBeUndefined();
  });

  it('omits hookResumeInputVersion when the field is the wrong type', async () => {
    // Defensive: only a number is accepted; anything else is dropped rather
    // than surfaced as a bogus capability.
    const world = makeWorldWithResponse(
      JSON.stringify({
        healthy: true,
        endpoint: 'workflow',
        specVersion: 3,
        hookResumeInputVersion: 'yes',
        timestamp: Date.now(),
      })
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.hookResumeInputVersion).toBeUndefined();
  });

  it('returns healthy with no fields for non-JSON plain-text responses', async () => {
    // Some deployments respond with plain text like
    // 'Workflow SDK "..." endpoint is healthy'. The parser treats any
    // non-empty non-JSON text as healthy, with no version metadata.
    const world = makeWorldWithResponse(
      'Workflow SDK "workflow" endpoint is healthy'
    );

    const result = await healthCheck(world, { timeout: 1000 });

    expect(result.healthy).toBe(true);
    expect(result.specVersion).toBeUndefined();
    expect(result.workflowCoreVersion).toBeUndefined();
  });

  it('publishes to the default health-check topic when no namespace is given', async () => {
    const world = makeWorldWithResponse(
      JSON.stringify({ healthy: true, endpoint: 'workflow' })
    );

    await healthCheck(world, { timeout: 1000 });

    expect(world.queue).toHaveBeenCalledWith(
      '__wkf_workflow_health_check',
      expect.anything(),
      expect.anything()
    );
  });

  it('publishes to the namespaced health-check topic when a namespace is given', async () => {
    const world = makeWorldWithResponse(
      JSON.stringify({ healthy: true, endpoint: 'workflow' })
    );

    const result = await healthCheck(world, {
      timeout: 1000,
      namespace: 'eve',
    });

    expect(result.healthy).toBe(true);
    expect(world.queue).toHaveBeenCalledWith(
      '__eve_wkf_workflow_health_check',
      expect.anything(),
      expect.anything()
    );
  });

  it('returns unhealthy within the timeout when streams.get never resolves', async () => {
    // Regression test: some worlds hold the stream GET open until data is
    // written (workflow-server holds unwritten streams for ~2 minutes).
    // The timeout must bound that call too, not just the poll loop.
    const world = {
      queue: vi.fn().mockResolvedValue(undefined),
      streams: {
        get: vi.fn(() => new Promise<never>(() => {})),
      },
    } as unknown as World;

    const result = await healthCheck(world, { timeout: 300 });

    expect(result.healthy).toBe(false);
    expect(result.error).toMatch(/timed out/);
  });
});

describe('loadWorkflowRunEvents', () => {
  beforeEach(() => {
    eventsListMock.mockReset();
  });

  it('returns the cursor from the last page when pagination terminates normally', async () => {
    const page1 = [makeEvent('evnt_a'), makeEvent('evnt_b')];
    eventsListMock.mockResolvedValueOnce({
      data: page1,
      cursor: 'eid:evnt_b',
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({ runId: 'wrun_test' });

    expect(result.events).toHaveLength(2);
    expect(result.cursor).toBe('eid:evnt_b');
    expect(eventsListMock).toHaveBeenCalledTimes(1);
    expect(eventsListMock).toHaveBeenCalledWith({
      runId: 'wrun_test',
      pagination: { sortOrder: 'asc', cursor: undefined },
    });
  });

  // Regression test for the "Event cursor missing after initial load" warning.
  //
  // A World may legitimately return `{ data: [], cursor: null, hasMore: false }`
  // on a trailing empty page — workflow-server does this whenever the previous
  // page's DynamoDB query hit `Limit` exactly and DynamoDB returned a
  // `LastEvaluatedKey` "just in case." If the pagination loop overwrites the
  // cursor with `null` on that trailing page, the runtime's incremental-load
  // path can't proceed and falls back to a full reload on every replay
  // iteration, logging "Event cursor missing after initial load" each time.
  it('preserves the cursor from the previous page when the final page is empty', async () => {
    const page1 = [makeEvent('evnt_a'), makeEvent('evnt_b')];
    eventsListMock.mockResolvedValueOnce({
      data: page1,
      cursor: 'eid:evnt_b',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({ runId: 'wrun_test' });

    expect(result.events).toHaveLength(2);
    expect(result.cursor).toBe('eid:evnt_b');
    expect(eventsListMock).toHaveBeenCalledTimes(2);
  });

  it('returns null cursor only when no events exist at all', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({ runId: 'wrun_test' });

    expect(result.events).toHaveLength(0);
    expect(result.cursor).toBeNull();
  });

  it('uses the latest cursor when paginating through multiple non-empty pages', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a')],
      cursor: 'eid:evnt_a',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_b')],
      cursor: 'eid:evnt_b',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_c')],
      cursor: 'eid:evnt_c',
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({ runId: 'wrun_test' });

    expect(result.events.map((e) => e.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
      'evnt_c',
    ]);
    expect(result.cursor).toBe('eid:evnt_c');
  });

  it('falls back to the afterCursor when an incremental load returns no events', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [],
      cursor: null,
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({
      runId: 'wrun_test',
      afterCursor: 'eid:evnt_z',
    });

    expect(result.events).toHaveLength(0);
    // Preserving the input cursor avoids the runtime treating "no new events
    // since last poll" as "I have no idea where I am in the log."
    expect(result.cursor).toBe('eid:evnt_z');
  });

  it('deduplicates overlapping pages from a restarted continuation read', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a'), makeEvent('evnt_b')],
      cursor: 'eid:evnt_b',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_b'), makeEvent('evnt_c')],
      cursor: 'eid:evnt_c',
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({ runId: 'wrun_test' });

    expect(result.events.map((event) => event.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
      'evnt_c',
    ]);
  });

  it('retries a rejected continuation cursor as a full load once', async () => {
    eventsListMock.mockRejectedValueOnce(
      new WorkflowWorldError('invalid cursor', { status: 400 })
    );
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a'), makeEvent('evnt_b')],
      cursor: 'eid:evnt_b',
      hasMore: false,
    });

    const result = await loadWorkflowRunEvents({
      runId: 'wrun_test',
      afterCursor: 'opaque-cursor',
    });

    expect(result.events.map((event) => event.eventId)).toEqual([
      'evnt_a',
      'evnt_b',
    ]);
    expect(eventsListMock).toHaveBeenNthCalledWith(1, {
      runId: 'wrun_test',
      pagination: { sortOrder: 'asc', cursor: 'opaque-cursor' },
    });
    expect(eventsListMock).toHaveBeenNthCalledWith(2, {
      runId: 'wrun_test',
      pagination: { sortOrder: 'asc', cursor: undefined },
    });
  });

  it('fails instead of looping when pagination repeats a cursor', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a')],
      cursor: 'eid:evnt_a',
      hasMore: true,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a')],
      cursor: 'eid:evnt_a',
      hasMore: true,
    });

    await expect(
      loadWorkflowRunEvents({ runId: 'wrun_test' })
    ).rejects.toMatchObject({
      code: 'WORLD_CONTRACT_ERROR',
    });
    expect(eventsListMock).toHaveBeenCalledTimes(2);
  });

  it('fails when a response reports more pages without a cursor', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: [makeEvent('evnt_a')],
      cursor: null,
      hasMore: true,
    });

    await expect(
      loadWorkflowRunEvents({ runId: 'wrun_test' })
    ).rejects.toMatchObject({
      code: 'WORLD_CONTRACT_ERROR',
    });
    expect(eventsListMock).toHaveBeenCalledTimes(1);
  });
});

/** An id from the scheme slots replaced: a ULID, which carries no position. */
const UNPOSITIONED_EVENT_ID = 'evnt_01HF7YATRRC3M0F1K9Q2J8XW5B';

describe('slotSnapshotParams', () => {
  it('sends the highest slot the loaded log occupies', () => {
    const events = [1, 2, 3].map((slot) => makeEvent(slotToEventId(slot)));

    expect(slotSnapshotParams(events)).toEqual({ eventCount: 3 });
  });

  it('reports the highest slot, not the number of events', () => {
    // A slot is claimed by the write that occupies it, and a write that then
    // fails leaves it empty forever. Sending the count would make every later
    // write in this run ask below the hole and be handed the same events back
    // on every single create.
    const events = [1, 2, 5].map((slot) => makeEvent(slotToEventId(slot)));

    expect(slotSnapshotParams(events)).toEqual({ eventCount: 5 });
  });

  it('is invariant under the order the World returned the log in', () => {
    const forward = [1, 2, 3].map((slot) => makeEvent(slotToEventId(slot)));

    expect(slotSnapshotParams([...forward].reverse())).toEqual(
      slotSnapshotParams(forward)
    );
  });

  it('sends nothing on an empty log', () => {
    expect(slotSnapshotParams([])).toEqual({});
  });

  it('throws when any event of the log carries no slot', () => {
    // Skipping the id instead would understate the writer's position, and the
    // World cannot tell an understated position from an honest one: it would
    // hand back the same events on every create for the rest of the run.
    const events = [
      makeEvent(slotToEventId(1)),
      makeEvent(UNPOSITIONED_EVENT_ID),
    ];

    expect(() => slotSnapshotParams(events)).toThrow(UNPOSITIONED_EVENT_ID);
  });
});

describe('maxEventSlot', () => {
  it('is undefined for an empty log', () => {
    expect(maxEventSlot([])).toBeUndefined();
  });

  it('throws rather than ignoring an id that carries no slot', () => {
    expect(() => maxEventSlot([makeEvent(UNPOSITIONED_EVENT_ID)])).toThrow(
      UNPOSITIONED_EVENT_ID
    );
  });
});

/**
 * The hole check a replay runs over its loaded log. It gates whether the run
 * executes at all, so it is one-sided in the opposite direction from the
 * World's density counter: it reports a hole only where the log proves one.
 */
describe('findEventSlotGap', () => {
  const slotLog = (...slots: number[]) =>
    slots.map((slot) => makeEvent(slotToEventId(slot)));

  it('finds no hole in a dense log', () => {
    expect(findEventSlotGap(slotLog(1, 2, 3))).toBeUndefined();
  });

  it('names the hole and how much of the log is missing', () => {
    expect(findEventSlotGap(slotLog(1, 2, 5))).toEqual({
      firstMissingSlot: 3,
      missingCount: 2,
      maxSlot: 5,
    });
  });

  it('reports the lowest hole when there is more than one', () => {
    expect(findEventSlotGap(slotLog(1, 3, 5))).toEqual({
      firstMissingSlot: 2,
      missingCount: 2,
      maxSlot: 5,
    });
  });

  it('does not depend on the log being in slot order', () => {
    // The loaded log is listed pages plus whatever a bump-and-report write
    // handed back. mergeReportedEvents restores order, but a check that fails
    // a run outright must not be the thing that notices when it did not.
    expect(findEventSlotGap(slotLog(3, 1, 2))).toBeUndefined();
    expect(findEventSlotGap(slotLog(4, 1, 2))?.firstMissingSlot).toBe(3);
  });

  it('excuses a log missing only its reserved first slot', () => {
    // `start()` posts run_created concurrently with the queue send, so a log
    // read in that window legitimately begins at the second slot.
    expect(findEventSlotGap(slotLog(2, 3))).toBeUndefined();
  });

  it('still reports a hole above an absent first slot', () => {
    expect(findEventSlotGap(slotLog(2, 4))).toEqual({
      firstMissingSlot: 3,
      missingCount: 1,
      maxSlot: 4,
    });
  });

  it('says nothing about an empty log', () => {
    expect(findEventSlotGap([])).toBeUndefined();
  });

  it('throws on a log whose ids carry no position', () => {
    // The check is entirely positional. An id it cannot read is a log it
    // cannot judge, and passing the run as dense would be a verdict it never
    // reached.
    expect(() =>
      findEventSlotGap([...slotLog(1, 2), makeEvent(UNPOSITIONED_EVENT_ID)])
    ).toThrow(UNPOSITIONED_EVENT_ID);
  });
});

/**
 * The re-read that stands between a hole and a failed run. A hole can be one
 * commit wide: the World allocates a slot inside the insert that occupies it,
 * so a writer can commit a higher slot while a lower one is still in flight.
 * Only a hole that survives the re-reads is a position no write will ever take.
 */
describe('settleEventSlotGap', () => {
  beforeEach(() => {
    eventsListMock.mockReset();
  });

  const slotLog = (...slots: number[]) =>
    slots.map((slot) => makeEvent(slotToEventId(slot)));

  it('reports no gap for a log that is already dense', async () => {
    const settled = await settleEventSlotGap('wrun_test', {
      events: slotLog(1, 2, 3),
      cursor: 'eid:c',
    });

    expect(settled.gap).toBeUndefined();
    // Nothing to settle, so nothing is re-read.
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('adopts the log it re-read once the hole has filled in', async () => {
    eventsListMock.mockResolvedValueOnce({
      data: slotLog(1, 2, 3),
      cursor: 'eid:filled',
      hasMore: false,
    });

    const settled = await settleEventSlotGap('wrun_test', {
      events: slotLog(1, 3),
      cursor: 'eid:stale',
    });

    expect(settled.gap).toBeUndefined();
    // The caller replays what settled, not the snapshot that looked holey.
    expect(settled.log.events.map((e) => e.eventId)).toEqual(
      slotLog(1, 2, 3).map((e) => e.eventId)
    );
    expect(settled.log.cursor).toBe('eid:filled');
    expect(eventsListMock).toHaveBeenCalledTimes(1);
  });

  it('reports a hole that survives every re-read', async () => {
    eventsListMock.mockResolvedValue({
      data: slotLog(1, 4),
      cursor: 'eid:stuck',
      hasMore: false,
    });

    const settled = await settleEventSlotGap('wrun_test', {
      events: slotLog(1, 4),
      cursor: 'eid:stuck',
    });

    expect(settled.gap).toEqual({
      firstMissingSlot: 2,
      missingCount: 2,
      maxSlot: 4,
    });
    expect(eventsListMock).toHaveBeenCalledTimes(SLOT_GAP_RECHECK_ATTEMPTS);
  });
});

describe('mergeReportedEvents', () => {
  it('restores slot order after folding in events below the tail', () => {
    // Bump-and-report hands back events the writer had not seen, and they sit
    // BELOW the write that reported them. Appending would leave the log in an
    // order no replay can walk.
    const target = [1, 4].map((slot) => makeEvent(slotToEventId(slot)));

    const added = mergeReportedEvents(
      target,
      [3, 2].map((slot) => makeEvent(slotToEventId(slot)))
    );

    expect(added).toBe(2);
    expect(target.map((e) => e.eventId)).toEqual(
      [1, 2, 3, 4].map(slotToEventId)
    );
  });

  it('is a no-op when every reported event is already present', () => {
    const target = [1, 2].map((slot) => makeEvent(slotToEventId(slot)));

    expect(mergeReportedEvents(target, [makeEvent(slotToEventId(2))])).toBe(0);
    expect(target).toHaveLength(2);
  });
});

describe('appendUniqueEvents', () => {
  it('appends in receipt order', () => {
    const target = [makeEvent(slotToEventId(1))];

    appendUniqueEvents(target, [
      makeEvent(slotToEventId(2)),
      makeEvent(slotToEventId(3)),
    ]);

    expect(target.map((e) => e.eventId)).toEqual([1, 2, 3].map(slotToEventId));
  });

  it('preserves the order the World returned, never re-sorting by event id', () => {
    // Unlike mergeReportedEvents, this appends a page the World handed back as
    // a unit. Every source is already in canonical order relative to the tail,
    // so a sort could only ever be a wasted pass over the log — the reason
    // helpers.ts gives. Asserting the unsorted order is how a sort creeping in
    // gets noticed.
    const target = [makeEvent(slotToEventId(1)), makeEvent(slotToEventId(3))];

    appendUniqueEvents(target, [makeEvent(slotToEventId(2))]);

    expect(target.map((e) => e.eventId)).toEqual([1, 3, 2].map(slotToEventId));
  });

  it('deduplicates by event id', () => {
    const first = makeEvent(slotToEventId(1));
    const second = makeEvent(slotToEventId(2));
    const target = [first];

    appendUniqueEvents(target, [first, second, second]);

    expect(target.map((e) => e.eventId)).toEqual([1, 2].map(slotToEventId));
  });

  it('leaves the snapshot correct even when the merge is not id-ordered', () => {
    // Why the merge needs no sort of its own: the snapshot reads the maximum
    // slot across the log rather than the tail, so an out-of-order tail costs
    // nothing.
    const target = [makeEvent(slotToEventId(1)), makeEvent(slotToEventId(3))];

    appendUniqueEvents(target, [makeEvent(slotToEventId(2))]);

    expect(target.at(-1)?.eventId).toBe(slotToEventId(2));
    expect(slotSnapshotParams(target)).toEqual({ eventCount: 3 });
  });
});

describe('preconditionEventDelta', () => {
  // The run every fixture event below belongs to.
  const RUN_ID = 'wrun_mockidnumber0001';
  const delta = (details: unknown) =>
    preconditionEventDelta(
      new PreconditionFailedError('stale', { details }),
      RUN_ID
    );

  it('returns the decoded events and cursor a World attached to the 412', () => {
    const event = makeEvent(slotToEventId(1));

    expect(delta({ events: [event], cursor: 'eid:next' })).toEqual({
      events: [event],
      cursor: 'eid:next',
    });
  });

  it('returns a null cursor when the World sent events without one', () => {
    const event = makeEvent(slotToEventId(1));

    expect(delta({ events: [event] })).toEqual({
      events: [event],
      cursor: null,
    });
  });

  it('returns null when the World attached no details at all', () => {
    expect(
      preconditionEventDelta(new PreconditionFailedError('stale'), RUN_ID)
    ).toBe(null);
  });

  it('returns null for a non-precondition error', () => {
    expect(preconditionEventDelta(new Error('boom'), RUN_ID)).toBe(null);
  });

  it('returns null when any event belongs to another run', () => {
    // The delta is merged straight into the replay's log, so a foreign event
    // there produces a corrupt log rather than a corrected one: the replay
    // consumes a correlation id for an event this run does not have.
    const mine = makeEvent(slotToEventId(1));
    const theirs = {
      ...makeEvent(slotToEventId(2)),
      runId: 'wrun_someotherrun001',
    } as Event;

    expect(delta({ events: [theirs] })).toBe(null);
    expect(delta({ events: [mine, theirs] })).toBe(null);
    expect(delta({ events: [mine] })).not.toBe(null);
  });

  it('returns null for an empty or malformed events payload', () => {
    // Nothing here is repaired: a full reload is always correct, so anything
    // that does not narrow cleanly falls back to it.
    expect(delta({ events: [] })).toBe(null);
    expect(delta({ events: 'not-an-array' })).toBe(null);
    expect(delta({ events: [{ noEventId: true }] })).toBe(null);
    expect(delta({ events: [null] })).toBe(null);
    expect(delta('not-an-object')).toBe(null);
  });
});

describe('memoizeEncryptionKey', () => {
  const MATERIAL = new Uint8Array(32).fill(0x6b);

  function worldWithKey(getEncryptionKeyForRun: unknown): World {
    return { getEncryptionKeyForRun } as unknown as World;
  }

  it('resolves a key that can open payloads sealed to the run', async () => {
    // A run reading its own event log may find sealed ('encp') payloads that
    // another run wrote to it — a cross-deployment hook resumption, say. If
    // this resolved only the symmetric key, those payloads would fail to open
    // and wedge the run, so the sealed capability must be part of what every
    // reader gets by default.
    const getKey = memoizeEncryptionKey(
      worldWithKey(vi.fn().mockResolvedValue(MATERIAL)),
      'wrun_1'
    );
    const resolved = await getKey();
    expect(resolved).toBeDefined();

    const { publicKey } = await deriveRunKeyPair(MATERIAL);
    const sealed = await seal(publicKey, new TextEncoder().encode('"hi"'));
    const prefixed = encodeWithFormatPrefix(
      SerializationFormat.SEALED,
      sealed
    ) as Uint8Array;

    expect(await decrypt(prefixed, resolved)).toEqual(
      new TextEncoder().encode('"hi"')
    );
  });

  it("resolves a key that still opens the run's own symmetric payloads", async () => {
    const getKey = memoizeEncryptionKey(
      worldWithKey(vi.fn().mockResolvedValue(MATERIAL)),
      'wrun_1'
    );
    const resolved = await getKey();

    const encrypted = await encrypt(new TextEncoder().encode('"hi"'), resolved);
    expect(peekFormatPrefix(encrypted)).toBe(SerializationFormat.ENCRYPTED);
    expect(await decrypt(encrypted, resolved)).toEqual(
      new TextEncoder().encode('"hi"')
    );
  });

  it('memoizes so the key is derived once per run', async () => {
    // Derivation now costs several Web Crypto round trips (HKDF + a PKCS#8
    // import + a JWK export), so re-deriving per payload would be wasteful.
    const spy = vi.fn().mockResolvedValue(MATERIAL);
    const getKey = memoizeEncryptionKey(worldWithKey(spy), 'wrun_1');

    const [a, b] = await Promise.all([getKey(), getKey()]);
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('passes deployment context when resolving before the run is materialized', async () => {
    const spy = vi.fn().mockResolvedValue(MATERIAL);
    const getKey = memoizeEncryptionKey(worldWithKey(spy), 'wrun_1', {
      deploymentId: 'dpl_streamed',
    });

    await getKey();
    expect(spy).toHaveBeenCalledWith('wrun_1', {
      deploymentId: 'dpl_streamed',
    });
  });

  it('resolves undefined when encryption is not configured', async () => {
    const getKey = memoizeEncryptionKey(worldWithKey(undefined), 'wrun_1');
    await expect(getKey()).resolves.toBeUndefined();
  });
});

describe('health check run public key', () => {
  const MATERIAL = new Uint8Array(32).fill(0x5e);

  /** Capture what the responder writes to the probe response stream. */
  function responderWorld(getEncryptionKeyForRun?: unknown) {
    const write = vi.fn().mockResolvedValue(undefined);
    const world = {
      streams: { write, close: vi.fn().mockResolvedValue(undefined) },
      getEncryptionKeyForRun,
    } as unknown as World;
    return { world, write };
  }

  function writtenResponse(write: ReturnType<typeof vi.fn>) {
    return JSON.parse(write.mock.calls[0][2] as string);
  }

  it('returns the run public key when the probe names a run', async () => {
    // The responder executes inside the target deployment, so it can derive
    // the key locally — that is what lets a cross-deployment start() skip the
    // key-lookup API request entirely.
    const { getWorldLazy } = await import('./get-world-lazy.js');
    const { world, write } = responderWorld(
      vi.fn().mockResolvedValue(MATERIAL)
    );
    vi.mocked(getWorldLazy).mockReturnValue(world as any);

    await handleHealthCheckMessage(
      { __healthCheck: true, correlationId: 'corr_1', runId: 'wrun_1' },
      'workflow'
    );

    const { publicKey } = await deriveRunKeyPair(MATERIAL);
    expect(writtenResponse(write).encryptionPublicKey).toBe(
      bytesToBase64(publicKey)
    );
  });

  it('omits the key when the probe names no run', async () => {
    // Probes issued by the CLI health command or the dashboard carry no
    // runId; they must not trigger key derivation at all.
    const { getWorldLazy } = await import('./get-world-lazy.js');
    const getEncryptionKeyForRun = vi.fn().mockResolvedValue(MATERIAL);
    const { world, write } = responderWorld(getEncryptionKeyForRun);
    vi.mocked(getWorldLazy).mockReturnValue(world as any);

    await handleHealthCheckMessage(
      { __healthCheck: true, correlationId: 'corr_2' },
      'workflow'
    );

    expect(getEncryptionKeyForRun).not.toHaveBeenCalled();
    expect(writtenResponse(write).encryptionPublicKey).toBeUndefined();
    expect(writtenResponse(write).healthy).toBe(true);
  });

  it('omits the key when encryption is not configured', async () => {
    const { getWorldLazy } = await import('./get-world-lazy.js');
    const { world, write } = responderWorld(undefined);
    vi.mocked(getWorldLazy).mockReturnValue(world as any);

    await handleHealthCheckMessage(
      { __healthCheck: true, correlationId: 'corr_3', runId: 'wrun_1' },
      'workflow'
    );

    expect(writtenResponse(write).encryptionPublicKey).toBeUndefined();
    expect(writtenResponse(write).healthy).toBe(true);
  });

  it('still reports healthy when key derivation fails', async () => {
    // The probe doubles as plain capability detection, so a key problem must
    // degrade to "no key" (caller falls back to a lookup) rather than fail
    // the health check and lose the capability information too.
    const { getWorldLazy } = await import('./get-world-lazy.js');
    const { world, write } = responderWorld(
      vi.fn().mockRejectedValue(new Error('key service down'))
    );
    vi.mocked(getWorldLazy).mockReturnValue(world as any);

    await handleHealthCheckMessage(
      { __healthCheck: true, correlationId: 'corr_4', runId: 'wrun_1' },
      'workflow'
    );

    const response = writtenResponse(write);
    expect(response.healthy).toBe(true);
    expect(response.encryptionPublicKey).toBeUndefined();
    expect(response.workflowCoreVersion).toBeDefined();
  });
});
