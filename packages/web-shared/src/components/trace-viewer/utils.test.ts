import { describe, expect, it } from 'vitest';
import type { Span, SpanEvent } from './types';
import {
  clampViewportToRoot,
  computeOffscreenMarkers,
  computeSpanDelta,
  computeSpanMarkers,
  computeSpanSegments,
  computeTimeMarkers,
  getResourceColor,
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

describe('clampViewportToRoot', () => {
  const clamp = (next: { start: number; end: number }) =>
    clampViewportToRoot(next, 100, 1100, 10);

  it('passes through a window already inside the root', () => {
    expect(clamp({ start: 200, end: 400 })).toEqual({ start: 200, end: 400 });
  });

  it('shifts a window past the left edge without changing its duration', () => {
    expect(clamp({ start: 50, end: 250 })).toEqual({ start: 100, end: 300 });
  });

  it('shifts a window past the right edge without changing its duration', () => {
    expect(clamp({ start: 1000, end: 1200 })).toEqual({
      start: 900,
      end: 1100,
    });
  });

  it('clamps a window wider than the root to the full extent', () => {
    expect(clamp({ start: 0, end: 5000 })).toEqual({ start: 100, end: 1100 });
  });

  it('enforces the minimum duration', () => {
    expect(clamp({ start: 500, end: 502 })).toEqual({ start: 500, end: 510 });
  });

  it('keeps a minimum-duration window inside the root near the right edge', () => {
    expect(clamp({ start: 1098, end: 1099 })).toEqual({
      start: 1090,
      end: 1100,
    });
  });
});

describe('computeTimeMarkers', () => {
  it('emits distinct, precise labels across a sub-second-step window', () => {
    // A ~3s window drops the tick step to 500ms. Before the fix this rendered
    // duplicate "2s, 2s, 3s, 3s" labels; now each tick is distinct.
    const labels = computeTimeMarkers(3000, 0).map((m) => m.label);
    expect(labels).toEqual(['0s', '500ms', '1s', '1.5s', '2s', '2.5s', '3s']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps clean whole-second labels when the step is >=1s', () => {
    const labels = computeTimeMarkers(10_000, 0).map((m) => m.label);
    expect(labels).toEqual(['0s', '2s', '4s', '6s', '8s', '10s']);
  });

  it('still reads in ms when super zoomed in', () => {
    const labels = computeTimeMarkers(120, 0).map((m) => m.label);
    expect(labels).toEqual([
      '0s',
      '20ms',
      '40ms',
      '60ms',
      '80ms',
      '100ms',
      '120ms',
    ]);
  });
});

describe('getResourceColor', () => {
  it('uses gray for hooks (passive spans), not amber', () => {
    expect(getResourceColor('hook')).toEqual({
      bg: 'var(--ds-gray-200)',
      border: 'var(--ds-gray-500)',
      errorBg: 'var(--ds-red-200)',
      errorBorder: 'var(--ds-red-500)',
    });
  });
});

describe('computeSpanDelta', () => {
  function span(id: string, startMs: number, endMs: number): Span {
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

  it('measures the gap between disjoint spans (anchor earlier)', () => {
    const delta = computeSpanDelta(
      span('a', 0, 100),
      span('b', 300, 400),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 200,
      anchorFrac: 0.1,
      hoveredFrac: 0.3,
      anchorEdge: 'end',
      hoveredOffscreen: null,
    });
  });

  it('is direction-agnostic: anchor later gives the same delta with edges swapped', () => {
    const delta = computeSpanDelta(
      span('b', 300, 400),
      span('a', 0, 100),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 200,
      anchorFrac: 0.3,
      hoveredFrac: 0.1,
      anchorEdge: 'start',
      hoveredOffscreen: null,
    });
  });

  it('measures start-to-start offset for overlapping spans', () => {
    const delta = computeSpanDelta(
      span('a', 0, 500),
      span('b', 200, 800),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 200,
      anchorFrac: 0,
      hoveredFrac: 0.2,
      anchorEdge: 'start',
      hoveredOffscreen: null,
    });
  });

  it('measures start-to-start offset for contained spans (step inside run)', () => {
    const delta = computeSpanDelta(
      span('run', 0, 1000),
      span('step', 400, 600),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 400,
      anchorFrac: 0,
      hoveredFrac: 0.4,
      anchorEdge: 'start',
      hoveredOffscreen: null,
    });
  });

  it('returns a zero delta for identical starts', () => {
    const delta = computeSpanDelta(
      span('a', 200, 500),
      span('b', 200, 300),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 0,
      anchorFrac: 0.2,
      hoveredFrac: 0.2,
      anchorEdge: 'start',
      hoveredOffscreen: null,
    });
  });

  it('keeps a zero delta sitting exactly on the viewport edge (root span anchor at default zoom)', () => {
    const delta = computeSpanDelta(
      span('run', 0, 1000),
      span('step', 0, 400),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 0,
      anchorFrac: 0,
      hoveredFrac: 0,
      anchorEdge: 'start',
      hoveredOffscreen: null,
    });
  });

  it('treats touching spans as a zero gap, not an overlap', () => {
    const delta = computeSpanDelta(
      span('a', 0, 300),
      span('b', 300, 400),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 0,
      anchorFrac: 0.3,
      hoveredFrac: 0.3,
      anchorEdge: 'end',
      hoveredOffscreen: null,
    });
  });

  it('handles zero-duration spans as points', () => {
    const delta = computeSpanDelta(
      span('a', 100, 100),
      span('b', 400, 400),
      0,
      1000
    );
    expect(delta).toEqual({
      deltaMs: 300,
      anchorFrac: 0.1,
      hoveredFrac: 0.4,
      anchorEdge: 'end',
      hoveredOffscreen: null,
    });
  });

  it('clamps edges to the viewport but keeps the true delta', () => {
    const delta = computeSpanDelta(
      span('a', 0, 100),
      span('b', 900, 950),
      500,
      800
    );
    expect(delta).toEqual({
      deltaMs: 800,
      anchorFrac: 0,
      hoveredFrac: 1,
      anchorEdge: 'end',
      hoveredOffscreen: 'right',
    });
  });

  it('flags a hovered span lying fully left of the viewport', () => {
    const delta = computeSpanDelta(
      span('anchor', 600, 700),
      span('hovered', 0, 100),
      200,
      1200
    );
    expect(delta).toEqual({
      deltaMs: 500,
      anchorFrac: 0.4,
      hoveredFrac: 0,
      anchorEdge: 'start',
      hoveredOffscreen: 'left',
    });
  });

  it('returns null when the measurement is entirely left of the viewport', () => {
    expect(
      computeSpanDelta(span('a', 0, 100), span('b', 200, 300), 500, 1000)
    ).toBeNull();
  });

  it('returns null when the measurement is entirely right of the viewport', () => {
    expect(
      computeSpanDelta(span('a', 600, 700), span('b', 900, 950), 0, 500)
    ).toBeNull();
  });

  it('returns null for an empty viewport range', () => {
    expect(
      computeSpanDelta(span('a', 0, 100), span('b', 200, 300), 500, 500)
    ).toBeNull();
  });
});
