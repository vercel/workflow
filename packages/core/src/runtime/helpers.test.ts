import {
  EntityConflictError,
  PreconditionFailedError,
  SlotConflictError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type Event,
  type EventResult,
  SPEC_VERSION_SLOT_IDENTITY,
  slotEventId,
  type World,
} from '@workflow/world';
import { ulid } from 'ulid';
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
  claimFenceFor,
  eventCreateFenceFor,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  healthCheck,
  insertEventByEventId,
  isStaleWriteRejection,
  latestEventStateUpdatedAt,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  mergeLoadedEvents,
  orderedCreateFor,
  preconditionEventDelta,
  preconditionSnapshotParams,
  reserveSlot,
  toMutableEventLog,
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

    const result = await loadWorkflowRunEvents('wrun_test');

    expect(result.events).toHaveLength(2);
    expect(result.cursor).toBe('eid:evnt_b');
    expect(eventsListMock).toHaveBeenCalledTimes(1);
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

    const result = await loadWorkflowRunEvents('wrun_test');

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

    const result = await loadWorkflowRunEvents('wrun_test');

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

    const result = await loadWorkflowRunEvents('wrun_test');

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

    const result = await loadWorkflowRunEvents('wrun_test', 'eid:evnt_z');

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

    const result = await loadWorkflowRunEvents('wrun_test');

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

    const result = await loadWorkflowRunEvents('wrun_test', 'opaque-cursor');

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

    await expect(loadWorkflowRunEvents('wrun_test')).rejects.toMatchObject({
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

    await expect(loadWorkflowRunEvents('wrun_test')).rejects.toMatchObject({
      code: 'WORLD_CONTRACT_ERROR',
    });
    expect(eventsListMock).toHaveBeenCalledTimes(1);
  });
});

const makeUlidEvent = (time: number): Event =>
  ({
    eventId: `evnt_${ulid(time)}`,
    runId: 'wrun_mockidnumber0001',
    eventType: 'step_created',
    correlationId: 'step_mock',
    createdAt: new Date(time),
  }) as unknown as Event;

describe('latestEventStateUpdatedAt', () => {
  it('returns undefined for an empty event list', () => {
    expect(latestEventStateUpdatedAt([])).toBeUndefined();
  });

  it('decodes the ULID time of the newest event, stripping the prefix', () => {
    const time = 1_700_000_000_000;
    // ULID time resolution is whole milliseconds.
    expect(
      latestEventStateUpdatedAt([
        makeUlidEvent(time - 1000),
        makeUlidEvent(time),
      ])
    ).toBe(time);
  });

  it('reports the maximum, not the tail, when the log is not id-ordered', () => {
    // A World's canonical order need not be event-id order (world-local orders
    // by `(createdAt, eventId)`), so the watermark cannot be read off the tail.
    const time = 1_700_000_002_000;

    expect(
      latestEventStateUpdatedAt([
        makeUlidEvent(time),
        makeUlidEvent(1_700_000_000_000),
        makeUlidEvent(1_700_000_001_000),
      ])
    ).toBe(time);
  });

  it('returns undefined when the newest event id is not a decodable ULID', () => {
    expect(
      latestEventStateUpdatedAt([makeEvent('evnt_not-a-ulid')])
    ).toBeUndefined();
  });
});

