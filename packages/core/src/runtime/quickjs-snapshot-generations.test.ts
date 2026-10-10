/**
 * Drives the real QuickJS engine entrypoint through many snapshot
 * save/restore generations against an in-memory World with slot-numbered
 * events, cursored listings and inline deltas on writes (so some events
 * reach the VM from write responses rather than listings), then checks the
 * run against the event log it wrote:
 *
 * - `MaxEventsExceededError` fires exactly when the log reaches the limit,
 *   not earlier. A persisted cursor that lags the persisted event count
 *   makes every restore count the lagging span twice, which compounds with
 *   each generation.
 * - Snapshots are actually restored, and each saved cursor covers exactly
 *   the event count saved with it.
 * - Runs at different thresholds (including with an older snapshot landing
 *   after a newer one) write the same log and result as a run without
 *   snapshots, and leave no snapshot behind once they finish.
 */

import { waitUntil } from '@vercel/functions';
import { MaxEventsExceededError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  eventIdToSlot,
  type SnapshotMetadata,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decrypt, deriveRunPayloadKeys } from '../serialization/encryption.js';
import { deserialize, serialize } from '../serialization/workflow-vm.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('./get-port-lazy.js', () => ({
  getPortLazy: vi.fn().mockResolvedValue(3000),
}));

const runId = 'wrun_01JXT21Q00SNAPSHOTGENERATE';
const workflowName = 'workflow//test//workflow';
const rawKey = new Uint8Array(32).fill(5);

// One hook per iteration: each invocation creates a hook (its
// `hook_created` comes back as an inline delta on the write) and suspends
// until the test delivers that hook's payload.
const hookWorkflow = (hooks: number) => `
  async function workflow() {
    var createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
    var total = 0;
    for (var i = 0; i < ${hooks}; i++) {
      var hook = createHook({ token: "tok-" + i });
      var payload = await hook;
      total += payload.n;
    }
    return total;
  }
  workflow.workflowId = "${workflowName}";
  globalThis.__private_workflows.set("${workflowName}", workflow);
`;

function makeWorld(snapshotThreshold = 1) {
  const startedAt = new Date('2025-01-01T00:00:00Z');
  const run: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input: [],
    deploymentId: 'dpl_generations',
    specVersion: SPEC_VERSION_CURRENT,
    executionContext: { workflowVm: 'quickjs', snapshotThreshold },
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  } as WorkflowRun;
  const log: Event[] = [];
  let clock = +startedAt;
  const append = (data: Record<string, unknown>): Event => {
    clock += 1000;
    const event = {
      specVersion: SPEC_VERSION_CURRENT,
      ...data,
      runId,
      eventId: slotToEventId(log.length + 1),
      createdAt: new Date(clock),
    } as Event;
    log.push(event);
    return event;
  };
  const after = (cursor: string | null | undefined) =>
    cursor ? log.slice(eventIdToSlot(cursor) ?? 0) : log.slice();

  append({
    eventType: 'run_created',
    eventData: {
      deploymentId: run.deploymentId,
      workflowName,
      input: serialize([]),
    },
  });
  append({ eventType: 'run_started' });

  const snapshots = new Map<
    string,
    { data: Uint8Array; metadata: SnapshotMetadata }
  >();
  const saves: SnapshotMetadata[] = [];
  const loads: (SnapshotMetadata | null)[] = [];
  // `holdNext`: the next save to start waits for `release()` before
  // landing; `held` resolves once it has started waiting.
  const control: {
    holdNext?: boolean;
    held?: Promise<void>;
    release?: () => void;
  } = {};
  const holdNextSave = () => {
    let started!: () => void;
    control.held = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      control.release = resolve;
    });
    control.holdNext = true;
    return { started, gate };
  };
  let pendingHold: ReturnType<typeof holdNextSave> | undefined;

  const world = {
    specVersion: SPEC_VERSION_CURRENT,
    capabilities: {},
    events: {
      list: vi.fn(
        async (params: { pagination?: { cursor?: string | null } }) => {
          const data = after(params.pagination?.cursor);
          return {
            data,
            cursor: data.length > 0 ? data[data.length - 1].eventId : null,
            hasMore: false,
          };
        }
      ),
      create: vi.fn(
        async (
          _runId: string,
          request: CreateEventRequest,
          params?: CreateEventParams
        ) => {
          const event = append(request as unknown as Record<string, unknown>);
          if (typeof params?.sinceCursor === 'string') {
            const delta = after(params.sinceCursor);
            return {
              event,
              events: delta,
              cursor: delta[delta.length - 1].eventId,
              hasMore: false,
            };
          }
          return { event };
        }
      ),
    },
    runs: { get: vi.fn(async () => run) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(rawKey),
    experimental_snapshots: {
      save: vi.fn(
        async (id: string, data: Uint8Array, metadata: SnapshotMetadata) => {
          if (control.holdNext && pendingHold) {
            control.holdNext = false;
            const { started, gate } = pendingHold;
            pendingHold = undefined;
            started();
            await gate;
          }
          snapshots.set(id, { data, metadata });
          saves.push(metadata);
        }
      ),
      load: vi.fn(async (id: string) => {
        const stored = snapshots.get(id) ?? null;
        loads.push(stored?.metadata ?? null);
        return stored;
      }),
      delete: vi.fn(async (id: string) => {
        snapshots.delete(id);
      }),
    },
  } as unknown as World;
  return {
    world,
    run,
    log,
    append,
    saves,
    loads,
    snapshots,
    control,
    holdNextSave: () => {
      pendingHold = holdNextSave();
    },
  };
}

