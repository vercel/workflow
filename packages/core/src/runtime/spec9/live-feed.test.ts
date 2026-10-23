import { type Event, slotToEventId, type WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS,
  DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS,
  getOrchestratorFeedPollIntervalMs,
  getOrchestratorPollIntervalMs,
  LiveLogFeed,
  ORCHESTRATOR_POLL_MAX_BACKOFF_FACTOR,
} from './live-feed.js';

const RUN = 'wrun_feed';

function seeded(options: ConstructorParameters<typeof AppendOnlyWorld>[0]) {
  const world = new AppendOnlyWorld(options);
  world.seedRun({
    runId: RUN,
    workflowName: 'wf',
    deploymentId: 'dpl',
    status: 'running',
    input: new Uint8Array(),
  } as unknown as WorkflowRun);
  return world;
}

const hookReceived = (cid: string) =>
  ({ eventType: 'hook_received', correlationId: cid }) as Partial<Event>;

afterEach(() => {
  vi.useRealTimers();
});

describe('LiveLogFeed', () => {
  it('delivers pushed events in slot order', () => {
    const world = seeded({ subscribe: true });
    const received: string[] = [];
    const feed = new LiveLogFeed(world.asWorld(), RUN, {
      afterSlot: 1,
      cursor: slotToEventId(1),
      pollIntervalMs: 0,
      onEvents: (events) => received.push(...events.map((e) => e.eventId)),
    });
    feed.start();
    world.appendOutOfBand(hookReceived('hook_a'));
    world.appendOutOfBand(hookReceived('hook_b'));
    feed.stop();
    world.appendOutOfBand(hookReceived('hook_c'));
    expect(received).toEqual([slotToEventId(2), slotToEventId(3)]);
  });

  it('holds back a push that skips a slot until the gap is filled', async () => {
    const world = seeded({});
    const received: string[] = [];
    const subscribers: ((event: Event) => void)[] = [];
    const base = world.asWorld();
    const pushing = {
      events: {
        ...base.events,
        subscribe: (_r: string, _a: number, onEvent: (e: Event) => void) => {
          subscribers.push(onEvent);
          return () => {};
        },
      },
    } as typeof base;
    const feed = new LiveLogFeed(pushing, RUN, {
      afterSlot: 1,
      cursor: slotToEventId(1),
      pollIntervalMs: 0,
      onEvents: (events) => received.push(...events.map((e) => e.eventId)),
    });
    feed.start();
    const second = world.appendOutOfBand(hookReceived('hook_a'));
    const third = world.appendOutOfBand(hookReceived('hook_b'));
    subscribers[0]?.(third);
    expect(received).toEqual([]);
    subscribers[0]?.(second);
    subscribers[0]?.(second);
    expect(received).toEqual([second.eventId, third.eventId]);
    feed.stop();
  });

  it('polls the tail when the World has no live feed', async () => {
    vi.useFakeTimers();
    const world = seeded({});
    const received: string[] = [];
    const feed = new LiveLogFeed(world.asWorld(), RUN, {
      afterSlot: 1,
      cursor: slotToEventId(1),
      pollIntervalMs: 50,
      onEvents: (events) => received.push(...events.map((e) => e.eventId)),
    });
    feed.start();
    world.appendOutOfBand(hookReceived('hook_a'));
    await vi.advanceTimersByTimeAsync(60);
    expect(received).toEqual([slotToEventId(2)]);
    feed.stop();
  });

  // A poll held in transit (the World never answers it) ends at the read
  // deadline, and the next scheduled poll reads from the same cursor.
  it('keeps polling after a poll the World never answers', async () => {
    vi.useFakeTimers();
    vi.stubEnv('WORKFLOW_ORCHESTRATOR_READ_TIMEOUT_MS', '100');
    let held = 0;
    const signals: (AbortSignal | undefined)[] = [];
    const world = seeded({
      beforeList: (params) => {
        signals.push(params.signal);
        if (held++ === 0) return new Promise<void>(() => {});
      },
    });
    const received: string[] = [];
    const feed = new LiveLogFeed(world.asWorld(), RUN, {
      afterSlot: 1,
      cursor: slotToEventId(1),
      pollIntervalMs: 50,
      onEvents: (events) => received.push(...events.map((e) => e.eventId)),
    });
    feed.start();
    world.appendOutOfBand(hookReceived('hook_a'));
    // The first poll starts at 50ms and is held; its deadline ends it at
    // 150ms, and the next poll starts 50ms later.
    await vi.advanceTimersByTimeAsync(300);
    expect(received).toEqual([slotToEventId(2)]);
    expect(signals[0]?.aborted).toBe(true);
    expect(world.listCalls[1]?.pagination).toEqual(
      world.listCalls[0]?.pagination
    );
    feed.stop();
    vi.unstubAllEnvs();
  });

  it('reads the poll interval from the environment', () => {
    expect(getOrchestratorPollIntervalMs({})).toBe(
      DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS
    );
    expect(
      getOrchestratorPollIntervalMs({
        WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS: '250',
      })
    ).toBe(250);
    expect(
      getOrchestratorPollIntervalMs({
        WORKFLOW_ORCHESTRATOR_POLL_INTERVAL_MS: 'nope',
      })
    ).toBe(DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS);
  });

  it('reads the live-push poll interval from the environment', () => {
    expect(getOrchestratorFeedPollIntervalMs({})).toBe(
      DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS
    );
    expect(
      getOrchestratorFeedPollIntervalMs({
        WORKFLOW_ORCHESTRATOR_FEED_POLL_INTERVAL_MS: '250',
      })
    ).toBe(250);
    expect(
      getOrchestratorFeedPollIntervalMs({
        WORKFLOW_ORCHESTRATOR_FEED_POLL_INTERVAL_MS: 'nope',
      })
    ).toBe(DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS);
  });

  // The push is the fast path; the poll while it is up is only the safety
  // net, so it is the slower of the two.
  it('polls less often with a live push than without one by default', () => {
    expect(DEFAULT_ORCHESTRATOR_FEED_POLL_INTERVAL_MS).toBeGreaterThan(
      DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS
    );
  });
});

