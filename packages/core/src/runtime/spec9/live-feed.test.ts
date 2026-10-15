import { type Event, slotToEventId, type WorkflowRun } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppendOnlyWorld } from '../../test-support/append-only-world.js';
import {
  DEFAULT_ORCHESTRATOR_POLL_INTERVAL_MS,
  getOrchestratorPollIntervalMs,
  LiveLogFeed,
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
});