describe('slot bookkeeping', () => {
  const slotEvent = (slot: number) => makeEvent(slotEventId(slot));

  it('reads maxSlot from the highest slot present, not the last element', () => {
    // Nothing forces a caller's array into slot order — a World is free to
    // hand back a page in whatever order its index produced — so the highest
    // slot is a scan, not a peek at the last element.
    const log = toMutableEventLog([slotEvent(3), slotEvent(1)], 'c0');
    expect(log.maxSlot).toBe(3);
    expect(log.nextSlot).toBe(4);
  });

  it('reports maxSlot 0 for an empty or ULID-numbered log', () => {
    expect(toMutableEventLog([], null).maxSlot).toBe(0);
    expect(
      toMutableEventLog([makeUlidEvent(1_700_000_000_000)], null).maxSlot
    ).toBe(0);
  });

  it('starts at a floor the snapshot cannot show', () => {
    // Turbo replays against an empty log while its `run_started` write is still
    // in flight, so the snapshot alone would number the first claim onto a slot
    // that write already holds.
    const log = toMutableEventLog([], null, 2);
    expect(log.maxSlot).toBe(2);
    expect(reserveSlot(log)).toBe(3);
  });

  it('ignores a floor the snapshot has already passed', () => {
    const log = toMutableEventLog([slotEvent(5)], 'c0', 2);
    expect(log.maxSlot).toBe(5);
  });

  it('keeps the floor across a merge', () => {
    const log = toMutableEventLog([], null, 2);
    mergeLoadedEvents(log, [slotEvent(1)]);
    expect(log.maxSlot).toBe(2);
  });

  it('never lowers maxSlot when an older delta is merged in', () => {
    const log = toMutableEventLog([slotEvent(1), slotEvent(3)], 'c0');
    mergeLoadedEvents(log, [slotEvent(2)]);
    expect(log.maxSlot).toBe(3);
    expect(log.events).toHaveLength(3);
  });

  it('raises the reservation pointer past a newer delta', () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    reserveSlot(log);
    reserveSlot(log);
    expect(log.nextSlot).toBe(4);

    mergeLoadedEvents(log, [slotEvent(2), slotEvent(5)]);

    expect(log.maxSlot).toBe(5);
    expect(reserveSlot(log)).toBe(6);
  });

  it('never rewinds the reservation pointer onto an outstanding slot', () => {
    // A writer that loses its slot merges the delta and reserves again while
    // its siblings are still in flight on theirs. Rewinding to `maxSlot + 1`
    // would hand it slot 4, which a sibling already holds.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    expect(reserveSlot(log)).toBe(2);
    expect(reserveSlot(log)).toBe(3);
    expect(reserveSlot(log)).toBe(4);

    mergeLoadedEvents(log, [slotEvent(2)]);

    expect(log.maxSlot).toBe(2);
    expect(reserveSlot(log)).toBe(5);
  });

  it('deduplicates merged events by id', () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    mergeLoadedEvents(log, [slotEvent(1), slotEvent(2)]);
    expect(log.events.map((e) => e.eventId)).toEqual([
      slotEventId(1),
      slotEventId(2),
    ]);
  });

  it('restores slot order when a merge brings in a lower slot', () => {
    // Arrival order is not log order: a slot is reserved when its event is
    // issued and written when the issue resolves, so a lower slot can be
    // learned after a higher one. The replay consumes this array positionally,
    // so an event left sitting ahead of the one it followed decides races the
    // wrong way.
    const log = toMutableEventLog([slotEvent(1), slotEvent(4)], 'c0');
    mergeLoadedEvents(log, [slotEvent(3), slotEvent(2)]);
    expect(log.events.map((e) => e.eventId)).toEqual([
      slotEventId(1),
      slotEventId(2),
      slotEventId(3),
      slotEventId(4),
    ]);
  });

  it('leaves a ULID log in the order the World returned it', () => {
    // ULID ids are minted at write time, so arrival order *is* log order and
    // the World's ordering is the authority.
    const events = [makeUlidEvent(1_700_000_000_000)];
    const later = makeUlidEvent(1_700_000_001_000);
    const earlier = makeUlidEvent(1_699_999_999_000);
    const log = toMutableEventLog(events, 'c0');
    mergeLoadedEvents(log, [later, earlier]);
    expect(log.events).toEqual([events[0], later, earlier]);
  });

  it('hands out contiguous distinct slots for a synchronous burst', () => {
    // The suspension flush issues every operation synchronously and awaits
    // them together; without contiguous reservation they would all propose the
    // same slot and all but one would conflict.
    const log = toMutableEventLog([slotEvent(4)], 'c0');
    const burst = Array.from({ length: 20 }, () => reserveSlot(log));
    expect(burst).toEqual(Array.from({ length: 20 }, (_, i) => 5 + i));
    expect(new Set(burst).size).toBe(burst.length);
    // Reservations sit past maxSlot rather than moving it: only merged events
    // prove a slot is taken.
    expect(log.maxSlot).toBe(4);
  });

  it('proposes a padded event id only for a slot-identity run', () => {
    const log = toMutableEventLog([], null);
    expect(eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY)).toEqual({
      eventId: slotEventId(1),
      maxSlot: 0,
    });
    expect(eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY)).toEqual({
      eventId: slotEventId(2),
      maxSlot: 0,
    });
  });

  it('reserves a slot per extra event and names the top one', () => {
    // A lazy inline `step_started` publishes two events: the World also writes
    // the `step_created` it deferred, which takes the slot below the claim.
    // Reserving it here is what keeps it off the slot the next write of the
    // same batch will claim.
    const log = toMutableEventLog([slotEvent(1)], null);
    expect(
      eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY, { extraEvents: 1 })
    ).toEqual({ eventId: slotEventId(3), maxSlot: 1 });
    expect(
      eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY, { extraEvents: 1 })
    ).toEqual({ eventId: slotEventId(5), maxSlot: 1 });
    // A single-event write in the same batch still gets the next free slot.
    expect(eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY)).toEqual({
      eventId: slotEventId(6),
      maxSlot: 1,
    });
  });

  it('burns no slot on an extra event of a ULID-numbered run', () => {
    const log = toMutableEventLog([], null);
    eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY - 1, {
      extraEvents: 1,
    });
    expect(log.nextSlot).toBe(1);
  });

  it('proposes no event id for a ULID-numbered run', () => {
    // A run whose ids the backend mints must not burn slots either.
    const log = toMutableEventLog([], null);
    const fence = eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY - 1);
    expect(fence?.eventId).toBeUndefined();
    expect(log.nextSlot).toBe(1);
  });
});

