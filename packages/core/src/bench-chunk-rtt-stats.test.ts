/**
 * Unit tests for the chunk-RTT (CRTT) benchmark's pure bucketing/aggregation
 * helpers (workbench/example/workflows/97_bench_rtt.ts). The module is
 * dependency-free on purpose: the same code runs inside the benchmark's
 * reader step on the deployment (per-iteration aggregation) and in the
 * benchmark runner (cross-iteration merging), and this suite is the fast
 * check on both — the bench itself only runs against a deployment.
 */

import { describe, expect, test } from 'vitest';
import {
  type BenchRttSummary,
  type CdvArrival,
  computeCdv,
  histogramRttSamples,
  mergeMeanProfiles,
  mergeRttSummaries,
  progressProfile,
  RTT_HIST_EDGES_MS,
  RTT_INDEX_BUCKETS,
  RTT_PROGRESS_BINS,
  RTT_SIZE_BIN_EDGES_BYTES,
  rttIndexBucket,
  rttSizeBin,
  sizeProfile,
  steadyRate,
  summarizeDelayTail,
  summarizeRttSamples,
} from '../../../workbench/example/workflows/97_bench_rtt';

/** Histogram with `count` in the bin holding `value` and zeros elsewhere. */
function histWith(value: number, count = 1): number[] {
  const hist = new Array(RTT_HIST_EDGES_MS.length + 1).fill(0);
  let bin = 0;
  while (bin < RTT_HIST_EDGES_MS.length && value >= RTT_HIST_EDGES_MS[bin]) {
    bin++;
  }
  hist[bin] = count;
  return hist;
}

describe('rttIndexBucket', () => {
  test('boundaries: stream-open write / warmup / steady state', () => {
    expect(rttIndexBucket(0)).toBe('seq 0');
    expect(rttIndexBucket(1)).toBe('seq 1-20');
    expect(rttIndexBucket(20)).toBe('seq 1-20');
    expect(rttIndexBucket(21)).toBe('seq 21+');
    expect(rttIndexBucket(299)).toBe('seq 21+');
  });

  test('every bucket is a declared bucket key', () => {
    for (let seq = 0; seq < 300; seq++) {
      expect(RTT_INDEX_BUCKETS).toContain(rttIndexBucket(seq));
    }
  });
});

describe('progressProfile', () => {
  test('bins by fraction of the stream, so profiles are chunk-count independent', () => {
    // 300 chunks: each tenth holds exactly 30.
    const rtts = Array.from({ length: 300 }, (_, seq) => seq);
    const profile = progressProfile(rtts);
    expect(profile.counts).toEqual(new Array(RTT_PROGRESS_BINS).fill(30));
    // First tenth: seq 0..29 (sum 435); last tenth: seq 270..299 (sum 8535).
    expect(profile.totalMs[0]).toBe(435);
    expect(profile.totalMs[RTT_PROGRESS_BINS - 1]).toBe(8535);

    // 20 chunks (fewer than would fill 10 bins evenly at other counts): still
    // 2 per tenth.
    const small = progressProfile(Array.from({ length: 20 }, () => 5));
    expect(small.counts).toEqual(new Array(RTT_PROGRESS_BINS).fill(2));
  });

  test('skips sparse entries defensively', () => {
    const rtts: (number | undefined)[] = new Array(100);
    rtts[0] = 7;
    rtts[99] = 9;
    const profile = progressProfile(rtts);
    expect(profile.counts.reduce((a, b) => a + b, 0)).toBe(2);
    expect(profile.totalMs[0]).toBe(7);
    expect(profile.totalMs[RTT_PROGRESS_BINS - 1]).toBe(9);
  });
});

describe('mergeMeanProfiles', () => {
  test('returns undefined with no profiles and sums exactly otherwise', () => {
    expect(mergeMeanProfiles([])).toBeUndefined();
    expect(mergeMeanProfiles([undefined])).toBeUndefined();
    const a = progressProfile(Array.from({ length: 10 }, () => 10));
    const b = progressProfile(Array.from({ length: 10 }, () => 30));
    const merged = mergeMeanProfiles([a, undefined, b]);
    expect(merged?.counts).toEqual(new Array(RTT_PROGRESS_BINS).fill(2));
    expect(merged?.totalMs).toEqual(new Array(RTT_PROGRESS_BINS).fill(40));
  });
});

