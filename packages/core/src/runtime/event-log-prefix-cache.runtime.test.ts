/**
 * The cross-invocation prefix cache in the real workflow handler.
 *
 * Every scenario runs twice against a fake slot-numbered World: once with
 * `WORKFLOW_EVENT_LOG_PREFIX_CACHE` off (today's full preload on every wake)
 * and once with it on. The World honors an offered prefix the way
 * world-vercel composes an honored claim (prefix events, then the tail), and
 * it ASSERTS that every offered prefix is exactly the durable slots `1..N`,
 * payloads included, so a fill-rule bug fails loudly instead of replaying a
 * wrong log. Equivalence is the model's `LoadMatchesFull` seen from outside:
 * the cached run makes the same writes and leaves the same durable log as the
 * cold one.
 */
import { EntityConflictError, RunExpiredError } from '@workflow/errors';
import {
  type CreateEventParams,
  type CreateEventRequest,
  type Event,
  isTerminalRunEventType,
  SPEC_VERSION_CURRENT,
  slotToEventId,
  type WorkflowRun,
  type World,
} from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workflowEntrypoint } from '../runtime.js';
import {
  dehydrateStepReturnValue,
  dehydrateWorkflowArguments,
} from '../serialization.js';
import { EventLogPrefixCache } from './event-log-prefix-cache.js';
import { setWorld } from './world.js';

vi.mock('@vercel/functions', () => ({ waitUntil: vi.fn() }));
vi.mock('@workflow/utils/get-port', () => ({
  getPort: vi.fn().mockResolvedValue(3000),
}));

const workflowName = 'workflow';
const runId = 'wrun_prefix_cache_runtime';
const hookToken = 'prefix-cache-token';

/**
 * A session-shaped workflow: wait for a message on a hook, sleep, repeat,
 * then return everything it saw. Every turn is a wake of the same run, the
 * way an eve session is.
 */
const WORKFLOW = `
  const createHook = globalThis[Symbol.for("WORKFLOW_CREATE_HOOK")];
  const sleep = globalThis[Symbol.for("WORKFLOW_SLEEP")];
  async function workflow(token) {
    const hook = createHook({ token });
    const seen = [];
    for await (const payload of hook) {
      seen.push(payload.value);
      await sleep("1s");
      if (seen.length === 3) break;
    }
    return seen.join(",");
  }
  ;globalThis.__private_workflows = new Map([[${JSON.stringify(workflowName)}, workflow]]);
`;

type ClaimMode = 'honor' | 'refuse' | 'unsupported';

interface PreloadRecord {
  eventType: string;
  offered: number | undefined;
  honored: boolean;
}