describe('claimFenceFor', () => {
  const slotEvent = (slot: number) => makeEvent(slotEventId(slot));

  beforeEach(() => {
    eventsListMock.mockReset();
  });

  it('claims the next free slot and passes the observed maxSlot alongside it', async () => {
    const log = toMutableEventLog([slotEvent(1), slotEvent(2)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const op = vi.fn(async () => 'ok');

    await expect(claim(op)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledWith({ eventId: slotEventId(3), maxSlot: 2 });
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('takes each claim only once the create ahead of it has committed', async () => {
    // A claim fences out a concurrent writer only while it names the slot right
    // after the tail the writer saw, so a second create cannot be numbered
    // until the first has landed.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const claimed: (string | undefined)[] = [];
    let releaseFirst!: () => void;
    const firstLanded = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = claim(async (fence) => {
      claimed.push(fence?.eventId);
      await firstLanded;
      return 'first';
    });
    const second = claim(async (fence) => {
      claimed.push(fence?.eventId);
      return 'second';
    });

    await Promise.resolve();
    expect(claimed).toEqual([slotEventId(2)]);

    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(claimed).toEqual([slotEventId(2), slotEventId(3)]);
  });

  it('rejects a lost claim rather than re-addressing the write', async () => {
    // A 409 says this replay decided from a log missing an event. Moving the
    // same write to a free slot would commit that decision anyway, so the
    // rejection propagates and the run replays.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const op = vi.fn(async (fence?: { eventId?: string }) => {
      throw new SlotConflictError('taken', {
        eventId: fence?.eventId as string,
        events: [slotEvent(2)],
        cursor: 'c1',
      });
    });

    await expect(claim(op)).rejects.toBeInstanceOf(SlotConflictError);
    expect(op).toHaveBeenCalledTimes(1);
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('fails the rest of the batch without a round-trip', async () => {
    // The siblings behind a rejected claim were decided from the same log, so
    // they carry the fence it just proved wrong. They rethrow that rejection
    // instead of spending a create each to be told the same thing.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const rejection = new SlotConflictError('taken', {
      eventId: slotEventId(2),
    });
    const loser = claim(async () => {
      throw rejection;
    });
    await expect(loser).rejects.toBe(rejection);

    const sibling = vi.fn(
      async (fence?: { eventId?: string }) => fence?.eventId
    );
    await expect(claim(sibling)).rejects.toBe(rejection);
    expect(sibling).not.toHaveBeenCalled();
  });

  it('lets a write that failed without taking its slot claim it again', async () => {
    // An entity conflict means the event never landed, so the slot is still
    // free. Only a stale-write rejection stops the log.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    await expect(
      claim(async () => {
        throw new EntityConflictError('wait already completed');
      })
    ).rejects.toBeInstanceOf(EntityConflictError);

    await expect(claim(async (fence) => fence?.eventId)).resolves.toBe(
      slotEventId(2)
    );
  });

  it('numbers a batch in the order its claims fire, each one above the last', async () => {
    // A step that publishes the `step_created` it deferred takes the two slots
    // below its claim, and the next claim starts above both.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const withCreate = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY, {
      extraEvents: 1,
    });
    const plain = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);

    const claimed: (string | undefined)[] = [];
    const record = (fence?: { eventId?: string }) => {
      claimed.push(fence?.eventId);
      return Promise.resolve('ok');
    };
    await withCreate(record);
    await plain(record);

    expect(claimed).toEqual([slotEventId(3), slotEventId(4)]);
  });

  it('rethrows a non-conflict error immediately, without merging', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const op = vi.fn(async () => {
      throw new PreconditionFailedError('stale');
    });

    await expect(claim(op)).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(op).toHaveBeenCalledTimes(1);
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('leaves a ULID-numbered batch on one shared watermark, unserialized', async () => {
    // A 412 compares time, so every member of the batch carries the same fence
    // value and the batch fails as a unit — which is what the caller's
    // fresh-replay path expects.
    const time = 1_700_000_000_000;
    const log = toMutableEventLog([makeUlidEvent(time)], 'c0');
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY - 1);
    const op = vi.fn(async () => {
      throw new PreconditionFailedError('stale');
    });

    await expect(claim(op)).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(op).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenCalledWith(
      expect.objectContaining({ stateUpdatedAt: time })
    );
    expect(eventsListMock).not.toHaveBeenCalled();
  });
});

