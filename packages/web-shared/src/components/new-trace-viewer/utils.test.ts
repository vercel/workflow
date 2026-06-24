import { describe, expect, it } from 'vitest';
import type { Span, SpanEvent } from './types';
import {
  computeOffscreenMarkers,
  computeSpanDelta,
  computeSpanMarkers,
  computeSpanSegments,
} from './utils';

/** Build a high-res timestamp tuple ([seconds, nanoseconds]) for a given ms. */
function ts(ms: number): [number, number] {
  return [Math.floor(ms / 1000), (ms % 1000) * 1e6];
}

function hookSpan(opts: {
  startMs: number;
  endMs: number;
  receivesMs: number[];
  disposedMs?: number;
  attrSetMs?: number[];
}): Span {
  const events: SpanEvent[] = [
    { name: 'hook_created', timestamp: ts(opts.startMs), attributes: {} },
    ...opts.receivesMs.map((m) => ({
      name: 'hook_received',
      timestamp: ts(m),
      attributes: {},
    })),
    ...(opts.attrSetMs ?? []).map((m) => ({
      name: 'attr_set',
      timestamp: ts(m),
      attributes: {},
    })),
    ...(opts.disposedMs !== undefined
      ? [
          {
            name: 'hook_disposed',
            timestamp: ts(opts.disposedMs),
            attributes: {},
          } satisfies SpanEvent,
        ]
      : []),
  ];

  return {
    name: 'hook',
    kind: 0,
    resource: 'hook',
    library: { name: 'workflow' },
    spanId: 'hook-1',
    status: { code: 1 },
    traceFlags: 0,
    attributes: {},
    links: [],
    events,
    startTime: ts(opts.startMs),
    endTime: ts(opts.endMs),
    duration: ts(opts.endMs - opts.startMs),
  };
}

describe('computeSpanSegments (run)', () => {
  function runSpan(status: string): Span {
    return {
      name: 'run',
      kind: 0,
      resource: 'run',
      library: { name: 'workflow' },
      spanId: 'run-1',
      status: { code: 1 },
      traceFlags: 0,
      attributes: { data: { status } },
      links: [],
      events: [{ name: 'run_created', timestamp: ts(0), attributes: {} }],
      startTime: ts(0),
      endTime: ts(100_000),
      duration: ts(100_000),
    };
  }

  it('maps pending runs to a pending segment (not running)', () => {
    expect(computeSpanSegments(runSpan('pending'))).toEqual([
      { startFraction: 0, endFraction: 1, status: 'pending' },
    ]);
  });

  it('maps running runs to a running segment', () => {
    expect(computeSpanSegments(runSpan('running'))).toEqual([
      { startFraction: 0, endFraction: 1, status: 'running' },
    ]);
  });
});

describe('computeSpanSegments (hook)', () => {
  it('renders a single waiting segment for a hook resumed many times but not disposed', () => {
    const span = hookSpan({
      startMs: 0,
      endMs: 100_000,
      receivesMs: [1_000, 50_000, 99_000],
    });

    // A hook resumed N times still re-suspends after every resumption, so the
    // bar must stay "waiting" for its whole life — not flip to a filled
    // "received" segment after the first receive (which hid resumptions 2..N).
    expect(computeSpanSegments(span)).toEqual([
      { startFraction: 0, endFraction: 1, status: 'waiting' },
    ]);
  });

  it('ends the waiting segment at disposal and appends a succeeded tail', () => {
    const span = hookSpan({
      startMs: 0,
      endMs: 100_000,
      receivesMs: [1_000, 50_000],
      disposedMs: 80_000,
    });

    expect(computeSpanSegments(span)).toEqual([
      { startFraction: 0, endFraction: 0.8, status: 'waiting' },
      { startFraction: 0.8, endFraction: 1, status: 'succeeded' },
    ]);
  });

  it('treats a never-resolved hook as fully waiting', () => {
    const span = hookSpan({ startMs: 0, endMs: 100_000, receivesMs: [] });

    expect(computeSpanSegments(span)).toEqual([
      { startFraction: 0, endFraction: 1, status: 'waiting' },
    ]);
  });
});

describe('computeSpanMarkers', () => {
  it('emits one marker per resumption, including those at the temporal edges', () => {
    const span = hookSpan({
      startMs: 0,
      endMs: 100_000,
      receivesMs: [1_000, 50_000, 99_000],
    });

    const markers = computeSpanMarkers(span);
    expect(markers.map((m) => m.timeMs)).toEqual([1_000, 50_000, 99_000]);
  });

  it('merges hook_received and attr_set events, sorted by time', () => {
    const span = hookSpan({
      startMs: 0,
      endMs: 100_000,
      receivesMs: [50_000],
      attrSetMs: [10_000, 70_000],
    });

    expect(computeSpanMarkers(span).map((m) => m.timeMs)).toEqual([
      10_000, 50_000, 70_000,
    ]);
  });

  it('returns no markers when the span has no marker events', () => {
    const span = hookSpan({ startMs: 0, endMs: 100_000, receivesMs: [] });
    expect(computeSpanMarkers(span)).toEqual([]);
  });
});