/** Let the `waitUntil` promises (snapshot saves and deletes) start. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Wait for the `waitUntil` promises (snapshot saves and deletes) to settle,
 * skipping the first `from` (a held save).
 */
async function flushWaitUntil(from = 0) {
  await settle();
  await Promise.all(
    vi
      .mocked(waitUntil)
      .mock.calls.slice(from)
      .map(([promise]) => promise)
  );
}

/**
 * What the queue handler hands an invocation: the whole log as a complete
 * preload (what its setup request returns) and the snapshot read it started
 * at entry, if any.
 */
function preloadParams(
  log: Event[],
  snapshotPrefetch: Promise<unknown> | undefined
) {
  return {
    preloadedEvents: log.slice(),
    preloadedEventsComplete: true,
    preloadedCursor: log[log.length - 1].eventId,
    snapshotPrefetch: snapshotPrefetch as
      | Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null>
      | undefined,
  };
}

/**
 * How many of an invocation's `events.list` calls loaded its log: those
 * before its first write. (Later ones are the inline loop looking for new
 * events.)
 */
function listCallsBeforeFirstWrite(
  listOrders: number[],
  createOrders: number[]
): number {
  const firstWrite = createOrders[0] ?? Number.POSITIVE_INFINITY;
  return listOrders.filter((order) => order < firstWrite).length;
}

/**
 * Run the hook workflow to completion, delivering each hook's payload
 * after the invocation that created it. With `holdSaveAt`, the save of
 * that invocation is held until after the NEXT invocation's save lands, so
 * an older snapshot overwrites a newer one.
 */
