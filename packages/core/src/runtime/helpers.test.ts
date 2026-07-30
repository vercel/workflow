import {
  PreconditionFailedError,
  SlotConflictError,
  WorkflowWorldError,
} from '@workflow/errors';
import {
  type Event,
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
  eventCreateFenceFor,
  getWorkflowQueueName,
  handleHealthCheckMessage,
  healthCheck,
  latestEventStateUpdatedAt,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  mergeLoadedEvents,
  PRECONDITION_MAX_RELOAD_RETRIES,
  reserveSlot,
  stateUpdatedAtForCreate,
  toMutableEventLog,
  withEventCreateFence,
  withPreconditionRetry,
  withSlotRetry,
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

  it('decodes the ULID time of the last (newest) event, stripping the prefix', () => {
    const time = 1_700_000_000_000;
    // ULID time resolution is whole milliseconds.
    expect(
      latestEventStateUpdatedAt([
        makeUlidEvent(time - 1000),
        makeUlidEvent(time),
      ])
    ).toBe(time);
  });

  it('returns undefined when the latest event id is not a decodable ULID', () => {
    expect(
      latestEventStateUpdatedAt([makeEvent('evnt_not-a-ulid')])
    ).toBeUndefined();
  });
});

describe('slot bookkeeping', () => {
  const slotEvent = (slot: number) => makeEvent(slotEventId(slot));

  it('reads maxSlot from the highest slot present, not the last element', () => {
    // `appendUniqueEvents` appends without sorting, so a merged log's last
    // element is not necessarily its newest event.
    const log = toMutableEventLog([slotEvent(3), slotEvent(1)], 'c0');
    expect(log.maxSlot).toBe(3);
    expect(log.reserved).toBe(0);
  });

  it('reports maxSlot 0 for an empty or ULID-numbered log', () => {
    expect(toMutableEventLog([], null).maxSlot).toBe(0);
    expect(
      toMutableEventLog([makeUlidEvent(1_700_000_000_000)], null).maxSlot
    ).toBe(0);
  });

  it('never lowers maxSlot when an older delta is merged in', () => {
    const log = toMutableEventLog([slotEvent(1), slotEvent(3)], 'c0');
    mergeLoadedEvents(log, [slotEvent(2)]);
    expect(log.maxSlot).toBe(3);
    expect(log.events).toHaveLength(3);
  });

  it('raises maxSlot and drops reservations when a newer delta is merged in', () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    reserveSlot(log);
    reserveSlot(log);
    expect(log.reserved).toBe(2);

    mergeLoadedEvents(log, [slotEvent(2), slotEvent(5)]);

    expect(log.maxSlot).toBe(5);
    // The merged events are the authority on which slots are taken, so the
    // outstanding reservations (slots 2 and 3) are void.
    expect(log.reserved).toBe(0);
    expect(reserveSlot(log)).toBe(6);
  });

  it('deduplicates merged events by id', () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    mergeLoadedEvents(log, [slotEvent(1), slotEvent(2)]);
    expect(log.events.map((e) => e.eventId)).toEqual([
      slotEventId(1),
      slotEventId(2),
    ]);
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

  it('proposes no event id for a ULID-numbered run', () => {
    // A run whose ids the backend mints must not burn slots either.
    const log = toMutableEventLog([], null);
    const fence = eventCreateFenceFor(log, SPEC_VERSION_SLOT_IDENTITY - 1);
    expect(fence?.eventId).toBeUndefined();
    expect(log.reserved).toBe(0);
  });
});

describe('stateUpdatedAtForCreate', () => {
  it('sends no watermark for a slot-numbered run even with the guard on', () => {
    // The event id is the fence for these runs. Inference would be worse than
    // useless here: a padded slot body is valid Crockford base32, so decoding
    // it yields epoch 0 rather than failing, and the client would claim a
    // snapshot older than every event in the log.
    const events = [makeEvent(slotEventId(1))];
    expect(
      stateUpdatedAtForCreate(events, SPEC_VERSION_SLOT_IDENTITY)
    ).toBeUndefined();
  });

  it('sends the snapshot watermark for a ULID-numbered run', () => {
    const time = 1_700_000_000_000;
    expect(
      stateUpdatedAtForCreate(
        [makeUlidEvent(time)],
        SPEC_VERSION_SLOT_IDENTITY - 1
      )
    ).toBe(time);
  });
});

