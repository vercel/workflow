// Pure bucketing + aggregation helpers for the chunk round-trip-time (CRTT)
// benchmark scenario. The workflow half lives in 97_bench.ts
// (benchCrttWorkflow) and the runner half in
// packages/core/e2e/benchmark.test.ts.
//
// This module is deliberately dependency-free so the same code runs in three
// places: the reader step aggregates per-chunk RTT samples on the deployment
// (keeping the workflow return value small — bucketed summaries, not hundreds
// of raw samples), the benchmark runner merges the per-iteration summaries
// into one row per bucket, and the unit tests
// (packages/core/src/bench-chunk-rtt-stats.test.ts) exercise both directly.

/**
 * Summary of one bucket's RTT samples (all values in ms, rounded to 0.1ms).
 * Computed inside the reader step per iteration (exact percentiles over that
 * iteration's samples), then merged across iterations by
 * {@link mergeRttSummaries}.
 */
export interface BenchRttSummary {
  /** Number of samples aggregated into this summary. */
  count: number;
  /** Fastest sample (min). */
  best: number;
  /** Mean — the exit criteria's headline "average per-chunk RTT". */
  avg: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
  /** Fixed-bin histogram of the samples (see {@link RTT_HIST_EDGES_MS}):
   * `hist[i]` counts samples in `[edges[i-1], edges[i])`, with `hist[0]`
   * below the first edge and the last entry at/above the last edge. Because
   * the edges are a shared constant, histograms merge exactly — across
   * iterations and across benchmark runs — unlike the percentile fields. */
  hist: number[];
}

// Histogram bin edges (ms), a 1-2-5 log series. Log-scale bins keep
// resolution at both ends of the plausible range — a warm in-region
// write->read can be single-digit ms while a stalled delivery is over a
// second — and fixed shared edges are what make cross-run histogram diffs
// exact (adaptive widths, like the STSO section's, cannot be re-binned once
// the raw samples have been left behind on the deployment).
export const RTT_HIST_EDGES_MS = [
  1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000,
];

/** Buckets samples into the fixed {@link RTT_HIST_EDGES_MS} bins. Returns
 * `edges.length + 1` counts (last = at/above the final edge). */
export function histogramRttSamples(samples: number[]): number[] {
  const counts = new Array(RTT_HIST_EDGES_MS.length + 1).fill(0);
  for (const v of samples) {
    let bin = 0;
    while (bin < RTT_HIST_EDGES_MS.length && v >= RTT_HIST_EDGES_MS[bin]) {
      bin++;
    }
    counts[bin]++;
  }
  return counts;
}

// Chunk-index buckets. Each boundary is tied to a mechanism, not a progress
// range:
// - 'seq 0': the stream-open write (stream creation / cold write path). Also
//   a cross-check against the SL scenario, which times the same first-chunk
//   propagation.
// - 'seq 1-20': warmup — the first ~200ms at the modeled 100 chunks/s, where
//   connections, buffers, and flush cycles are still settling.
// - 'seq 21+': steady state, kept as ONE bucket so its large n gives stable
//   tail percentiles (splitting it further just compares noise floors of
//   unequal sample sizes — iteration-level stalls land in whichever range
//   they land in).
// Latency *drift* across the stream (cumulative log/buffer growth) is a
// trend, which fixed buckets detect badly; that is the progress profile's
// job (see {@link progressProfile}).
export const RTT_INDEX_BUCKETS = ['seq 0', 'seq 1-20', 'seq 21+'] as const;
export type RttIndexBucket = (typeof RTT_INDEX_BUCKETS)[number];

export function rttIndexBucket(seq: number): RttIndexBucket {
  if (seq <= 0) return 'seq 0';
  if (seq <= 20) return 'seq 1-20';
  return 'seq 21+';
}

// Number of equal fractions of the stream in the progress profile. Ten keeps
// the profile line compact while still localizing a drift or a slow phase.
export const RTT_PROGRESS_BINS = 10;