describe('computeSpanDelta', () => {
  function mkSpan(startMs: number, endMs: number, id = 'span'): Span {
    return {
      name: id,
      kind: 0,
      resource: 'step',
      library: { name: 'workflow' },
      spanId: id,
      status: { code: 1 },
      traceFlags: 0,
      attributes: {},
      links: [],
      events: [],
      startTime: ts(startMs),
      endTime: ts(endMs),
      duration: ts(endMs - startMs),
    };
  }

  it('measures the idle gap when the hovered span is after the selected one', () => {
    const selected = mkSpan(0, 20, 'a');
    const hovered = mkSpan(50, 70, 'b');

    const delta = computeSpanDelta(selected, hovered, 0, 3, 0, 100);
    expect(delta).not.toBeNull();
    expect(delta?.kind).toBe('gap');
    expect(delta?.deltaMs).toBe(30);
    expect(delta?.leftFrac).toBeCloseTo(0.2, 6);
    expect(delta?.rightFrac).toBeCloseTo(0.5, 6);
    expect(delta?.fromRowIndex).toBe(0);
    expect(delta?.toRowIndex).toBe(3);
  });

  it('measures the same gap regardless of which span is selected', () => {
    const a = mkSpan(0, 20, 'a');
    const b = mkSpan(50, 70, 'b');

    const forward = computeSpanDelta(a, b, 0, 1, 0, 100);
    const reverse = computeSpanDelta(b, a, 1, 0, 0, 100);

    expect(forward?.deltaMs).toBe(30);
    expect(reverse?.deltaMs).toBe(30);
    expect(forward?.leftFrac).toBeCloseTo(reverse?.leftFrac ?? -1, 6);
    expect(forward?.rightFrac).toBeCloseTo(reverse?.rightFrac ?? -1, 6);
  });

  it('measures the start offset when the hovered span overlaps (nested)', () => {
    const run = mkSpan(0, 100, 'run');
    const step = mkSpan(10, 30, 'step');

    const delta = computeSpanDelta(run, step, 0, 2, 0, 100);
    expect(delta?.kind).toBe('overlap');
    expect(delta?.deltaMs).toBe(10);
    expect(delta?.leftFrac).toBeCloseTo(0, 6);
    expect(delta?.rightFrac).toBeCloseTo(0.1, 6);
  });

  it('treats touching spans as a zero-length gap', () => {
    const a = mkSpan(0, 20, 'a');
    const b = mkSpan(20, 40, 'b');

    const delta = computeSpanDelta(a, b, 0, 1, 0, 100);
    expect(delta?.kind).toBe('gap');
    expect(delta?.deltaMs).toBe(0);
  });

  it('clamps the measured region to the visible viewport', () => {
    const a = mkSpan(0, 20, 'a');
    const b = mkSpan(50, 70, 'b');

    // Viewport [25, 45] cuts off both edges of the [20, 50] gap region.
    const delta = computeSpanDelta(a, b, 0, 1, 25, 45);
    expect(delta?.deltaMs).toBe(30);
    expect(delta?.leftFrac).toBe(0);
    expect(delta?.rightFrac).toBe(1);
  });

  it('returns null for a non-positive viewport range', () => {
    const a = mkSpan(0, 20, 'a');
    const b = mkSpan(50, 70, 'b');
    expect(computeSpanDelta(a, b, 0, 1, 50, 50)).toBeNull();
  });
});

describe('computeOffscreenMarkers', () => {
  const mk = (timeMs: number) => ({ timeMs });

  it('partitions markers by side with the nearest one per side', () => {
    const markers = [mk(5), mk(8), mk(50), mk(92), mk(99)];
    // Visible window [10, 90]: 5 & 8 off left (nearest 8), 92 & 99 off right
    // (nearest 92), 50 in view.
    expect(computeOffscreenMarkers(markers, 10, 90)).toEqual({
      left: { count: 2, nearestMs: 8 },
      right: { count: 2, nearestMs: 92 },
    });
  });

  it('returns null for a side with nothing off-screen', () => {
    expect(computeOffscreenMarkers([mk(20), mk(50)], 10, 90)).toEqual({
      left: null,
      right: null,
    });
  });
});