describe('LiveLogFeed poll backoff', () => {
  /** The interval without a push. */
  const BASE = 50;
  /** The interval while the push is up. */
  const FEED = BASE * 4;
  const MAX = FEED * ORCHESTRATOR_POLL_MAX_BACKOFF_FACTOR;

  /** A World whose push the test drives, and whose list can be made to fail. */
  function controlled() {
    const world = seeded({});
    const base = world.asWorld();
    const feed: {
      push?: (event: Event) => void;
      onError?: (error: unknown) => void;
      failList: boolean;
    } = { failList: false };
    const controlledWorld = {
      ...base,
      events: {
        ...base.events,
        list: async (params: Parameters<typeof base.events.list>[0]) => {
          if (feed.failList) throw new Error('list failed');
          return base.events.list(params);
        },
        subscribe: (
          _runId: string,
          _afterSlot: number,
          onEvent: (event: Event) => void,
          options?: { onError?: (error: unknown) => void }
        ) => {
          feed.push = onEvent;
          feed.onError = options?.onError;
          return () => {};
        },
      },
    } as typeof base;
    return { world, controlledWorld, feed };
  }

  function start(
    world: ConstructorParameters<typeof LiveLogFeed>[0],
    feedPollIntervalMs = FEED
  ) {
    const received: string[] = [];
    const live = new LiveLogFeed(world, RUN, {
      afterSlot: 1,
      cursor: slotToEventId(1),
      pollIntervalMs: BASE,
      feedPollIntervalMs,
      onEvents: (events) => received.push(...events.map((e) => e.eventId)),
    });
    live.start();
    return { live, received };
  }

  /** Runs polls until the interval stops growing. */
  async function backOffFully(live: LiveLogFeed) {
    for (
      let interval = live.nextPollIntervalMs;
      interval < MAX;
      interval *= 2
    ) {
      await vi.advanceTimersByTimeAsync(live.nextPollIntervalMs);
    }
    expect(live.nextPollIntervalMs).toBe(MAX);
  }

  it('doubles the interval per clean poll while the push keeps up, up to a bound', async () => {
    vi.useFakeTimers();
    const world = seeded({ subscribe: true });
    const { live, received } = start(world.asWorld());
    expect(live.nextPollIntervalMs).toBe(FEED);
    // Pushed, so the next poll finds nothing new.
    world.appendOutOfBand(hookReceived('hook_a'));
    expect(world.listCalls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(FEED);
    expect(world.listCalls).toHaveLength(1);
    expect(live.nextPollIntervalMs).toBe(Math.min(FEED * 2, MAX));
    await backOffFully(live);
    await vi.advanceTimersByTimeAsync(MAX * 3);
    expect(live.nextPollIntervalMs).toBe(MAX);
    expect(received).toEqual([slotToEventId(2)]);
    live.stop();
  });

  it('never backs off without a live feed', async () => {
    vi.useFakeTimers();
    const world = seeded({});
    const { live } = start(world.asWorld());
    await vi.advanceTimersByTimeAsync(BASE * 5);
    expect(live.nextPollIntervalMs).toBe(BASE);
    expect(world.listCalls.length).toBeGreaterThanOrEqual(5);
    live.stop();
  });

  it('polls at the configured interval again as soon as the feed errors', async () => {
    vi.useFakeTimers();
    const { world, controlledWorld, feed } = controlled();
    const { live, received } = start(controlledWorld);
    await backOffFully(live);
    // The next poll is now up to MAX away; the feed ends and an event lands.
    feed.onError?.(new Error('socket closed'));
    world.appendOutOfBand(hookReceived('hook_a'));
    expect(live.nextPollIntervalMs).toBe(BASE);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(received).toEqual([slotToEventId(2)]);
    // And stays there: the feed is gone.
    await vi.advanceTimersByTimeAsync(BASE * 4);
    expect(live.nextPollIntervalMs).toBe(BASE);
    live.stop();
  });

  it('resets after a poll delivers an event the push missed', async () => {
    vi.useFakeTimers();
    const { world, controlledWorld } = controlled();
    const { live, received } = start(controlledWorld);
    await backOffFully(live);
    // Never pushed.
    world.appendOutOfBand(hookReceived('hook_a'));
    await vi.advanceTimersByTimeAsync(MAX);
    expect(received).toEqual([slotToEventId(2)]);
    expect(live.nextPollIntervalMs).toBe(BASE);
    live.stop();
  });

  it('moves the next poll up when a push skips a slot', async () => {
    vi.useFakeTimers();
    const { world, controlledWorld, feed } = controlled();
    const { live, received } = start(controlledWorld);
    await backOffFully(live);
    world.appendOutOfBand(hookReceived('hook_a'));
    const third = world.appendOutOfBand(hookReceived('hook_b'));
    feed.push?.(third);
    expect(received).toEqual([]);
    expect(live.nextPollIntervalMs).toBe(BASE);
    await vi.advanceTimersByTimeAsync(BASE);
    expect(received).toEqual([slotToEventId(2), slotToEventId(3)]);
    live.stop();
  });

  it('climbs back to the bound from the interval without a push once the push keeps up again', async () => {
    vi.useFakeTimers();
    const { world, controlledWorld } = controlled();
    const { live } = start(controlledWorld);
    await backOffFully(live);
    // Never pushed: the poll finds it and drops to the interval without a push.
    world.appendOutOfBand(hookReceived('hook_a'));
    await vi.advanceTimersByTimeAsync(MAX);
    expect(live.nextPollIntervalMs).toBe(BASE);
    await backOffFully(live);
    live.stop();
  });

  it('never polls more often with a push than without one', async () => {
    vi.useFakeTimers();
    const world = seeded({ subscribe: true });
    const { live } = start(world.asWorld(), BASE / 2);
    expect(live.nextPollIntervalMs).toBe(BASE);
    live.stop();
  });

  it('resets after a failed poll', async () => {
    vi.useFakeTimers();
    const { controlledWorld, feed } = controlled();
    const { live } = start(controlledWorld);
    await backOffFully(live);
    feed.failList = true;
    await vi.advanceTimersByTimeAsync(MAX);
    expect(live.nextPollIntervalMs).toBe(BASE);
    live.stop();
  });
});