/** A binned mean-RTT profile: `totalMs[i]`/`counts[i]` is the mean RTT of
 * bin i. Used for both the stream-progress profile (bin = tenth of the
 * stream) and the chunk-size profile (bin = log size range). Sums and counts
 * merge exactly across iterations and runs. */
export interface BenchRttMeanProfile {
  counts: number[];
  totalMs: number[];
}

/** Builds the progress profile from per-seq RTT samples (`rttBySeq[seq]` =
 * that chunk's RTT; sparse entries are skipped defensively). Fraction-based
 * (not absolute seq), so profiles are comparable across chunk counts. The
 * trend this surfaces — does per-chunk RTT rise as the stream grows? — is
 * what fixed index buckets cannot answer without arbitrary boundaries. */
export function progressProfile(
  rttBySeq: readonly (number | undefined)[]
): BenchRttMeanProfile {
  const counts = new Array(RTT_PROGRESS_BINS).fill(0);
  const totalMs = new Array(RTT_PROGRESS_BINS).fill(0);
  const n = rttBySeq.length;
  for (let seq = 0; seq < n; seq++) {
    const rtt = rttBySeq[seq];
    if (typeof rtt !== 'number') continue;
    const bin = Math.min(
      RTT_PROGRESS_BINS - 1,
      Math.floor((seq * RTT_PROGRESS_BINS) / n)
    );
    counts[bin]++;
    totalMs[bin] += rtt;
  }
  return { counts, totalMs };
}

/** Tail summary of a delay-style sample set where the MAX is the headline
 * (one bad event among hundreds vanishes into pooled percentiles but is, by
 * construction, the max). Used for write slip (producer-side lateness vs the
 * open-loop schedule) and for positive CDV (delivery clumps/stalls). */
export interface BenchDelayTail {
  count: number;
  avgMs: number;
  p99Ms: number;
  maxMs: number;
}

/** Summarizes delay samples into a {@link BenchDelayTail}. */
export function summarizeDelayTail(
  samples: number[]
): BenchDelayTail | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    avgMs: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    p99Ms: round(percentile(sorted, 99)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

/** Sustained throughput over the steady window of a run: the first and last
 * `trimFraction` of points (by index) are dropped so warmup (first-delivery
 * setup) and drain (final flush) don't flatter or damn the sustained rate. */
export interface BenchSteadyRate {
  chunksPerSec: number;
  kibPerSec: number;
  /** Points inside the steady window. */
  windowChunks: number;
  /** Wall span of the steady window (ms). */
  windowMs: number;
}

/** Computes the steady-window rate from per-chunk (timestamp, bytes) points
 * in stream order. Returns undefined when the window is too small to define
 * a rate (fewer than 2 points or zero span). */
export function steadyRate(
  points: readonly { atMs: number; bytes: number }[],
  trimFraction = 0.1
): BenchSteadyRate | undefined {
  const trim = Math.floor(points.length * trimFraction);
  const window = points.slice(trim, points.length - trim);
  if (window.length < 2) return undefined;
  const spanMs = window[window.length - 1].atMs - window[0].atMs;
  if (spanMs <= 0) return undefined;
  // Both rates count events over the window's intervals: n points span n-1
  // gaps, and the first point's bytes "arrived" before the window's clock
  // started — counting them would inflate a perfectly steady stream's
  // byte rate by 1/(n-1).
  const bytes = window.slice(1).reduce((sum, p) => sum + p.bytes, 0);
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    chunksPerSec: round(((window.length - 1) * 1000) / spanMs),
    kibPerSec: round((bytes * 1000) / spanMs / 1024),
    windowChunks: window.length,
    windowMs: spanMs,
  };
}

/** One received chunk's RAW timestamps, in arrival order. CDV must be
 * computed from unclamped values: clamping breaks the telescoping identity
 * and hides the negative (catch-up) half of every delivery clump. */