async function runToCompletion(options: {
  threshold: number;
  hooks: number;
  holdSaveAt?: number;
  /**
   * Hand each invocation the whole log as a complete preload (what the
   * queue handler's setup request returns) and the snapshot read the
   * handler would have started at entry.
   */
  preload?: boolean;
}) {
  const env = makeWorld(options.threshold);
  setWorld(env.world);
  const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
  const { prefetchQuickJSSnapshot } = await import(
    './quickjs-snapshot-resume.js'
  );
  let heldFrom: number | undefined;
  let prefetches = 0;
  let initialLoadListCalls = 0;
  const listMock = vi.mocked(env.world.events.list).mock;
  const createMock = vi.mocked(env.world.events.create).mock;
  for (let invocation = 0; invocation < options.hooks + 5; invocation++) {
    if (invocation === options.holdSaveAt) env.holdNextSave();
    const listsBefore = listMock.invocationCallOrder.length;
    const createsBefore = createMock.invocationCallOrder.length;
    const preload = options.preload
      ? preloadParams(env.log, prefetchQuickJSSnapshot(env.world, runId))
      : undefined;
    if (preload?.snapshotPrefetch) prefetches++;
    await runWorkflowWithQuickJS({
      workflowCode: hookWorkflow(options.hooks),
      workflowName,
      workflowRun: env.run,
      ...preload,
    });
    initialLoadListCalls += listCallsBeforeFirstWrite(
      listMock.invocationCallOrder.slice(listsBefore),
      createMock.invocationCallOrder.slice(createsBefore)
    );
    if (invocation === options.holdSaveAt) {
      // This invocation's save is now blocked; later ones go through.
      await env.control.held;
      heldFrom = vi.mocked(waitUntil).mock.calls.length;
    } else if (heldFrom !== undefined) {
      await flushWaitUntil(heldFrom);
      // The held (older) save lands after this newer one.
      env.control.release?.();
      heldFrom = undefined;
      await flushWaitUntil();
    } else {
      await flushWaitUntil();
    }
    if (env.log.some((e) => e.eventType === 'run_completed')) break;
    const hook = env.log.findLast((e) => e.eventType === 'hook_created');
    env.append({
      eventType: 'hook_received',
      correlationId: hook?.correlationId,
      eventData: { payload: { n: 2 } },
    });
  }
  await flushWaitUntil();
  const completed = env.log.find((e) => e.eventType === 'run_completed');
  expect(completed).toBeDefined();
  const output = (completed as { eventData: { output: Uint8Array } }).eventData
    .output;
  const result = deserialize(
    (await decrypt(output, await deriveRunPayloadKeys(rawKey))) as Uint8Array
  );
  return {
    result,
    // The log's shape: event types and correlation ids in order.
    shape: env.log.map((e) => `${e.eventType}:${e.correlationId ?? ''}`),
    saves: env.saves,
    restores: env.loads.filter(Boolean).length,
    loads: env.loads.length,
    prefetches,
    initialLoadListCalls,
    snapshotsLeft: env.snapshots.size,
  };
}