describe('orderedCreateFor', () => {
  const slotEvent = (slot: number) => makeEvent(slotEventId(slot));
  const result = (slot: number) =>
    ({ event: slotEvent(slot) }) as unknown as EventResult;

  beforeEach(() => {
    eventsListMock.mockReset();
  });

  it('leaves the position of an unfenced write to the backend', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const ordered = orderedCreateFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const op = vi.fn(async (fence) => {
      expect(fence).toBeUndefined();
      return result(2);
    });

    const written = await ordered?.(op);
    expect(written?.event?.eventId).toBe(slotEventId(2));
    // The slot the backend chose folds into the log, so a later claim draws
    // above it rather than at it.
    expect(log.maxSlot).toBe(2);
    expect(log.nextSlot).toBe(3);
  });

  it('keeps a claim in the same batch off the slot an unfenced write took', async () => {
    // The collision this exists to remove: a lazy start reserves the
    // `step_created` it defers below its claim, so the tail a backend-allocated
    // write lands on is a slot that start has already promised. Running both off
    // one chain leaves them disjoint without either write naming a slot.
    const log = toMutableEventLog([slotEvent(1), slotEvent(2)], 'c0');
    const ordered = orderedCreateFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY, {
      extraEvents: 1,
    });

    await ordered?.(async () => result(3));
    const claimed = await claim(async (fence) => fence?.eventId);

    // Slots 4 and 5 belong to the claim: 4 to the deferred create, 5 to the
    // claim itself.
    expect(claimed).toBe(slotEventId(5));
  });

  it('holds a claim on the same log until the unfenced write has landed', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const ordered = orderedCreateFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const claim = claimFenceFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const order: string[] = [];
    let land!: () => void;
    const landed = new Promise<void>((resolve) => {
      land = resolve;
    });

    const write = ordered?.(async () => {
      order.push('write:issued');
      await landed;
      return result(2);
    });
    const drawn = claim(async (fence) => {
      order.push('claim:drawn');
      return fence?.eventId;
    });

    land();
    await write;

    expect(order).toEqual(['write:issued', 'claim:drawn']);
    // Drawn after the backend's answer folded in, so above it.
    await expect(drawn).resolves.toBe(slotEventId(3));
  });

  it('propagates a lost slot rather than re-issuing the write', async () => {
    // Re-issuing costs the event: a backend that materializes an entity before
    // it publishes has already applied the transition the lost event described,
    // so the second attempt is refused as a duplicate.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const ordered = orderedCreateFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const op = vi.fn(async () => {
      throw new SlotConflictError('taken', {
        eventId: slotEventId(2),
        events: [slotEvent(2)],
        cursor: 'c1',
      });
    });

    await expect(ordered?.(op)).rejects.toBeInstanceOf(SlotConflictError);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('propagates a rejection of the write itself', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const ordered = orderedCreateFor(log, SPEC_VERSION_SLOT_IDENTITY);
    const op = vi.fn(async () => {
      throw new EntityConflictError('step already completed');
    });

    await expect(ordered?.(op)).rejects.toBeInstanceOf(EntityConflictError);
    expect(op).toHaveBeenCalledTimes(1);
    // Nothing was drawn for it, so the log is where it was.
    expect(log.nextSlot).toBe(2);
  });

  it('does not order a write of a ULID-numbered run', () => {
    expect(
      orderedCreateFor(
        toMutableEventLog([], null),
        SPEC_VERSION_SLOT_IDENTITY - 1
      )
    ).toBeUndefined();
  });
});

