import { PreconditionFailedError, WorkflowWorldError } from '@workflow/errors';
import type { Event, World } from '@workflow/world';
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
  getWorkflowQueueName,
  handleHealthCheckMessage,
  healthCheck,
  latestEventStateUpdatedAt,
  loadWorkflowRunEvents,
  memoizeEncryptionKey,
  mergeEvents,
  preconditionEventDelta,
  preconditionSnapshotParams,
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

describe('mergeEvents', () => {
  it('appends in order without reordering and without warning', async () => {
    const { runtimeLogger } = await import('../logger.js');
    vi.mocked(runtimeLogger.warn).mockClear();
    const first = makeUlidEvent(1_700_000_000_000);
    const second = makeUlidEvent(1_700_000_001_000);
    const third = makeUlidEvent(1_700_000_002_000);
    const target = [first];

    mergeEvents(target, [second, third]);

    expect(target.map((e) => e.eventId)).toEqual([
      first.eventId,
      second.eventId,
      third.eventId,
    ]);
    expect(runtimeLogger.warn).not.toHaveBeenCalled();
  });

  it('re-sorts to canonical order and warns when an append lands out of order', async () => {
    const { runtimeLogger } = await import('../logger.js');
    vi.mocked(runtimeLogger.warn).mockClear();
    const older = makeUlidEvent(1_700_000_000_000);
    const newer = makeUlidEvent(1_700_000_002_000);
    const middle = makeUlidEvent(1_700_000_001_000);
    const target = [older, newer];

    mergeEvents(target, [middle]);

    expect(target.map((e) => e.eventId)).toEqual([
      older.eventId,
      middle.eventId,
      newer.eventId,
    ]);
    expect(runtimeLogger.warn).toHaveBeenCalledWith(
      'Event log merged out of order; re-sorted by eventId',
      expect.objectContaining({ eventCount: 3 })
    );
  });

  it('deduplicates by event id', () => {
    const first = makeUlidEvent(1_700_000_000_000);
    const second = makeUlidEvent(1_700_000_001_000);
    const target = [first];

    mergeEvents(target, [first, second, second]);

    expect(target.map((e) => e.eventId)).toEqual([
      first.eventId,
      second.eventId,
    ]);
  });

  it('orders a same-millisecond pair by its random component', () => {
    // Event ids are unprefixed 26-char ULIDs, so lexicographic id order is
    // canonical backend order even inside one millisecond — which is what
    // makes re-sorting safe.
    const time = 1_700_000_000_000;
    const a = makeEvent(`evnt_${ulid(time).slice(0, 10)}AAAAAAAAAAAAAAAA`);
    const b = makeEvent(`evnt_${ulid(time).slice(0, 10)}ZZZZZZZZZZZZZZZZ`);
    const target = [b];

    mergeEvents(target, [a]);

    expect(target.map((e) => e.eventId)).toEqual([a.eventId, b.eventId]);
  });

  it('reports the maximum ULID time as the watermark after an out-of-order merge', () => {
    // The direct link between the sort and the snapshot's correctness: the
    // watermark is read off the tail, so an unsorted tail would understate it
    // while the count still covered every loaded event.
    const time = 1_700_000_002_000;
    const target = [makeUlidEvent(1_700_000_000_000), makeUlidEvent(time)];

    mergeEvents(target, [makeUlidEvent(1_700_000_001_000)]);

    expect(latestEventStateUpdatedAt(target)).toBe(time);
  });
});

describe('preconditionEventDelta', () => {
  const delta = (details: unknown) =>
    preconditionEventDelta(new PreconditionFailedError('stale', { details }));

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
    expect(preconditionEventDelta(new PreconditionFailedError('stale'))).toBe(
      null
    );
  });

  it('returns null for a non-precondition error', () => {
    expect(preconditionEventDelta(new Error('boom'))).toBe(null);
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
