import { type Event, eventIdToSlot, slotToEventId } from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { QuickJSLogView } from './quickjs-log-view.js';

function slotEvent(slot: number): Event {
  return {
    eventId: slotToEventId(slot),
    eventType: 'attr_set',
    runId: 'wrun_view',
    createdAt: new Date(0),
    specVersion: 7,
    correlationId: `attr_${slot}`,
  } as unknown as Event;
}

const slots = (events: readonly Event[]) =>
  events.map((e) => eventIdToSlot(e.eventId));

describe('QuickJSLogView', () => {
  it('names the highest position it has seen on the next write', () => {
    const view = new QuickJSLogView([slotEvent(1), slotEvent(2)], 'c2');
    expect(view.snapshotParams()).toEqual({ eventCount: 2 });
    // Its own write landing at 5 raises the position it will name next, even
    // though the VM has not been given that event yet.
    view.absorb({ event: slotEvent(5) });
    expect(view.snapshotParams()).toEqual({ eventCount: 5 });
  });

  it('names no position for an empty log', () => {
    expect(new QuickJSLogView([], null).snapshotParams()).toEqual({});
  });

  it('delivers a write and its skipped span in position order', () => {
    const view = new QuickJSLogView([slotEvent(1), slotEvent(2)], 'c2');
    // The write landed at 5; the World hands back 3 and 4, which another
    // writer appended while this one was deciding.
    view.absorb({
      event: slotEvent(5),
      events: [slotEvent(3), slotEvent(4), slotEvent(5)],
      hasMore: false,
    });
    expect(slots(view.takeContiguous())).toEqual([3, 4, 5]);
    expect(view.bufferedCount).toBe(0);
    expect(view.takeContiguous()).toEqual([]);
  });

  it('does not deliver the created event itself, only its position', () => {
    const view = new QuickJSLogView([slotEvent(1), slotEvent(2)], 'c2');
    // A create response may carry the event with its payload unresolved, so
    // it is not what a listing would deliver. Its position still counts.
    view.absorb({ event: slotEvent(3) });
    expect(view.bufferedCount).toBe(0);
    expect(view.takeContiguous()).toEqual([]);
    expect(view.snapshotParams()).toEqual({ eventCount: 3 });
    // A write whose event carries nothing a VM reads can opt in.
    view.absorb({ event: slotEvent(4) }, { deliverEvent: true });
    expect(view.bufferedCount).toBe(1);
    // 3 is not in hand, so 4 waits for the listing that delivers 3.
    expect(view.takeContiguous()).toEqual([]);
    view.markFed([slotEvent(3)]);
    expect(slots(view.takeContiguous())).toEqual([4]);
  });

  it('holds back a queued event above a position it does not have', () => {
    const view = new QuickJSLogView([slotEvent(1)], 'c1');
    view.absorb({ event: slotEvent(3) }, { deliverEvent: true });
    // Position 2 is not in hand, so 3 cannot be fed: the VM must not see it
    // before whatever lands at 2.
    expect(view.takeContiguous()).toEqual([]);
    expect(view.bufferedCount).toBe(1);
    // A listing delivers 2 to the VM; 3 is now next.
    view.markFed([slotEvent(2)]);
    expect(slots(view.takeContiguous())).toEqual([3]);
  });

  it('drops a truncated report whole', () => {
    const view = new QuickJSLogView([slotEvent(1)], 'c1');
    const absorbed = view.absorb({
      event: slotEvent(10),
      events: [slotEvent(2), slotEvent(3)],
      hasMore: true,
    });
    expect(absorbed).toEqual({ queued: 0, truncated: true });
    expect(view.bufferedCount).toBe(0);
    // The write's position is still known, so the next write names 10 and a
    // listing fills 2..10.
    expect(view.snapshotParams()).toEqual({ eventCount: 10 });
  });

  it('drops an event a listing already delivered', () => {
    const view = new QuickJSLogView([slotEvent(1)], 'c1');
    view.absorb({ event: slotEvent(3) }, { deliverEvent: true });
    // The listing raced ahead and delivered 2 and 3 itself.
    view.markFed([slotEvent(2), slotEvent(3)]);
    expect(view.bufferedCount).toBe(0);
    expect(view.takeContiguous()).toEqual([]);
  });

  it('advances the cursor on a complete delta that leaves no hole', () => {
    const view = new QuickJSLogView([slotEvent(1), slotEvent(2)], 'c2');
    const advanced = view.absorbDelta('c2', {
      events: [slotEvent(3), slotEvent(4)],
      cursor: 'c4',
      hasMore: false,
    });
    expect(advanced).toBe(true);
    expect(view.logCursor).toBe('c4');
    expect(slots(view.takeContiguous())).toEqual([3, 4]);
  });

  it('keeps the cursor when the delta was computed from an older position', () => {
    const view = new QuickJSLogView([slotEvent(1)], 'c1');
    view.advanceCursor('c3');
    const advanced = view.absorbDelta('c1', {
      events: [slotEvent(2)],
      cursor: 'c2',
      hasMore: false,
    });
    expect(advanced).toBe(false);
    expect(view.logCursor).toBe('c3');
    // Nothing was queued from it either: a listing from c3 covers the rest.
    expect(view.bufferedCount).toBe(0);
  });

  it('keeps the cursor when the delta leaves a hole below its end', () => {
    const view = new QuickJSLogView([slotEvent(1)], 'c1');
    // Position 4 is in hand (an own write) but 2 and 3 are not.
    view.absorb({ event: slotEvent(4) }, { deliverEvent: true });
    const advanced = view.absorbDelta('c1', {
      events: [slotEvent(5)],
      cursor: 'c5',
      hasMore: false,
    });
    expect(advanced).toBe(false);
    expect(view.logCursor).toBe('c1');
    // Moving the cursor to c5 would have made 2 and 3 unreachable by a
    // listing, and the VM would never get past 1.
  });

  it('turns tracking off for good on an id that is not a position', () => {
    const view = new QuickJSLogView([slotEvent(1)], 'c1');
    view.absorb({ event: slotEvent(2) }, { deliverEvent: true });
    expect(view.bufferedCount).toBe(1);
    view.absorb({
      event: { ...slotEvent(3), eventId: 'evnt_01ARZ3NDEKTSV4RRFFQ69G5FAV' },
    });
    expect(view.tracking).toBe(false);
    expect(view.snapshotParams()).toEqual({});
    expect(view.bufferedCount).toBe(0);
    expect(view.takeContiguous()).toEqual([]);
    // Nothing queues again afterwards.
    view.absorb({ event: slotEvent(4) }, { deliverEvent: true });
    expect(view.bufferedCount).toBe(0);
  });
});