describe('preconditionSnapshotParams', () => {
  let originalGuard: string | undefined;

  beforeEach(() => {
    originalGuard = process.env.WORKFLOW_PRECONDITION_GUARD;
    process.env.WORKFLOW_PRECONDITION_GUARD = '1';
  });

  afterEach(() => {
    if (originalGuard !== undefined) {
      process.env.WORKFLOW_PRECONDITION_GUARD = originalGuard;
    } else {
      delete process.env.WORKFLOW_PRECONDITION_GUARD;
    }
  });

  it('sends the watermark, the count and the cursor together', () => {
    const time = 1_700_000_000_000;
    const events = [makeUlidEvent(time - 1000), makeUlidEvent(time)];

    expect(preconditionSnapshotParams(events, 'eid:abc')).toEqual({
      stateUpdatedAt: time,
      stateEventCount: events.length,
      stateCursor: 'eid:abc',
    });
  });

  it('sends the count without a cursor when the caller has none', () => {
    const time = 1_700_000_000_000;

    expect(preconditionSnapshotParams([makeUlidEvent(time)], null)).toEqual({
      stateUpdatedAt: time,
      stateEventCount: 1,
    });
  });

  it('sends the snapshot by default (guard is on unless disabled)', () => {
    delete process.env.WORKFLOW_PRECONDITION_GUARD;
    const time = 1_700_000_000_000;

    expect(
      preconditionSnapshotParams([makeUlidEvent(time)], 'eid:abc')
    ).toEqual({
      stateUpdatedAt: time,
      stateEventCount: 1,
      stateCursor: 'eid:abc',
    });
  });

  it('omits every field when the guard is disabled', () => {
    process.env.WORKFLOW_PRECONDITION_GUARD = '0';

    expect(
      preconditionSnapshotParams([makeUlidEvent(1_700_000_000_000)], 'eid:abc')
    ).toEqual({});
  });

  it('omits every field on an empty log', () => {
    expect(preconditionSnapshotParams([], 'eid:abc')).toEqual({});
  });

  it('omits every field when the latest event id is not a decodable ULID', () => {
    // A count without a watermark would be meaningless to the backend, so the
    // three fields have to fail open together.
    expect(
      preconditionSnapshotParams([makeEvent('evnt_not-a-ulid')], 'eid:abc')
    ).toEqual({});
  });
});