export interface CdvArrival {
  seq: number;
  writtenAt: number;
  readAt: number;
}

export interface BenchCdvComputation {
  /** Signed cdv per seq-adjacent arrival pair, in arrival order. */
  cdvMs: number[];
  /** Positive cdv indexed by the later chunk's seq — progressProfile input
   * (length is padded to max seq + 1 so fraction bins line up). */
  positiveBySeq: (number | undefined)[];
  duplicateSeqs: number;
  reorderedArrivals: number;
  /** Adjacent arrivals skipped because their seqs weren't consecutive. */
  skippedPairs: number;
}

/**
 * Chunk delay variation (delivery jitter): for seq-adjacent chunks received
 * back to back, cdv_i = (readAt_i - readAt_{i-1}) - (writtenAt_i -
 * writtenAt_{i-1}) = CTT_i - CTT_{i-1}. Each gap subtracts same-clock
 * stamps, so CDV is skew-free — measurable in production where cross-clock
 * CTT is not. Signed: clumped delivery of a 10ms-paced stream reads
 * (-10, -10, +20); the sum telescopes, so report the positive tail, not
 * means. Writer pauses self-exclude (both gaps grow equally). Pairs form
 * only for chunks adjacent in BOTH arrival order and seq (pairing
 * seq-sorted samples under reordering would manufacture phantom cdv);
 * duplicates/reorders/holes are counted for the caller to treat as
 * integrity failures.
 */
export function computeCdv(
  arrivals: readonly CdvArrival[]
): BenchCdvComputation {
  const seen = new Set<number>();
  const cdvMs: number[] = [];
  const positiveBySeq: (number | undefined)[] = [];
  let duplicateSeqs = 0;
  let reorderedArrivals = 0;
  let skippedPairs = 0;
  let maxSeq = -1;
  for (let i = 0; i < arrivals.length; i++) {
    const chunk = arrivals[i];
    if (seen.has(chunk.seq)) duplicateSeqs++;
    seen.add(chunk.seq);
    if (chunk.seq > maxSeq) maxSeq = chunk.seq;
    if (i === 0) continue; // the first arrival anchors; it has no pair
    const prev = arrivals[i - 1];
    if (chunk.seq < prev.seq) reorderedArrivals++;
    if (chunk.seq !== prev.seq + 1) {
      skippedPairs++;
      continue;
    }
    const cdv = chunk.readAt - prev.readAt - (chunk.writtenAt - prev.writtenAt);
    cdvMs.push(cdv);
    if (cdv > 0) positiveBySeq[chunk.seq] = cdv;
  }
  positiveBySeq.length = Math.max(positiveBySeq.length, maxSeq + 1);
  return {
    cdvMs,
    positiveBySeq,
    duplicateSeqs,
    reorderedArrivals,
    skippedPairs,
  };
}

/** Merges mean profiles by summation — exact, like the histograms. */
export function mergeMeanProfiles(
  profiles: readonly (BenchRttMeanProfile | undefined)[]
): BenchRttMeanProfile | undefined {
  const present = profiles.filter((p): p is BenchRttMeanProfile => p != null);
  if (present.length === 0) return undefined;
  const bins = Math.max(...present.map((p) => p.counts.length));
  const counts = new Array(bins).fill(0);
  const totalMs = new Array(bins).fill(0);
  for (const p of present) {
    for (let i = 0; i < bins; i++) {
      counts[i] += p.counts[i] ?? 0;
      totalMs[i] += p.totalMs[i] ?? 0;
    }
  }
  return { counts, totalMs };
}

