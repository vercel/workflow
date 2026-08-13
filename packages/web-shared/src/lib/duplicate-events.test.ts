import type { Event, EventType } from '@workflow/world';
import { DUPLICATE_EVENT_FIXTURES } from '@workflow/world/test-support/duplicate-event-fixtures.js';
import { describe, expect, it } from 'vitest';
import { findDuplicateEventIds } from './duplicate-events';

const BASE_TIME = Date.parse('2026-01-01T00:00:00.000Z');

const COMPLETE = { isCompleteHistory: true };

let nextSlot = 0;

function event(
  eventType: EventType,
  options: {
    correlationId?: string;
    /** Log position. Defaults to the order the fixture created the event in. */
    slot?: number;
    /** `createdAt`/`occurredAt`, in seconds after the fixture epoch. */
    at?: number;
    occurredAt?: number;
  } = {}
): Event {
  nextSlot += 1;
  const slot = options.slot ?? nextSlot;
  const createdAt = new Date(BASE_TIME + (options.at ?? slot) * 1000);
  return {
    eventId: `evnt_${String(slot).padStart(26, '0')}`,
    runId: 'run_1',
    eventType,
    correlationId: options.correlationId,
    createdAt,
    occurredAt:
      options.occurredAt === undefined
        ? createdAt
        : new Date(BASE_TIME + options.occurredAt * 1000),
    eventData: {},
  } as unknown as Event;
}

/**
 * The same event under the older ID scheme, whose IDs are ULIDs rather than
 * slots. A backend serving such a log may order it by `(createdAt, eventId)`
 * instead of by ID, so the ID alone does not fix the log position.
 */
function ulidEvent(...args: Parameters<typeof event>): Event {
  const slotEvent = event(...args);
  const slot = slotEvent.eventId.slice('evnt_'.length).replace(/^0+/, '');
  return {
    ...slotEvent,
    eventId: `evnt_01K${slot.padStart(23, '0')}`,
  } as Event;
}