describe('QuickJS snapshots across many generations', () => {
  beforeEach(async () => {
    const { __resetSnapshotLatchesForTests } = await import(
      './quickjs-entrypoint.js'
    );
    __resetSnapshotLatchesForTests();
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('enforces the event limit exactly and saves cursors that match their event counts', async () => {
    const { world, run, log, append, saves, loads } = makeWorld();
    const workflowCode = hookWorkflow(1000);
    setWorld(world);
    const { runWorkflowWithQuickJS } = await import('./quickjs-entrypoint.js');
    const maxEventsLimit = 40;

    let exceeded: unknown;
    for (let invocation = 0; invocation < 100; invocation++) {
      const logLength = log.length;
      try {
        await runWorkflowWithQuickJS({
          workflowCode,
          workflowName,
          workflowRun: run,
          maxEventsLimit,
        });
      } catch (err) {
        exceeded = err;
      }
      await flushWaitUntil();
      if (exceeded) {
        expect(exceeded).toBeInstanceOf(MaxEventsExceededError);
        // Only once the log really reached the limit.
        expect(logLength).toBeGreaterThanOrEqual(maxEventsLimit);
        break;
      }
      // Deliver the payload for the hook this invocation created.
      const hook = log.findLast((e) => e.eventType === 'hook_created');
      expect(hook).toBeDefined();
      append({
        eventType: 'hook_received',
        correlationId: hook?.correlationId,
        eventData: { payload: { n: 1 } },
      });
    }
    expect(exceeded).toBeDefined();

    // Snapshots were really used, not just written.
    expect(loads.filter(Boolean).length).toBeGreaterThan(5);
    expect(saves.length).toBeGreaterThan(5);
    // Every saved cursor covers exactly the events counted with it.
    for (const saved of saves) {
      expect(eventIdToSlot(saved.eventsCursor as string)).toBe(
        saved.eventCount
      );
    }
  });

  it('writes the same log and result at any threshold, and cleans up', async () => {
    const hooks = 12;
    const baseline = await runToCompletion({ threshold: 0, hooks });
    expect(baseline.result).toBe(2 * hooks);
    expect(baseline.saves).toHaveLength(0);

    for (const threshold of [1, 3, 4, 1000]) {
      vi.clearAllMocks();
      const outcome = await runToCompletion({ threshold, hooks });
      expect(outcome.result, `threshold ${threshold}`).toBe(baseline.result);
      expect(outcome.shape, `threshold ${threshold}`).toEqual(baseline.shape);
      expect(outcome.snapshotsLeft, `threshold ${threshold}`).toBe(0);
      if (threshold === 1000) {
        expect(outcome.saves).toHaveLength(0);
      } else {
        expect(outcome.restores).toBeGreaterThan(0);
      }
      for (const saved of outcome.saves) {
        expect(eventIdToSlot(saved.eventsCursor as string)).toBe(
          saved.eventCount
        );
      }
    }
  });

  it('restores from a preload and a prefetched snapshot without listing the log again', async () => {
    const hooks = 12;
    const baseline = await runToCompletion({ threshold: 0, hooks });
    for (const threshold of [1, 3]) {
      vi.clearAllMocks();
      const listed = await runToCompletion({ threshold, hooks });
      vi.clearAllMocks();
      const preloaded = await runToCompletion({
        threshold,
        hooks,
        preload: true,
      });
      expect(preloaded.result, `threshold ${threshold}`).toBe(baseline.result);
      expect(preloaded.shape, `threshold ${threshold}`).toEqual(baseline.shape);
      expect(preloaded.snapshotsLeft, `threshold ${threshold}`).toBe(0);
      expect(preloaded.restores, `threshold ${threshold}`).toBeGreaterThan(0);
      // Every snapshot read the engine made was the one started ahead of it.
      expect(preloaded.prefetches, `threshold ${threshold}`).toBeGreaterThan(0);
      expect(preloaded.loads, `threshold ${threshold}`).toBe(
        preloaded.prefetches
      );
      // Without the preload, every invocation lists its log to load it (a
      // restore lists its delta); with it, none does, restores included.
      expect(
        listed.initialLoadListCalls,
        `threshold ${threshold}`
      ).toBeGreaterThanOrEqual(listed.loads);
      expect(preloaded.initialLoadListCalls, `threshold ${threshold}`).toBe(0);
    }
  });

  it('converges with a preload when an older snapshot lands after a newer one', async () => {
    const hooks = 10;
    const baseline = await runToCompletion({ threshold: 0, hooks });
    vi.clearAllMocks();
    const outcome = await runToCompletion({
      threshold: 1,
      hooks,
      holdSaveAt: 4,
      preload: true,
    });
    const counts = outcome.saves.map((saved) => saved.eventCount as number);
    expect(counts.some((count, i) => i > 0 && count < counts[i - 1])).toBe(
      true
    );
    expect(outcome.result).toBe(baseline.result);
    expect(outcome.shape).toEqual(baseline.shape);
    expect(outcome.snapshotsLeft).toBe(0);
  });

  it('converges when an older snapshot lands after a newer one', async () => {
    const hooks = 10;
    const baseline = await runToCompletion({ threshold: 0, hooks });
    vi.clearAllMocks();
    const outcome = await runToCompletion({
      threshold: 1,
      hooks,
      holdSaveAt: 4,
    });
    // The held save really did land after a newer one.
    const counts = outcome.saves.map((saved) => saved.eventCount as number);
    expect(counts.some((count, i) => i > 0 && count < counts[i - 1])).toBe(
      true
    );
    expect(outcome.result).toBe(baseline.result);
    expect(outcome.shape).toEqual(baseline.shape);
    expect(outcome.snapshotsLeft).toBe(0);
  });
});