// Chunk-size profile bins (approximate serialized bytes, doubling edges).
// Bin i covers [edges[i-1], edges[i]), bin 0 everything below 256B, and the
// last bin everything at/above 8KB. The size-sweep scenario's pad rotation
// (see CRTT_SWEEP_PAD_LENGTHS in 97_bench.ts) puts one padded size in each
// bin, so the mean-RTT-per-bin profile is a size→latency curve: flat means
// chunk size doesn't matter, a knee localizes where it starts to.
export const RTT_SIZE_BIN_EDGES_BYTES = [256, 512, 1024, 2048, 4096, 8192];

/** Bin index into {@link RTT_SIZE_BIN_EDGES_BYTES} for a serialized size. */
export function rttSizeBin(serializedBytes: number): number {
  let bin = 0;
  while (
    bin < RTT_SIZE_BIN_EDGES_BYTES.length &&
    serializedBytes >= RTT_SIZE_BIN_EDGES_BYTES[bin]
  ) {
    bin++;
  }
  return bin;
}

/** Builds the chunk-size profile from (serialized bytes, RTT) samples. */
export function sizeProfile(
  samples: readonly { bytes: number; rttMs: number }[]
): BenchRttMeanProfile {
  const bins = RTT_SIZE_BIN_EDGES_BYTES.length + 1;
  const counts = new Array(bins).fill(0);
  const totalMs = new Array(bins).fill(0);
  for (const { bytes, rttMs } of samples) {
    const bin = rttSizeBin(bytes);
    counts[bin]++;
    totalMs[bin] += rttMs;
  }
  return { counts, totalMs };
}

// Same percentile convention as the benchmark runner's computeStats
// (nearest-rank via ceil), so a CRTT p90 means the same thing as an SO p90.
function percentile(sortedAscending: number[], q: number): number {
  return sortedAscending[
    Math.min(
      sortedAscending.length - 1,
      Math.ceil((q / 100) * sortedAscending.length) - 1
    )
  ];
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Exact summary of one iteration's samples for a bucket; undefined when the
 * bucket received no samples (so the caller can just skip it). */
export function summarizeRttSamples(
  samples: number[]
): BenchRttSummary | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    best: round(sorted[0]),
    avg: round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length),
    hist: histogramRttSamples(sorted),
    p50: round(percentile(sorted, 50)),
    p75: round(percentile(sorted, 75)),
    p90: round(percentile(sorted, 90)),
    p99: round(percentile(sorted, 99)),
  };
}

/**
 * Merges per-iteration bucket summaries. count/best/avg (count-weighted) and
 * hist (elementwise over shared fixed bins) are exact; p50-p99 are
 * percentile-of-percentiles (raw samples never leave the reader step) —
 * exact only for single-sample iterations (e.g. seq 0), an approximation
 * for headline rows. Good enough for trend tracking; the histogram is the
 * exact pooled view.
 */
export function mergeRttSummaries(
  summaries: readonly (BenchRttSummary | undefined)[]
): BenchRttSummary | undefined {
  const present = summaries.filter((s): s is BenchRttSummary => s != null);
  if (present.length === 0) return undefined;
  const count = present.reduce((sum, s) => sum + s.count, 0);
  const mergedPercentile = (q: number, values: number[]) =>
    round(
      percentile(
        [...values].sort((a, b) => a - b),
        q
      )
    );
  const histLength = Math.max(...present.map((s) => s.hist?.length ?? 0));
  const hist = new Array(histLength).fill(0);
  for (const s of present) {
    (s.hist ?? []).forEach((c, i) => {
      hist[i] += c;
    });
  }
  return {
    count,
    best: round(Math.min(...present.map((s) => s.best))),
    avg: round(present.reduce((sum, s) => sum + s.avg * s.count, 0) / count),
    hist,
    p50: mergedPercentile(
      50,
      present.map((s) => s.p50)
    ),
    p75: mergedPercentile(
      75,
      present.map((s) => s.p75)
    ),
    p90: mergedPercentile(
      90,
      present.map((s) => s.p90)
    ),
    p99: mergedPercentile(
      99,
      present.map((s) => s.p99)
    ),
  };
}