async function makeWorld(cacheOn: boolean, mode: ClaimMode = 'honor') {
  vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_CACHE', cacheOn ? '1' : '0');
  vi.stubEnv('WORKFLOW_EVENT_LOG_PREFIX_CACHE_MIN_BYTES', '0');
  const startedAt = new Date('2026-10-01T12:00:00.000Z');
  const input = await dehydrateWorkflowArguments([hookToken], runId, undefined);
  const workflowRun: WorkflowRun = {
    runId,
    workflowName,
    status: 'running',
    input,
    deploymentId: 'dpl_prefix_cache',
    specVersion: SPEC_VERSION_CURRENT,
    startedAt,
    createdAt: startedAt,
    updatedAt: startedAt,
  };

  const durable: Event[] = [];
  const append = (
    data: CreateEventRequest,
    extra: Partial<Event> = {}
  ): Event => {
    const slot = durable.length + 1;
    const event = {
      ...data,
      specVersion: data.specVersion ?? SPEC_VERSION_CURRENT,
      runId,
      eventId: slotToEventId(slot),
      createdAt: new Date(+startedAt + slot),
      ...extra,
    } as Event;
    durable.push(event);
    return event;
  };
  append({
    eventType: 'run_created',
    specVersion: SPEC_VERSION_CURRENT,
    eventData: { deploymentId: 'dpl_prefix_cache', workflowName, input },
  });

  const writes: string[] = [];
  const preloads: PreloadRecord[] = [];
  const offeredArrays: (readonly Event[])[] = [];

  /**
   * The full log, or the offered prefix plus the tail: what world-vercel
   * hands back for a full / honored load. Every offered prefix must be the
   * durable log's slots 1..N exactly.
   */
  const replayLog = (
    eventType: string,
    params: CreateEventParams | undefined
  ) => {
    const prefix = params?.preloadPrefix;
    if (prefix) offeredArrays.push(prefix.events);
    if (prefix) {
      expect(prefix.events.length).toBeLessThanOrEqual(durable.length);
      expect(prefix.events).toEqual(durable.slice(0, prefix.events.length));
    }
    const honored = prefix !== undefined && mode === 'honor';
    preloads.push({
      eventType,
      offered: prefix?.events.length,
      honored,
    });
    const events = honored
      ? [...prefix.events, ...durable.slice(prefix.events.length)]
      : [...durable];
    for (const event of events) params?.replayEventObserver?.(event);
    return {
      events,
      cursor: durable.at(-1)?.eventId ?? null,
      hasMore: false,
      maxEvents: 25_000,
      ...(honored ? { preloadBase: prefix.events.length } : {}),
    };
  };

  const terminal = () =>
    durable.some((event) => isTerminalRunEventType(event.eventType));

  const runStarted = (
    request: CreateEventRequest,
    params: CreateEventParams | undefined
  ) => {
    if (terminal()) throw new RunExpiredError(runId);
    const event =
      durable.find((e) => e.eventType === 'run_started') ?? append(request);
    return {
      event,
      run: workflowRun,
      ...replayLog('run_started', params),
    };
  };
  const hookReceived = (
    request: CreateEventRequest,
    params: CreateEventParams | undefined
  ) => {
    const canonical =
      durable.find(
        (e) =>
          e.eventType === 'hook_received' &&
          (e as { resumeId?: string }).resumeId === params?.resumeId
      ) ?? append(request, { resumeId: params?.resumeId } as Partial<Event>);
    if (params?.preloadEvents !== true) return { event: canonical };
    return {
      event: canonical,
      run: workflowRun,
      ...replayLog('hook_received', params),
    };
  };
  /** Duplicate wait completions and terminal writes conflict, as on a server. */
  const conflicts = (request: CreateEventRequest) => {
    const correlationId = (request as { correlationId?: string }).correlationId;
    return (
      (request.eventType === 'wait_completed' &&
        durable.some(
          (e) =>
            e.eventType === 'wait_completed' &&
            e.correlationId === correlationId
        )) ||
      (isTerminalRunEventType(request.eventType) && terminal())
    );
  };

  const create = vi.fn(
    async (
      _runId: string,
      request: CreateEventRequest,
      params?: CreateEventParams
    ) => {
      writes.push(
        `${request.eventType}:${(request as { correlationId?: string }).correlationId ?? ''}`
      );
      if (request.eventType === 'run_started') {
        return runStarted(request, params);
      }
      if (request.eventType === 'hook_received') {
        return hookReceived(request, params);
      }
      if (conflicts(request)) {
        throw new EntityConflictError(`${request.eventType} already exists`);
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
    capabilities: mode === 'unsupported' ? {} : { eventLogPrefixPreload: true },
    createQueueHandler: vi.fn((_prefix, handler) => {
      captured = handler;
      return vi.fn();
    }),
    events: { create, list },
    runs: { get: vi.fn(async () => workflowRun) },
    queue: vi.fn().mockResolvedValue({ messageId: 'msg_next' }),
    getEncryptionKeyForRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as World;
  setWorld(world);
  const handler = workflowEntrypoint(WORKFLOW);
  await handler(new Request('http://localhost', { method: 'POST' }));

  let messages = 0;
  const clock = { now: +startedAt + 100 };
  const deliver = async (message: Record<string, unknown> = {}) => {
    vi.spyOn(Date, 'now').mockReturnValue(clock.now);
    await captured?.(
      { runId, ...message },
      {
        queueName: `__wkf_workflow_${workflowName}`,
        messageId: `msg_${++messages}`,
        attempt: 1,
      }
    );
  };
  const hookId = () => {
    const created = durable.find((e) => e.eventType === 'hook_created');
    expect(created?.correlationId).toBeDefined();
    return created?.correlationId as string;
  };
  const payload = (value: string) =>
    dehydrateStepReturnValue({ value }, runId, undefined);
  /** A resume another process committed while no invocation was running. */
  const resumeOutOfBand = async (value: string) => {
    append({
      eventType: 'hook_received',
      specVersion: SPEC_VERSION_CURRENT,
      correlationId: hookId(),
      eventData: { token: hookToken, payload: await payload(value) },
    } as CreateEventRequest);
  };
  /** A lazy resume: the queue consumer writes hook_received with a preload. */
  const lazyResume = async (value: string) => {
    await deliver({
      hookInput: {
        hookId: hookId(),
        resumeId: `resume-${value}`,
        token: hookToken,
        payload: await payload(value),
        payloadDigest: 'e'.repeat(64),
      },
    });
  };
  const advance = (ms: number) => {
    clock.now += ms;
  };
  return {
    deliver,
    lazyResume,
    resumeOutOfBand,
    advance,
    append,
    durable,
    writes,
    preloads,
    offeredArrays,
  };
}

type Harness = Awaited<ReturnType<typeof makeWorld>>;

/** Comparable view of a durable log. */
function normalize(events: readonly Event[]) {
  return events.map((event) => ({
    eventId: event.eventId,
    eventType: event.eventType,
    correlationId: event.correlationId,
    eventData: (event as { eventData?: unknown }).eventData,
  }));
}

/** A whole session: three resumes (out-of-band, lazy, out-of-band). */
async function session(h: Harness) {
  await h.deliver(); // start: creates the hook and parks on it
  await h.resumeOutOfBand('a');
  h.advance(10);
  await h.deliver(); // hook wake: takes 'a', parks on the sleep
  h.advance(1_500);
  await h.deliver(); // sleep wake: parks on the hook again
  h.advance(10);
  await h.lazyResume('b'); // lazy hook_received preload carries the claim
  h.advance(1_500);
  await h.deliver();
  await h.resumeOutOfBand('c');
  h.advance(10);
  await h.deliver();
  h.advance(1_500);
  await h.deliver(); // completes
}

describe('event-log prefix cache in the workflow handler', () => {
  beforeEach(() => {
    EventLogPrefixCache.shared().clear();
  });

  afterEach(() => {
    setWorld(undefined);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    EventLogPrefixCache.shared().clear();
  });

  async function both(
    scenario: (h: Harness) => Promise<void>,
    mode: ClaimMode = 'honor'
  ) {
    const cold = await makeWorld(false, mode);
    await scenario(cold);
    setWorld(undefined);
    vi.restoreAllMocks();
    EventLogPrefixCache.shared().clear();
    const cached = await makeWorld(true, mode);
    await scenario(cached);
    return { cold, cached };
  }

  it('a whole session makes the same writes and log as the cold path, with every wake claiming', async () => {
    const { cold, cached } = await both(session);

    expect(cold.durable.at(-1)?.eventType).toBe('run_completed');
    expect(cached.writes).toEqual(cold.writes);
    expect(normalize(cached.durable)).toEqual(normalize(cold.durable));

    // Cold: nothing is ever offered.
    expect(cold.preloads.every((p) => p.offered === undefined)).toBe(true);
    // Cached: the first delivery has nothing to offer; every later wake,
    // including the lazy hook_received preload, offers and is honored.
    expect(cached.preloads[0].offered).toBeUndefined();
    const wakes = cached.preloads.slice(1);
    expect(wakes.length).toBeGreaterThanOrEqual(6);
    expect(wakes.every((p) => p.honored)).toBe(true);
    expect(wakes.some((p) => p.eventType === 'hook_received')).toBe(true);
    // The claimed prefix grows with the session.
    const offered = wakes.map((p) => p.offered ?? 0);
    expect(offered).toEqual([...offered].sort((a, b) => a - b));
    // The terminal run evicts its entry.
    expect(EventLogPrefixCache.shared().size).toBe(0);
  });

  it('includes out-of-band events committed between invocations', async () => {
    const { cold, cached } = await both(async (h) => {
      await h.deliver();
      await h.resumeOutOfBand('a');
      // A second resume lands before the run wakes for the first one.
      await h.resumeOutOfBand('b');
      h.advance(10);
      await h.deliver();
      h.advance(1_500);
      await h.deliver();
    });
    expect(cached.writes).toEqual(cold.writes);
    expect(normalize(cached.durable)).toEqual(normalize(cold.durable));
    // The wake after the out-of-band writes claimed only what it held; the
    // two hook_received events came back in the tail.
    const wake = cached.preloads[1];
    expect(wake.honored).toBe(true);
    expect(wake.offered).toBeLessThan(cached.durable.length);
  });

  it('a refused claim degrades to the full load with identical results', async () => {
    const { cold, cached } = await both(session, 'refuse');
    expect(cached.writes).toEqual(cold.writes);
    expect(normalize(cached.durable)).toEqual(normalize(cold.durable));
    expect(cached.preloads.some((p) => p.offered !== undefined)).toBe(true);
    expect(cached.preloads.every((p) => !p.honored)).toBe(true);
  });

  it('never offers to a World without the capability', async () => {
    const { cold, cached } = await both(session, 'unsupported');
    expect(cached.writes).toEqual(cold.writes);
    expect(cached.preloads.every((p) => p.offered === undefined)).toBe(true);
    expect(EventLogPrefixCache.shared().size).toBe(0);
  });

  it('a run cancelled between invocations exits the same way and forgets its prefix', async () => {
    const { cold, cached } = await both(async (h) => {
      await h.deliver();
      await h.resumeOutOfBand('a');
      h.advance(10);
      await h.deliver();
      h.append({
        eventType: 'run_cancelled',
        specVersion: SPEC_VERSION_CURRENT,
      } as CreateEventRequest);
      h.advance(1_500);
      await h.deliver();
    });
    expect(cached.writes).toEqual(cold.writes);
    expect(normalize(cached.durable)).toEqual(normalize(cold.durable));
    // The wake after the cancel offered the prefix, failed with
    // RunExpiredError, and evicted it.
    expect(cached.preloads.at(-1)?.offered).toBeGreaterThan(0);
    expect(EventLogPrefixCache.shared().size).toBe(0);
  });

  it('concurrent deliveries of one wake each get their own prefix and converge on the cold outcome', async () => {
    const { cold, cached } = await both(async (h) => {
      await h.deliver();
      await h.resumeOutOfBand('a');
      h.advance(10);
      await h.deliver();
      h.advance(1_500);
      // Two deliveries of the sleep wake race (a redelivery overlapping the
      // original): both replay the same log.
      await Promise.all([h.deliver(), h.deliver()]);
      await h.resumeOutOfBand('b');
      h.advance(10);
      await Promise.all([h.deliver(), h.deliver()]);
    });
    const outcome = (h: Harness) =>
      [
        ...new Set(
          h.durable.map((e) => `${e.eventType}:${e.correlationId ?? ''}`)
        ),
      ].sort();
    expect(outcome(cached)).toEqual(outcome(cold));
    // Each concurrent delivery was offered a distinct array: no invocation
    // can see another's (or the cache's) copy of the prefix.
    const offered = cached.offeredArrays;
    expect(offered.length).toBeGreaterThanOrEqual(4);
    expect(new Set(offered).size).toBe(offered.length);
    for (let i = 1; i < offered.length; i++) {
      for (const event of offered[i]) {
        expect(offered[i - 1].includes(event)).toBe(false);
      }
    }
  });
});
