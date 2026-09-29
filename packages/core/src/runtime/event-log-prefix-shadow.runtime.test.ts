import {
  type CreateEventRequest,
  type Event,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import { dehydrateWorkflowArguments } from '../serialization.js';
import type { PrefixShadowMeasurement } from './event-log-prefix-shadow.js';
import {
  PrefixShadowLoad,
  PrefixShadowSession,
  PrefixShadowStore,
  resetEventLogPrefixShadowForTests,
} from './event-log-prefix-shadow.js';
import { setWorld } from './world.js';

const recorded = vi.hoisted(() => [] as PrefixShadowMeasurement[]);

vi.mock('../telemetry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry.js')>()),
  recordEventLogPrefixShadow: vi.fn(async (m: PrefixShadowMeasurement) => {
    recorded.push(m);
  }),
}));

vi.mock('@vercel/functions', () => ({
  waitUntil: vi.fn(),
}));

vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const workflowName = 'workflow';
const workflowCode = (sleepFor: string) => `
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow() {
    await sleep(${JSON.stringify(sleepFor)});
    return "done";
  }
  ;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, workflow]]);
`;

/** Wire size the fake World reports for the frame at `slot`. */
const frameBytes = (slot: number) => 1_000 + slot;

/**
 * A slot-numbered World whose `run_started` preload streams the durable log
 * through `replayEventObserver` with frame sizes, the way world-vercel does.
 * `reportsFrameBytes` toggles the capability the shadow gates on.
 */
async function makeWorld(reportsFrameBytes: boolean, sleepFor: string) {
  const runId = 'wrun_prefix_shadow_runtime';
  const startedAt = new Date('2026-09-28T12:00:00.000Z');
  const input = await dehydrateWorkflowArguments([], runId, undefined);
  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input,
    deploymentId: 'dpl_prefix_shadow',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  const durable: Event[] = [];
  let nextSlot = 1;
  const append = (data: CreateEventRequest): Event => {
    const event = {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(nextSlot++),
      createdAt: new Date(+startedAt + durable.length),
    } as Event;
    durable.push(event);
    return event;
  };
  /** Leave the next slot empty for good: a hole the slot-gap check trips on. */
  const skipSlot = () => {
    nextSlot++;
  };
  append({
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: { deploymentId: 'dpl_prefix_shadow', workflowName, input },
  });

  const writes: string[] = [];
  const create = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: { replayEventObserver?: (e: Event, f?: unknown) => void }
    ) => {
      writes.push(request.eventType);
      if (request.eventType === 'run_started') {
        // Idempotent on a running run, as the server's alreadyRunning branch.
        const runStarted =
          durable.find((e) => e.eventType === 'run_started') ?? append(request);
        for (const event of durable) {
          params?.replayEventObserver?.(
            event,
            reportsFrameBytes
              ? { byteLength: frameBytes(Number(event.eventId.slice(-6))) }
              : undefined
          );
        }
        return {
          event: runStarted,
          run: workflowRun,
          events: [...durable],
          cursor: durable.at(-1)?.eventId ?? null,
          hasMore: false,
        };
      }
      return { event: append(request) };
    }
  );
  const list = vi.fn(async (params: { pagination?: { cursor?: string } }) => {
    const cursor = params.pagination?.cursor;
    const index = cursor ? durable.findIndex((e) => e.eventId === cursor) : -1;
    const data = durable.slice(index + 1);
    return {
      data,
      hasMore: false,
      cursor: data.at(-1)?.eventId ?? cursor ?? null,
    };
  });

  let captured:
    | ((message: unknown, metadata: unknown) => Promise<unknown>)
    | undefined;
  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: reportsFrameBytes ? { replayEventFrameBytes: true } : {},
    createQueueHandler: vi.fn((_prefix, handler) => {
      captured = handler;
      return vi.fn();
    }),
    events: { create, list },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_next' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
  setWorld(world);
  const handler = workflowEntrypoint(workflowCode(sleepFor));
  await handler(new Request('http://localhost', { method: 'POST' }));

  let delivery = 0;
  const deliver = async (atMs: number) => {
    vi.spyOn(Date, 'now').mockReturnValue(atMs);
    await captured?.(
      { runId },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: `msg_${++delivery}`,
        attempt: 1,
      }
    );
  };
  return { deliver, durable, writes, startedAt, append, skipSlot };
}