describe('sizeProfile', () => {
  test('bins by serialized size with doubling edges', () => {
    expect(rttSizeBin(100)).toBe(0);
    expect(rttSizeBin(255)).toBe(0);
    // A size exactly on an edge lands in the bin the edge opens.
    expect(rttSizeBin(256)).toBe(1);
    expect(rttSizeBin(1024)).toBe(3);
    expect(rttSizeBin(8192)).toBe(RTT_SIZE_BIN_EDGES_BYTES.length);
    expect(rttSizeBin(20000)).toBe(RTT_SIZE_BIN_EDGES_BYTES.length);
  });

  test('the sweep pad ladder occupies every size bin exactly once', () => {
    // Approximate serialized sizes of the sweep rotation: ~60B base chunk
    // plus pads of 100/340/700/1400/3000/6000/12000 chars.
    const sizes = [160, 400, 760, 1460, 3060, 6060, 12060];
    expect(new Set(sizes.map(rttSizeBin)).size).toBe(
      RTT_SIZE_BIN_EDGES_BYTES.length + 1
    );
  });

  test('accumulates count and total RTT per bin', () => {
    const profile = sizeProfile([
      { bytes: 160, rttMs: 10 },
      { bytes: 200, rttMs: 20 },
      { bytes: 12060, rttMs: 50 },
    ]);
    expect(profile.counts[0]).toBe(2);
    expect(profile.totalMs[0]).toBe(30);
    expect(profile.counts[RTT_SIZE_BIN_EDGES_BYTES.length]).toBe(1);
    expect(profile.totalMs[RTT_SIZE_BIN_EDGES_BYTES.length]).toBe(50);
    expect(profile.counts.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('histogramRttSamples', () => {
  test('bins are [prev edge, edge), first bin is <1ms, last is 5000+', () => {
    expect(histogramRttSamples([0, 0.5])[0]).toBe(2);
    // A sample exactly on an edge lands in the bin the edge opens.
    const atEdge = histogramRttSamples([1]);
    expect(atEdge[0]).toBe(0);
    expect(atEdge[1]).toBe(1);
    const overflow = histogramRttSamples([5000, 60000]);
    expect(overflow[RTT_HIST_EDGES_MS.length]).toBe(2);
  });

  test('counts sum to the sample count', () => {
    const samples = [0, 1, 3, 7, 59, 128, 438, 1229, 9999];
    const hist = histogramRttSamples(samples);
    expect(hist).toHaveLength(RTT_HIST_EDGES_MS.length + 1);
    expect(hist.reduce((a, b) => a + b, 0)).toBe(samples.length);
  });
});

describe('summarizeRttSamples', () => {
  test('returns undefined for an empty bucket', () => {
    expect(summarizeRttSamples([])).toBeUndefined();
  });

  test('single sample collapses every stat to that value', () => {
    expect(summarizeRttSamples([7])).toEqual({
      count: 1,
      best: 7,
      avg: 7,
      hist: histWith(7),
      p50: 7,
      p75: 7,
      p90: 7,
      p99: 7,
    });
  });

  test('percentiles use the runner convention (nearest-rank via ceil)', () => {
    // 1..100 shuffled: pQ must be exactly Q under nearest-rank.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1).sort(
      () => 0.5 - Math.random()
    );
    expect(summarizeRttSamples(samples)).toEqual({
      count: 100,
      best: 1,
      avg: 50.5,
      hist: histogramRttSamples(samples),
      p50: 50,
      p75: 75,
      p90: 90,
      p99: 99,
    });
  });

  test('rounds to 0.1ms', () => {
    const summary = summarizeRttSamples([1, 2, 2.44]);
    expect(summary?.avg).toBe(1.8);
    expect(summary?.p99).toBe(2.4);
  });
});

describe('summarizeDelayTail', () => {
  test('returns undefined for no samples', () => {
    expect(summarizeDelayTail([])).toBeUndefined();
  });

  test('max catches a single stall that pooled percentiles would hide', () => {
    // 299 jitter-floor samples plus ONE 800ms stall.
    const samples = [...Array.from({ length: 299 }, () => 2), 800];
    const tail = summarizeDelayTail(samples);
    expect(tail?.maxMs).toBe(800);
    // Even p99 over the pooled run misses a 1-in-300 stall (nearest-rank
    // p99 of 300 samples is the 297th) — which is why the runner reports
    // per-run max, not pooled percentiles.
    expect(tail?.p99Ms).toBe(2);
    expect(tail?.count).toBe(300);
    expect(tail?.avgMs).toBe(4.7);
  });
});

describe('steadyRate', () => {
  test('returns undefined when the window cannot define a rate', () => {
    expect(steadyRate([])).toBeUndefined();
    expect(steadyRate([{ atMs: 0, bytes: 100 }])).toBeUndefined();
    // Same-instant points: zero span.
    expect(
      steadyRate([
        { atMs: 5, bytes: 1 },
        { atMs: 5, bytes: 1 },
      ])
    ).toBeUndefined();
  });

  test('computes chunks/s and KiB/s over the trimmed steady window', () => {
    // 100 chunks of 1024B at exactly 10ms spacing → 100 c/s, 100 KiB/s.
    const points = Array.from({ length: 100 }, (_, i) => ({
      atMs: i * 10,
      bytes: 1024,
    }));
    const rate = steadyRate(points);
    expect(rate?.windowChunks).toBe(80); // 10% trimmed each side
    expect(rate?.chunksPerSec).toBe(100);
    // Bytes are counted over the window's 79 intervals (the first point's
    // bytes predate the window's clock): 79 KiB over 790ms = exactly the
    // stream's true steady rate, with no 1/(n-1) inflation.
    expect(rate?.kibPerSec).toBe(100);
  });

  test('trimming excludes warmup and drain from the sustained rate', () => {
    // A slow first and last chunk (cold start / final flush) that would
    // wreck the naive whole-run rate.
    const points = [
      { atMs: 0, bytes: 100 },
      ...Array.from({ length: 20 }, (_, i) => ({
        atMs: 1000 + i * 10,
        bytes: 100,
      })),
      { atMs: 10_000, bytes: 100 },
    ];
    const rate = steadyRate(points);
    // Steady window covers only the 10ms-spaced middle → ~100 c/s, not the
    // ~2 c/s the whole-run span would suggest.
    expect(rate?.chunksPerSec).toBeGreaterThan(90);
  });
});

describe('computeCdv', () => {
  // Chunks written every 10ms, delivered in clumps of three: the first of
  // each clump waits for the flush, the other two arrive ~together.
  const clumped = (): CdvArrival[] => [
    { seq: 0, writtenAt: 1000, readAt: 1030 },
    { seq: 1, writtenAt: 1010, readAt: 1030 },
    { seq: 2, writtenAt: 1020, readAt: 1031 },
    { seq: 3, writtenAt: 1030, readAt: 1060 },
    { seq: 4, writtenAt: 1040, readAt: 1060 },
    { seq: 5, writtenAt: 1050, readAt: 1061 },
  ];

  test('clumped delivery reads as negative catch-up plus positive stalls', () => {
    const { cdvMs, skippedPairs } = computeCdv(clumped());
    // (readGap - writeGap) per pair: (0-10), (1-10), (29-10), (0-10), (1-10).
    expect(cdvMs).toEqual([-10, -9, 19, -10, -9]);
    expect(skippedPairs).toBe(0);
  });

  test('equals the telescoping identity cdv_i = CTT_i - CTT_{i-1}', () => {
    const arrivals = clumped();
    const ctt = arrivals.map((a) => a.readAt - a.writtenAt);
    const { cdvMs } = computeCdv(arrivals);
    expect(cdvMs).toEqual(ctt.slice(1).map((v, i) => v - ctt[i]));
    // ...and the signed sum telescopes to CTT_last - CTT_first.
    expect(cdvMs.reduce((a, b) => a + b, 0)).toBe(ctt[ctt.length - 1] - ctt[0]);
  });

  test('is immune to a constant clock offset between writer and reader', () => {
    const skewed = clumped().map((a) => ({ ...a, readAt: a.readAt - 5000 }));
    // Reader clock 5s behind the writer: every CTT is negative, CDV is
    // untouched — each gap subtracts same-clock stamps.
    expect(computeCdv(skewed).cdvMs).toEqual(computeCdv(clumped()).cdvMs);
  });

  test('positive cdv is indexed by the later seq, padded to the stream', () => {
    const { positiveBySeq } = computeCdv(clumped());
    expect(positiveBySeq.length).toBe(6);
    expect(positiveBySeq[3]).toBe(19);
    expect(positiveBySeq.filter((v) => v !== undefined)).toEqual([19]);
  });

  test('counts duplicates, reorders, and non-adjacent pairs', () => {
    const arrivals: CdvArrival[] = [
      { seq: 0, writtenAt: 1000, readAt: 1030 },
      { seq: 2, writtenAt: 1020, readAt: 1050 }, // hole: skipped pair
      { seq: 1, writtenAt: 1010, readAt: 1051 }, // reorder: skipped pair
      { seq: 1, writtenAt: 1010, readAt: 1052 }, // duplicate + not adjacent
    ];
    const cdv = computeCdv(arrivals);
    expect(cdv.cdvMs).toEqual([]);
    expect(cdv.duplicateSeqs).toBe(1);
    expect(cdv.reorderedArrivals).toBe(1);
    expect(cdv.skippedPairs).toBe(3);
  });

  test('a single chunk has no pair', () => {
    const cdv = computeCdv([{ seq: 0, writtenAt: 1000, readAt: 1030 }]);
    expect(cdv.cdvMs).toEqual([]);
    expect(cdv.skippedPairs).toBe(0);
  });
});

describe('mergeRttSummaries', () => {
  const summary = (overrides: Partial<BenchRttSummary>): BenchRttSummary => ({
    count: 10,
    best: 1,
    avg: 5,
    hist: histWith(5, 10),
    p50: 5,
    p75: 6,
    p90: 8,
    p99: 9,
    ...overrides,
  });

  test('returns undefined when no iteration produced the bucket', () => {
    expect(mergeRttSummaries([])).toBeUndefined();
    expect(mergeRttSummaries([undefined, undefined])).toBeUndefined();
  });

  test('single summary passes through unchanged', () => {
    const s = summary({});
    expect(mergeRttSummaries([undefined, s])).toEqual(s);
  });

  test('count sums, best is the min, avg is count-weighted', () => {
    const merged = mergeRttSummaries([
      summary({ count: 10, best: 2, avg: 10 }),
      summary({ count: 30, best: 1, avg: 2 }),
    ]);
    expect(merged?.count).toBe(40);
    expect(merged?.best).toBe(1);
    expect(merged?.avg).toBe(4); // (10*10 + 2*30) / 40
  });

  test('histograms merge by elementwise summation (exact)', () => {
    const merged = mergeRttSummaries([
      summary({ count: 10, hist: histWith(5, 10) }),
      summary({ count: 30, hist: histWith(128, 30) }),
    ]);
    const expected = histWith(5, 10);
    const bin128 = histWith(128, 30);
    for (let i = 0; i < expected.length; i++) expected[i] += bin128[i];
    expect(merged?.hist).toEqual(expected);
    expect(merged?.hist.reduce((a, b) => a + b, 0)).toBe(40);
  });

  test('percentiles merge as percentile-of-percentiles', () => {
    const summaries = Array.from({ length: 10 }, (_, i) =>
      summary({ p50: i + 1, p90: (i + 1) * 10, p99: (i + 1) * 100 })
    );
    const merged = mergeRttSummaries(summaries);
    // p50 over the ten per-iteration p50s (1..10) = 5.
    expect(merged?.p50).toBe(5);
    // p90 over 10..100 = 90.
    expect(merged?.p90).toBe(90);
    // p99 over 100..1000 = max of maxes (exact at the tail).
    expect(merged?.p99).toBe(1000);
  });
});