describe('appendUniqueEvents', () => {
  it('appends in receipt order', () => {
    const first = makeUlidEvent(1_700_000_000_000);
    const second = makeUlidEvent(1_700_000_001_000);
    const third = makeUlidEvent(1_700_000_002_000);
    const target = [first];

    appendUniqueEvents(target, [second, third]);

    expect(target.map((e) => e.eventId)).toEqual([
      first.eventId,
      second.eventId,
      third.eventId,
    ]);
  });

  it('preserves the order the World returned, never re-sorting by event id', () => {
    // A World's canonical order is its own: world-local orders by
    // `(createdAt, eventId)` and re-mints keys so the two diverge, so an
    // id-ordered re-sort here would produce an order no load would return.
    const older = makeUlidEvent(1_700_000_000_000);
    const newer = makeUlidEvent(1_700_000_002_000);
    const middle = makeUlidEvent(1_700_000_001_000);
    const target = [older, newer];

    appendUniqueEvents(target, [middle]);

    expect(target.map((e) => e.eventId)).toEqual([
      older.eventId,
      newer.eventId,
      middle.eventId,
    ]);
  });

  it('deduplicates by event id', () => {
    const first = makeUlidEvent(1_700_000_000_000);
    const second = makeUlidEvent(1_700_000_001_000);
    const target = [first];

    appendUniqueEvents(target, [first, second, second]);

    expect(target.map((e) => e.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
  });

  it('keeps a same-millisecond pair in receipt order', () => {
    const time = 1_700_000_000_000;
    const a = makeEvent(`evnt_${ulid(time).slice(0, 10)}AAAAAAAAAAAAAAAA`);
    const b = makeEvent(`evnt_${ulid(time).slice(0, 10)}ZZZZZZZZZZZZZZZZ`);
    const target = [b];

    appendUniqueEvents(target, [a]);

    expect(target.map((e) => e.eventId)).toEqual([b.eventId, a.eventId]);
  });

  it('leaves the watermark correct even when the merge is not id-ordered', () => {
    // Why the merge needs no sort: the snapshot reads the maximum ULID time
    // across the log rather than the tail, so an out-of-order tail costs nothing
    // and every loaded event stays at or below the watermark.
    const time = 1_700_000_002_000;
    const target = [makeUlidEvent(1_700_000_000_000), makeUlidEvent(time)];

    appendUniqueEvents(target, [makeUlidEvent(1_700_000_001_000)]);

    expect(latestEventStateUpdatedAt(target)).toBe(time);
    expect(preconditionSnapshotParams(target, 'eid:abc')).toEqual({
      stateUpdatedAt: time,
      stateEventCount: 3,
      stateCursor: 'eid:abc',
    });
  });
});

describe('preconditionEventDelta', () => {
  // The run every `makeUlidEvent` belongs to.
  const RUN_ID = 'wrun_mockidnumber0001';
  const delta = (details: unknown) =>
    preconditionEventDelta(
      new PreconditionFailedError('stale', { details }),
      RUN_ID
    );

  it('returns the decoded events and cursor a World attached to the 412', () => {
    const event = makeUlidEvent(1_700_000_000_000);

    expect(delta({ events: [event], cursor: 'eid:next' })).toEqual({
      events: [event],
      cursor: 'eid:next',
    });
  });

  it('returns a null cursor when the World sent events without one', () => {
    const event = makeUlidEvent(1_700_000_000_000);

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
    const mine = makeUlidEvent(1_700_000_000_000);
    const theirs = {
      ...makeUlidEvent(1_700_000_001_000),
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

  it('reads the delta a lost slot claim carries as typed fields', () => {
    const event = makeUlidEvent(1_700_000_000_000);

    expect(
      preconditionEventDelta(
        new SlotConflictError('taken', {
          eventId: slotEventId(4),
          events: [event],
          cursor: 'eid:next',
          hasMore: false,
        }),
        RUN_ID
      )
    ).toEqual({ events: [event], cursor: 'eid:next' });
  });

  it('refuses a truncated slot-conflict delta', () => {
    // A partial delta would restart the replay on a log that is still missing
    // events; only a full reload can prove it saw all of them.
    expect(
      preconditionEventDelta(
        new SlotConflictError('taken', {
          eventId: slotEventId(4),
          events: [makeUlidEvent(1_700_000_000_000)],
          cursor: 'eid:next',
          hasMore: true,
        }),
        RUN_ID
      )
    ).toBe(null);
  });
});

describe('isStaleWriteRejection', () => {
  it('accepts both rejections that prove the replay read an incomplete log', () => {
    expect(isStaleWriteRejection(new PreconditionFailedError('stale'))).toBe(
      true
    );
    expect(
      isStaleWriteRejection(
        new SlotConflictError('taken', {
          eventId: slotEventId(4),
          events: [],
          cursor: null,
          hasMore: false,
        })
      )
    ).toBe(true);
  });

  it('rejects every other failure, which is not recovered by a restart', () => {
    expect(isStaleWriteRejection(new WorkflowWorldError('boom'))).toBe(false);
    expect(isStaleWriteRejection(new Error('boom'))).toBe(false);
    expect(isStaleWriteRejection(undefined)).toBe(false);
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

    await expect(decrypt(prefixed, resolved)).resolves.toEqual(
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
    await expect(decrypt(encrypted, resolved)).resolves.toEqual(
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