/** A sleep wake: the first delivery sleeps, the second completes the run. */
async function sleepThenWake(
  reportsFrameBytes: boolean,
  { sleepFor = '2s', wakeAfterMs = 3_000 } = {}
) {
  const world = await makeWorld(reportsFrameBytes, sleepFor);
  const t0 = +world.startedAt + 1_000;
  await world.deliver(t0);
  const afterFirst = PrefixShadowStore.shared().size;
  await world.deliver(t0 + wakeAfterMs);
  return { ...world, afterFirst };
}

describe('event-log prefix shadow in the workflow handler', () => {
  beforeEach(() => {
    recorded.length = 0;
    resetEventLogPrefixShadowForTests();
  });

  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetEventLogPrefixShadowForTests();
  });

  it('measures a wake against the prefix the previous invocation held, then forgets the finished run', async () => {
    vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
    const { afterFirst, durable } = await sleepThenWake(true);

    expect(durable.map((e) => e.eventType)).toEqual([
      'run_created',
      'run_started',
      'wait_created',
      'wait_completed',
      'run_completed',
    ]);
    expect(recorded).toHaveLength(2);
    // First invocation: nothing on this process yet. Its preload held slots
    // 1..2 (run_created, run_started), and so did the replay turn.
    expect(recorded[0]).toMatchObject({
      source: 'run_started',
      outcome: 'miss',
      streamEvents: 2,
      streamBytes: frameBytes(1) + frameBytes(2),
      denseSlots: 2,
    });
    expect(afterFirst).toBe(1);
    // The wake: slots 1..2 were cached, wait_created (3) is the tail.
    expect(recorded[1]).toMatchObject({
      source: 'run_started',
      outcome: 'hit',
      wouldClaim: false,
      cachedSlots: 2,
      streamEvents: 3,
      streamBytes: frameBytes(1) + frameBytes(2) + frameBytes(3),
      wouldSkipBytes: frameBytes(1) + frameBytes(2),
      denseSlots: 3,
    });
    // run_completed was written: a real cache drops the run.
    expect(PrefixShadowStore.shared().size).toBe(0);
  });

  it('reports a wake past the idle TTL as expired', async () => {
    vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
    await sleepThenWake(true, { sleepFor: '1h', wakeAfterMs: 2 * 3_600_000 });
    expect(recorded.map((m) => m.outcome)).toEqual(['miss', 'expired']);
  });

  it('changes nothing the run does', async () => {
    const off = await sleepThenWake(true);
    expect(recorded).toHaveLength(0);
    setWorld(undefined);
    vi.restoreAllMocks();

    vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
    const on = await sleepThenWake(true);
    expect(recorded).toHaveLength(2);
    expect(on.writes).toEqual(off.writes);
    expect(
      on.durable.map(({ eventId, eventType }) => [eventId, eventType])
    ).toEqual(
      off.durable.map(({ eventId, eventType }) => [eventId, eventType])
    );
  });

  /**
   * The shadow's one hard rule: with it on, a bug in the measurement costs the
   * measurement and nothing else. Each case below makes one guarded entry
   * point throw inside the real handler and asserts the run's writes and
   * durable log are exactly the flag-off run's. Remove the try/catch around
   * the entry point and the handler throws instead (checked by mutation).
   */
  describe('a throwing measurement', () => {
    async function flagOffBaseline() {
      const off = await sleepThenWake(true);
      expect(recorded).toHaveLength(0);
      setWorld(undefined);
      vi.restoreAllMocks();
      return off;
    }

    async function expectSameRunWith(
      off: Awaited<ReturnType<typeof sleepThenWake>>,
      breakShadow: () => void
    ) {
      vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
      breakShadow();
      const on = await sleepThenWake(true);
      expect(on.durable.at(-1)?.eventType).toBe('run_completed');
      expect(on.writes).toEqual(off.writes);
      expect(
        on.durable.map(({ eventId, eventType }) => [eventId, eventType])
      ).toEqual(
        off.durable.map(({ eventId, eventType }) => [eventId, eventType])
      );
      return on;
    }

    it('in conclude does not fail the preload', async () => {
      const off = await flagOffBaseline();
      const finish = vi
        .spyOn(PrefixShadowLoad.prototype, 'finish')
        .mockImplementation(() => {
          throw new Error('shadow finish bug');
        });
      await expectSameRunWith(off, () => {});
      expect(finish).toHaveBeenCalled();
      // Nothing concluded, so nothing emitted.
      expect(recorded).toHaveLength(0);
    });

    it('in the fill does not fail the preload or the replay turn', async () => {
      const off = await flagOffBaseline();
      const fill = vi
        .spyOn(PrefixShadowStore.prototype, 'fill')
        .mockImplementation(() => {
          throw new Error('shadow fill bug');
        });
      await expectSameRunWith(off, () => {});
      // Reached from the preload's conclude and from the replay loop's
      // tryRecordLog, both guarded.
      expect(fill.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('in the observer does not become a ReplayEventObserverError', async () => {
      const off = await flagOffBaseline();
      const observe = vi
        .spyOn(PrefixShadowLoad.prototype, 'observe')
        .mockImplementation(() => {
          throw new Error('shadow observe bug');
        });
      await expectSameRunWith(off, () => {});
      expect(observe).toHaveBeenCalled();
      // A broken load stops measuring rather than reporting nonsense.
      expect(recorded).toHaveLength(0);
    });

    it('in an eviction does not fail the write that triggered it', async () => {
      const off = await flagOffBaseline();
      const evict = vi
        .spyOn(PrefixShadowStore.prototype, 'evict')
        .mockImplementation(() => {
          throw new Error('shadow evict bug');
        });
      await expectSameRunWith(off, () => {});
      // The run_completed write's noteWrite, at least.
      expect(evict).toHaveBeenCalled();
    });
  });

  it('forgets a run the moment its log trips the slot-gap check', async () => {
    vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
    const world = await makeWorld(true, '2s');
    const t0 = +world.startedAt + 1_000;
    await world.deliver(t0);
    expect(PrefixShadowStore.shared().size).toBe(1);

    // A permanent hole at slot 4 under a later event.
    world.skipSlot();
    world.append({
      eventType: 'wait_completed',
      correlationId: world.durable[2]?.correlationId,
    } as CreateEventRequest);

    // Snapshot the writes at each session eviction (not the store's own
    // evict, which a refill also calls to replace the old entry): the
    // tripwire's must come before any terminal write, whose own noteWrite
    // would evict anyway and so would hide a missing tripwire eviction.
    const writesAtEvict: string[][] = [];
    const original = PrefixShadowSession.prototype.evict;
    vi.spyOn(PrefixShadowSession.prototype, 'evict').mockImplementation(
      function (this: PrefixShadowSession) {
        writesAtEvict.push([...world.writes]);
        return original.call(this);
      }
    );
    await world.deliver(t0 + 3_000).catch(() => {});

    expect(writesAtEvict.length).toBeGreaterThan(0);
    expect(writesAtEvict[0]).not.toContain('run_failed');
    expect(writesAtEvict[0]).not.toContain('run_completed');
    expect(PrefixShadowStore.shared().size).toBe(0);
  });

  it('records nothing for a World that does not report frame sizes', async () => {
    vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_SHADOW', '1');
    const { afterFirst, durable } = await sleepThenWake(false);
    expect(durable.at(-1)?.eventType).toBe('run_completed');
    expect(recorded).toHaveLength(0);
    expect(afterFirst).toBe(0);
  });
});