describe('findDuplicateEventIds', () => {
  it('returns nothing for a log with no repeats', () => {
    const events = [
      event('run_created'),
      event('run_started'),
      event('step_created', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_a' }),
      event('run_completed'),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(new Set());
  });

  it('flags every repeat a finished entity collects', () => {
    const created = event('step_created', { correlationId: 'step_a' });
    const started = event('step_started', { correlationId: 'step_a' });
    const completed = event('step_completed', { correlationId: 'step_a' });
    const createdAgain = event('step_created', { correlationId: 'step_a' });
    const startedAgain = event('step_started', { correlationId: 'step_a' });

    expect(
      findDuplicateEventIds(
        [created, started, completed, createdAgain, startedAgain],
        COMPLETE
      )
    ).toEqual(new Set([createdAgain.eventId, startedAgain.eventId]));
  });

  it('leaves a class the log has not recorded for the entity yet', () => {
    // The step finished without a step_started in the log, so this one repeats
    // nothing. The runtime reports that as divergence rather than passing it
    // over, and the UI must not present it as a settled repeat.
    const events = [
      event('step_created', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(new Set());
  });

  it('treats completed and failed as one terminal class', () => {
    // A concurrent replay writing the other outcome does not move the step off
    // the outcome the run acted on.
    const failed = event('step_failed', { correlationId: 'step_a' });
    const completed = event('step_completed', { correlationId: 'step_a' });

    expect(findDuplicateEventIds([failed, completed], COMPLETE)).toEqual(
      new Set([completed.eventId])
    );
  });

  it('keys on the correlation id, so sibling entities never collide', () => {
    const events = [
      event('step_created', { correlationId: 'step_a' }),
      event('step_created', { correlationId: 'step_b' }),
      event('step_completed', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_b' }),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(new Set());
  });

  it('does not flag the repeated events of a retried step', () => {
    // Each attempt legitimately records its own start, and each retryable
    // failure its own step_retrying. The step's consumer is registered for the
    // whole sequence and takes all of them.
    const events = [
      event('step_created', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_retrying', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_retrying', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_a' }),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(new Set());
  });

  it('does not flag a second step_created while the step is still open', () => {
    // The step's consumer is registered and absorbs it, so the run does not
    // read past this event.
    const events = [
      event('step_created', { correlationId: 'step_a' }),
      event('step_created', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(new Set());
  });

  it('does not flag repeated hook deliveries', () => {
    const events = [
      event('hook_created', { correlationId: 'hook_a' }),
      event('hook_received', { correlationId: 'hook_a' }),
      event('hook_received', { correlationId: 'hook_a' }),
      event('hook_disposed', { correlationId: 'hook_a' }),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(new Set());
  });

  it('flags a second start of the run, which carries no correlation id', () => {
    const started = event('run_started');
    const startedAgain = event('run_started');

    expect(findDuplicateEventIds([started, startedAgain], COMPLETE)).toEqual(
      new Set([startedAgain.eventId])
    );
  });

  it('leaves a second outcome for the run alone', () => {
    // Nothing consumes the run's own terminal events: the runtime exits rather
    // than replaying the body once the log holds one. A second is a fault
    // worth seeing, not a repeat the run passed over.
    const completed = event('run_completed');
    const cancelled = event('run_cancelled');

    expect(findDuplicateEventIds([completed, cancelled], COMPLETE)).toEqual(
      new Set()
    );
  });

  it('folds in log order, not in createdAt order', () => {
    const created = event('wait_created', { correlationId: 'wait_a', at: 1 });
    const completed = event('wait_completed', {
      correlationId: 'wait_a',
      at: 3,
    });
    // The repeat entered before the completion it lost to and only took its
    // log position afterwards, so its createdAt is the earliest of the three.
    const createdAgain = event('wait_created', {
      correlationId: 'wait_a',
      at: 0,
    });

    expect(
      findDuplicateEventIds([created, completed, createdAgain], COMPLETE)
    ).toEqual(new Set([createdAgain.eventId]));
  });

  it('folds in log order, not in occurredAt order', () => {
    const created = event('wait_created', { correlationId: 'wait_a' });
    const completed = event('wait_completed', { correlationId: 'wait_a' });
    // occurredAt is measured on the writer's clock, which can run behind.
    const createdAgain = event('wait_created', {
      correlationId: 'wait_a',
      occurredAt: -60,
    });

    expect(
      findDuplicateEventIds([created, completed, createdAgain], COMPLETE)
    ).toEqual(new Set([createdAgain.eventId]));
  });

  it('gives the same answer whichever way the caller sorted', () => {
    const events = [
      event('wait_created', { correlationId: 'wait_a' }),
      event('wait_completed', { correlationId: 'wait_a' }),
      event('wait_created', { correlationId: 'wait_a' }),
    ];

    const ascending = findDuplicateEventIds(events, COMPLETE);
    const descending = findDuplicateEventIds([...events].reverse(), COMPLETE);

    expect(ascending).toEqual(new Set([events[2].eventId]));
    expect(descending).toEqual(ascending);
  });

  it('gives the same answer on tied timestamps whichever way the caller sorted', () => {
    // Two replays that stamped the same millisecond. Only the log position
    // separates them, so the answer must not depend on the caller's order.
    const events = [
      event('wait_created', { correlationId: 'wait_a', at: 5 }),
      event('wait_completed', { correlationId: 'wait_a', at: 5 }),
      event('wait_created', { correlationId: 'wait_a', at: 5 }),
    ];

    const ascending = findDuplicateEventIds(events, COMPLETE);
    const descending = findDuplicateEventIds([...events].reverse(), COMPLETE);

    expect(ascending).toEqual(new Set([events[2].eventId]));
    expect(descending).toEqual(ascending);
  });

  it('classifies a ULID log whose timestamps corroborate its ids', () => {
    const created = ulidEvent('wait_created', { correlationId: 'wait_a' });
    const completed = ulidEvent('wait_completed', { correlationId: 'wait_a' });
    const createdAgain = ulidEvent('wait_created', { correlationId: 'wait_a' });

    expect(
      findDuplicateEventIds([created, completed, createdAgain], COMPLETE)
    ).toEqual(new Set([createdAgain.eventId]));
  });

  it('classifies nothing on a ULID log whose timestamps contradict its ids', () => {
    // A ULID carries no log position: one backend returns such a log in
    // createdAt order and another in id order, and createdAt is stamped when
    // the write arrives rather than when it commits. With the two orders
    // disagreeing, which wait_created the run acted on depends on the backend,
    // so naming either would be a guess.
    const created = ulidEvent('wait_created', { correlationId: 'wait_a' });
    const completed = ulidEvent('wait_completed', { correlationId: 'wait_a' });
    const createdAgain = ulidEvent('wait_created', {
      correlationId: 'wait_a',
      at: -60,
    });

    expect(
      findDuplicateEventIds([created, completed, createdAgain], COMPLETE)
    ).toEqual(new Set());
  });

  it('classifies nothing past the point the run diverged', () => {
    // The step finished without a step_started, so the runtime reports
    // divergence on the first trailing start and exits. The second start and
    // the wait's repeat after it went unread, and neither is a repeat the run
    // passed over. The wait's repeat before it still is.
    const events = [
      event('wait_created', { correlationId: 'wait_a' }),
      event('wait_completed', { correlationId: 'wait_a' }),
      event('wait_created', { correlationId: 'wait_a' }),
      event('step_created', { correlationId: 'step_a' }),
      event('step_completed', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('step_started', { correlationId: 'step_a' }),
      event('wait_created', { correlationId: 'wait_a' }),
    ];

    expect(findDuplicateEventIds(events, COMPLETE)).toEqual(
      new Set([events[2].eventId])
    );
  });

  it('classifies nothing when the caller holds part of the log', () => {
    // A newest-first page can open on the repeat and omit the event it
    // repeats, which would invert the answer.
    const events = [
      event('wait_completed', { correlationId: 'wait_a' }),
      event('wait_created', { correlationId: 'wait_a' }),
    ];

    expect(findDuplicateEventIds(events, { isCompleteHistory: false })).toEqual(
      new Set()
    );
  });

  it('skips events with no id, which callers cannot match on', () => {
    const anonymous = (eventType: EventType) =>
      ({
        ...event(eventType, { correlationId: 'wait_a' }),
        eventId: undefined,
      }) as unknown as Event;

    expect(
      findDuplicateEventIds(
        [
          anonymous('wait_created'),
          anonymous('wait_completed'),
          anonymous('wait_created'),
        ],
        COMPLETE
      )
    ).toEqual(new Set());
  });
});

/**
 * The other half of these runs against `EventsConsumer` in `@workflow/core`,
 * so a fixture whose expectation moves fails on both sides.
 */
describe('shared duplicate-event fixtures', () => {
  for (const fixture of DUPLICATE_EVENT_FIXTURES) {
    it(`classifies the right events: ${fixture.name}`, () => {
      const events = fixture.events.map((spec, index) =>
        event(spec.eventType, { correlationId: spec.entity, slot: index + 1 })
      );

      expect(findDuplicateEventIds(events, COMPLETE)).toEqual(
        new Set(fixture.ignoredIndices.map((index) => events[index].eventId))
      );
    });
  }
});