describe('withSlotRetry', () => {
  const slotEvent = (slot: number) => makeEvent(slotEventId(slot));

  beforeEach(() => {
    eventsListMock.mockReset();
  });

  it('claims the next free slot and passes the observed maxSlot alongside it', async () => {
    const log = toMutableEventLog([slotEvent(1), slotEvent(2)], 'c0');
    const op = vi.fn(async () => 'ok');

    await expect(withSlotRetry('wrun_test', log, op)).resolves.toBe('ok');
    expect(op).toHaveBeenCalledWith({ eventId: slotEventId(3), maxSlot: 2 });
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('merges the conflict delta and reclaims past it, without reloading', async () => {
    // The inline delta is the whole point of the 409 body: the client learns
    // which events it was missing without a follow-up round-trip.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const claimed: string[] = [];
    const op = vi.fn(async ({ eventId }: { eventId?: string }) => {
      claimed.push(eventId as string);
      if (claimed.length === 1) {
        throw new SlotConflictError('taken', {
          eventId: eventId as string,
          events: [slotEvent(2), slotEvent(3)],
          cursor: 'c1',
        });
      }
      return 'done';
    });

    await expect(withSlotRetry('wrun_test', log, op)).resolves.toBe('done');
    expect(claimed).toEqual([slotEventId(2), slotEventId(4)]);
    expect(log.events).toHaveLength(3);
    expect(log.cursor).toBe('c1');
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('tops the delta up from the backend when it was truncated', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    eventsListMock.mockResolvedValueOnce({
      data: [slotEvent(3)],
      cursor: 'c2',
      hasMore: false,
    });
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new SlotConflictError('taken', {
          eventId: slotEventId(2),
          events: [slotEvent(2)],
          cursor: 'c1',
          hasMore: true,
        });
      }
      return 'done';
    });

    await expect(withSlotRetry('wrun_test', log, op)).resolves.toBe('done');
    expect(eventsListMock).toHaveBeenCalledTimes(1);
    expect(log.maxSlot).toBe(3);
    expect(op).toHaveBeenLastCalledWith({
      eventId: slotEventId(4),
      maxSlot: 3,
    });
  });

  it('falls back to a full incremental load when the rejection carried no delta', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    eventsListMock.mockResolvedValueOnce({
      data: [slotEvent(2)],
      cursor: 'c1',
      hasMore: false,
    });
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new SlotConflictError('taken', { eventId: slotEventId(2) });
      }
      return 'done';
    });

    await expect(withSlotRetry('wrun_test', log, op)).resolves.toBe('done');
    expect(eventsListMock).toHaveBeenCalledTimes(1);
    expect(op).toHaveBeenLastCalledWith({
      eventId: slotEventId(3),
      maxSlot: 2,
    });
  });

  it('rethrows the conflict once the reclaim budget is spent', async () => {
    // Escaping to a fresh replay is the correct fallback, not a failure mode:
    // the merged events can change what the workflow body decides, and only a
    // replay from the top can act on that.
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    eventsListMock.mockResolvedValue({
      data: [],
      cursor: 'c1',
      hasMore: false,
    });
    const op = vi.fn(async ({ eventId }: { eventId?: string }) => {
      throw new SlotConflictError('taken', { eventId: eventId as string });
    });

    await expect(withSlotRetry('wrun_test', log, op)).rejects.toBeInstanceOf(
      SlotConflictError
    );
    expect(op).toHaveBeenCalledTimes(PRECONDITION_MAX_RELOAD_RETRIES + 1);
    expect(eventsListMock).toHaveBeenCalledTimes(
      PRECONDITION_MAX_RELOAD_RETRIES
    );
  });

  it('rethrows a non-conflict error immediately, without merging', async () => {
    const log = toMutableEventLog([slotEvent(1)], 'c0');
    const op = vi.fn(async () => {
      throw new PreconditionFailedError('stale');
    });

    await expect(withSlotRetry('wrun_test', log, op)).rejects.toBeInstanceOf(
      PreconditionFailedError
    );
    expect(op).toHaveBeenCalledTimes(1);
    expect(eventsListMock).not.toHaveBeenCalled();
  });
});

describe('withEventCreateFence', () => {
  beforeEach(() => {
    eventsListMock.mockReset();
  });

  it('fences a slot-numbered run by event id and retries its 409s', async () => {
    const log = toMutableEventLog([makeEvent(slotEventId(1))], 'c0');
    let attempts = 0;
    const op = vi.fn(async ({ eventId }: { eventId?: string }) => {
      attempts++;
      if (attempts === 1) {
        throw new SlotConflictError('taken', {
          eventId: eventId as string,
          events: [makeEvent(slotEventId(2))],
          cursor: 'c1',
        });
      }
      return 'done';
    });

    await expect(
      withEventCreateFence('wrun_test', log, SPEC_VERSION_SLOT_IDENTITY, op)
    ).resolves.toBe('done');
    expect(op).toHaveBeenLastCalledWith({
      eventId: slotEventId(3),
      maxSlot: 2,
    });
  });

  it('fences a ULID-numbered run by watermark and retries its 412s', async () => {
    const time = 1_700_000_000_000;
    const log = toMutableEventLog([makeUlidEvent(time)], 'c0');
    eventsListMock.mockResolvedValueOnce({
      data: [makeUlidEvent(time + 1000)],
      cursor: 'c1',
      hasMore: false,
    });
    let attempts = 0;
    const op = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        throw new PreconditionFailedError('stale');
      }
      return 'done';
    });

    await expect(
      withEventCreateFence('wrun_test', log, SPEC_VERSION_SLOT_IDENTITY - 1, op)
    ).resolves.toBe('done');
    expect(op).toHaveBeenLastCalledWith({ stateUpdatedAt: time + 1000 });
    expect(eventsListMock).toHaveBeenCalledTimes(1);
  });
});

describe('withPreconditionRetry', () => {
  let originalGuard: string | undefined;

  beforeEach(() => {
    eventsListMock.mockReset();
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

  it('passes no snapshot to op when the guard is explicitly disabled', async () => {
    process.env.WORKFLOW_PRECONDITION_GUARD = '0';
    const log = toMutableEventLog([makeUlidEvent(1_700_000_000_000)], 'c0');
    const op = vi.fn(async (stateUpdatedAt?: number) => {
      expect(stateUpdatedAt).toBeUndefined();
      return 'ok';
    });

    await expect(withPreconditionRetry('wrun_test', log, op)).resolves.toBe(
      'ok'
    );
    expect(op).toHaveBeenCalledTimes(1);
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('sends a snapshot by default when the guard variable is unset (on by default)', async () => {
    delete process.env.WORKFLOW_PRECONDITION_GUARD;
    const time = 1_700_000_000_000;
    const log = toMutableEventLog([makeUlidEvent(time)], 'c0');
    const op = vi.fn(async (stateUpdatedAt?: number) => {
      expect(stateUpdatedAt).toBe(time);
      return 'ok';
    });

    await expect(withPreconditionRetry('wrun_test', log, op)).resolves.toBe(
      'ok'
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('passes the latest snapshot time to op and returns its result without reloading', async () => {
    const time = 1_700_000_000_000;
    const log = toMutableEventLog([makeUlidEvent(time)], 'c0');
    const op = vi.fn(async (stateUpdatedAt?: number) => {
      expect(stateUpdatedAt).toBe(time);
      return 'ok';
    });

    await expect(withPreconditionRetry('wrun_test', log, op)).resolves.toBe(
      'ok'
    );
    expect(op).toHaveBeenCalledTimes(1);
    expect(eventsListMock).not.toHaveBeenCalled();
  });

  it('reloads the event log and retries on a stale (412) rejection, then succeeds', async () => {
    const log = toMutableEventLog([makeUlidEvent(1_700_000_000_000)], 'c0');
    // Each reload returns one newer event and advances the cursor.
    eventsListMock.mockResolvedValueOnce({
      data: [makeUlidEvent(1_700_000_001_000)],
      cursor: 'c1',
      hasMore: false,
    });
    eventsListMock.mockResolvedValueOnce({
      data: [makeUlidEvent(1_700_000_002_000)],
      cursor: 'c2',
      hasMore: false,
    });

    let calls = 0;
    const op = vi.fn(async () => {
      calls++;
      if (calls <= 2) {
        throw new PreconditionFailedError('stale');
      }
      return 'done';
    });

    await expect(withPreconditionRetry('wrun_test', log, op)).resolves.toBe(
      'done'
    );
    expect(op).toHaveBeenCalledTimes(3);
    // Two reloads merged their events into the shared log and advanced cursor.
    expect(log.events).toHaveLength(3);
    expect(log.cursor).toBe('c2');
  });

  it('rethrows the precondition error after exhausting reload retries', async () => {
    const log = toMutableEventLog([makeUlidEvent(1_700_000_000_000)], 'c0');
    eventsListMock.mockResolvedValue({
      data: [],
      cursor: 'c1',
      hasMore: false,
    });

    const op = vi.fn(async () => {
      throw new PreconditionFailedError('always stale');
    });

    await expect(
      withPreconditionRetry('wrun_test', log, op)
    ).rejects.toBeInstanceOf(PreconditionFailedError);
    // attempts 0,1,2 — two reloads between them, then rethrow on the third.
    expect(op).toHaveBeenCalledTimes(3);
    expect(eventsListMock).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-precondition errors immediately without reloading', async () => {
    const log = toMutableEventLog([makeUlidEvent(1_700_000_000_000)], 'c0');
    const op = vi.fn(async () => {
      throw new Error('boom');
    });

    await expect(withPreconditionRetry('wrun_test', log, op)).rejects.toThrow(
      'boom'
    );
    expect(op).toHaveBeenCalledTimes(1);
    expect(eventsListMock).not.toHaveBeenCalled();
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
