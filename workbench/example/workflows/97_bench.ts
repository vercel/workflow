// Benchmark workflows for performance measurement.
//
// The benchmark runner (packages/core/e2e/benchmark.test.ts) triggers these
// workflows through an in-deployment route (workbench app `/api/bench`) that
// stamps `clientStart` with the deployment's own clock right before calling
// `start()`. Every metric is then derived from timestamps recorded on the
// deployment — never from the CI runner's clock or its path to
// api.vercel.com:
//
// - Every step records `start`/`end` (`Date.now()` at body entry/exit) and the
//   workflow returns the collected timings. The runner combines them with the
//   in-deployment `clientStart` to compute time-to-first-step (TTFS),
//   step-to-step overhead (STSO), workflow overhead (WO), and — on the fan-out
//   scenario — the first/last step completion of a `Promise.all` (Fan-out
//   TTFS/TTLS).
// - `benchSlWorkflow` measures stream latency (SL) entirely on the deployment:
//   a reader step and a writer step run in parallel on a dedicated namespaced
//   stream, and the workflow returns both the writer's `writtenAt` and the
//   reader's `readAt` so SL (`readAt - writtenAt`) excludes the client read
//   path.
// - `benchSoWorkflow` measures stream overhead (SO), reusing the SL setup but
//   streaming a realistic LLM-shaped workload: a writer emits deterministic
//   variable-length token deltas paced at a fixed rate for a fixed duration
//   while a parallel reader drains the whole stream. The workflow returns the
//   writer's `writtenAt` and the reader's `doneAt`; the runner subtracts the
//   modelled generation window from `doneAt - writtenAt`, leaving the stream's
//   overhead/backpressure. Two payload shapes are supported so the runner can
//   isolate serialization cost: `'text'` (raw string fragments) and
//   `'structured'` (AI-SDK-style `{ type: 'text-delta', id, text }` objects).
// - `benchCrttWorkflow` measures per-chunk round-trip time (CRTT), reusing the
//   SO setup (paced writer + parallel reader, same deployment, so no clock
//   skew beyond intra-Vercel NTP bounds) but embedding `{ seq, writtenAt }` in
//   every chunk — the SL scenario's payload-embedded-timestamp trick applied
//   to the whole stream. The "round trip" is deployment -> stream backend ->
//   reader on the same deployment (one clock domain), not an echo back to the
//   writer. The reader stamps each chunk's arrival, computes
//   `rtt = Date.now() - chunk.writtenAt`, and aggregates on the deployment
//   (see 97_bench_rtt.ts): chunk-index buckets, mean-RTT profiles over stream
//   progress and over serialized chunk size, and fixed log-bin histograms —
//   compact aggregates instead of hundreds of raw samples.
// - `benchReplayWorkflow` reuses the whole CRTT measurement rig but replays a
//   REAL captured stream cadence (97_bench_cadence.ts): every write
//   instant and chunk size comes from the capture, so the replay scenario's
//   only chosen parameter is the speed multiplier.

import { createHook, getWorkflowMetadata, getWritable } from 'workflow';
import { getRun } from 'workflow/api';
import { BENCH_CADENCES } from './97_bench_cadence';
import {
  type BenchDelayTail,
  type BenchRttMeanProfile,
  type BenchRttSummary,
  type BenchSteadyRate,
  type CdvArrival,
  computeCdv,
  progressProfile,
  type RttIndexBucket,
  rttIndexBucket,
  sizeProfile,
  steadyRate,
  summarizeDelayTail,
  summarizeRttSamples,
} from './97_bench_rtt';

export interface BenchStepTiming {
  /** Date.now() at step body entry */
  start: number;
  /** Date.now() at step body exit (just before step_completed is sent) */
  end: number;
  /** 'queue-hop' if this is the first step body executed in this process
   * (module state persists across warm invocations, so a fresh process means
   * a cold start or a fresh dispatch from the queue after the previous
   * invocation ended); 'inline' for every subsequent step in the same
   * process. See {@link stepKind}. */
  kind: 'inline' | 'queue-hop';
}

// Process-global, initialized once per process. A fresh process (cold start,
// or redispatch via the queue after the prior invocation's ~duration limit)
// resets this to false, so the first step body it runs is tagged
// 'queue-hop'; every step after that in the same warm process is 'inline'.
let hasExecutedStepInProcess = false;

function stepKind(): 'inline' | 'queue-hop' {
  const kind = hasExecutedStepInProcess ? 'inline' : 'queue-hop';
  hasExecutedStepInProcess = true;
  return kind;
}

export interface BenchStreamChunk {
  seq: number;
  /** Date.now() in the step when this chunk was written */
  writtenAt: number;
}

export interface BenchStreamLatency {
  /** Date.now() in the writer step when the first chunk was written */
  writtenAt: number;
  /** Date.now() in the reader step when the first chunk was received */
  readAt: number;
}

export interface BenchStreamOverhead {
  /** Date.now() in the writer step just before the paced write loop begins */
  writtenAt: number;
  /** Date.now() in the reader step when the whole stream had been consumed */
  doneAt: number;
  /** Number of chunks the reader received (validated against the request) */
  received: number;
}

/** AI-SDK-style structured text delta streamed by the SO structured variant. */
export interface BenchTextDelta {
  type: 'text-delta';
  id: string;
  text: string;
}

/** A single SO chunk: either a raw text fragment or a structured delta. */
export type BenchStreamDelta = string | BenchTextDelta;

/** SO payload shape. `'text'` streams raw string fragments; `'structured'`
 * wraps each fragment in a {@link BenchTextDelta}, so the two scenarios differ
 * only in payload shape (same fragments, count, and pacing). */
export type BenchStreamOverheadMode = 'text' | 'structured';

// Dedicated stream for the SL scenario, kept off the default output stream so
// it never interacts with the default-stream lifecycle.
const SL_STREAM_NAMESPACE = 'bench-sl';
// A second stream used as a reader-ready barrier: the reader initiates its
// read on the SL stream, then writes a marker here; the writer blocks on this
// marker before writing to the SL stream. This guarantees the SL chunk is
// delivered to an already-attached reader (live write->read propagation)
// rather than being retained for a reader that started late — which a fixed
// sleep could not guarantee under scheduler delay or load.
const SL_READY_NAMESPACE = 'bench-sl-ready';

// Dedicated streams for the SO scenario (its own namespaces so it never
// interacts with the SL streams or the default output stream), plus the same
// reader-ready barrier pattern SL uses.
const SO_STREAM_NAMESPACE = 'bench-so';
const SO_READY_NAMESPACE = 'bench-so-ready';
// Dedicated streams for the CRTT scenario, same isolation + barrier pattern.
const CRTT_STREAM_NAMESPACE = 'bench-crtt';
const CRTT_READY_NAMESPACE = 'bench-crtt-ready';
// Deterministic, variable-length text fragments cycled to approximate real
// token-stream traffic (≈4.5 UTF-8 bytes on average, including punctuation and
// newline "tokens") while keeping every run byte-for-byte reproducible.
const SO_TEXT_FRAGMENTS = [
  'The',
  ' quick',
  ' brown',
  ' fox',
  ' jumps',
  ' over',
  ' the',
  ' lazy',
  ' dog',
  '.\n',
];
// AI-SDK text-delta events for a single text block share one id, so the
// structured variant keeps `id` constant and only varies `text`.
const SO_STRUCTURED_DELTA_ID = '0';

/** Builds the `index`-th SO chunk in the requested shape. Both shapes cycle the
 * same fragment list, so `'text'` vs `'structured'` isolates serialization
 * cost and nothing else. */
function soChunk(
  mode: BenchStreamOverheadMode,
  index: number
): BenchStreamDelta {
  const text = SO_TEXT_FRAGMENTS[index % SO_TEXT_FRAGMENTS.length];
  return mode === 'structured'
    ? { type: 'text-delta', id: SO_STRUCTURED_DELTA_ID, text }
    : text;
}

/** A self-timestamping CRTT chunk. `text` keeps the payload LLM-shaped (the
 * same cycled fragments the SO scenarios stream); the `'sweep'` variant adds
 * `pad` so the serialized chunk size rotates across the size buckets. */
export interface BenchChunkRttDelta {
  seq: number;
  /** Date.now() in the writer step immediately before this chunk's write */
  writtenAt: number;
  text: string;
  pad?: string;
}

/** CRTT payload variant. `'llm'` streams LLM-shaped deltas (a few tens of
 * bytes each, so the index numbers stay pure of padding); `'sweep'` pads
 * deltas in rotation across log-spaced sizes so mean RTT can be profiled as
 * a function of serialized chunk size. (The replay scenario replays real
 * captured cadences instead — see {@link benchReplayWorkflow}.) */
export type BenchChunkRttVariant = 'llm' | 'sweep';

/** Reader-side aggregation of one CRTT run: per-bucket summaries computed on
 * the deployment (see 97_bench_rtt.ts). Buckets that received no samples are
 * absent. */
/** Chunk delay variation for one run, aggregated in the reader step (see
 * computeCdv in 97_bench_rtt.ts for the definition and pairing rules). */
export interface BenchChunkCdv {
  /** Number of seq-adjacent pairs measured. */
  pairs: number;
  /** Adjacent arrivals whose seqs weren't consecutive (0 by contract). */
  skippedPairs: number;
  /** Tail of POSITIVE cdv — delivery clumps/stalls. Negatives (catch-up)
   * balance them by the telescoping identity and are not summarized. */
  positive?: BenchDelayTail;
  /** Mean positive cdv per tenth of the stream — localizes where delivery
   * clumping/stalls concentrate. */
  progress: BenchRttMeanProfile;
}

export interface BenchChunkRttResult {
  /** Number of chunks the reader received (validated against the request) */
  received: number;
  /** All chunks pooled — the headline "average per-chunk RTT" summary. */
  all?: BenchRttSummary;
  byIndex: Partial<Record<RttIndexBucket, BenchRttSummary>>;
  /** Mean RTT per tenth of the stream — the drift/trend readout that fixed
   * index buckets cannot provide (see progressProfile in 97_bench_rtt.ts). */
  progress: BenchRttMeanProfile;
  /** Mean RTT per log size bin — the size→latency curve (only informative
   * for the `'sweep'` variant, whose pad rotation occupies every bin). */
  size: BenchRttMeanProfile;
  /** Chunk delay variation (delivery jitter), from RAW timestamps. */
  cdv: BenchChunkCdv;
  /** Delivered (reader-side) sustained throughput over the steady window. */
  delivered?: BenchSteadyRate;
}

// Pad lengths cycled by the CRTT `'sweep'` variant: a log ladder chosen so
// the ~60B base chunk serializes to one representative size per size-profile
// bin (~160B, ~400B, ~760B, ~1.5KB, ~3KB, ~6KB, ~12KB — see
// RTT_SIZE_BIN_EDGES_BYTES in 97_bench_rtt.ts). Rotation decouples size from
// seq: every size appears throughout the stream, so the size profile is not
// confounded with warmup or drift.
const CRTT_SWEEP_PAD_LENGTHS = [100, 340, 700, 1400, 3000, 6000, 12000];

async function timedNoopStep(index: number): Promise<BenchStepTiming> {
  'use step';
  const kind = stepKind();
  const start = Date.now();
  // No body work: `end - start` is ~0, so the gap between consecutive step
  // timings is pure framework overhead.
  void index;
  return { start, end: Date.now(), kind };
}

async function timedStreamingStep(chunks: number): Promise<BenchStepTiming> {
  'use step';
  const kind = stepKind();
  const start = Date.now();
  const writable = getWritable<BenchStreamChunk>();
  const writer = writable.getWriter();
  for (let i = 0; i < chunks; i++) {
    await writer.write({ seq: i, writtenAt: Date.now() });
  }
  writer.releaseLock();
  // Close so the benchmark reader's read loop terminates.
  await writable.close();
  return { start, end: Date.now(), kind };
}

/**
 * Scenario 1a: one trivial no-op step — no stream, no hooks (turbo mode). The
 * cleanest TTFS measurement, with no stream machinery in the step body.
 */
export async function benchStepWorkflow(): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const step = await timedNoopStep(0);
  return { steps: [step] };
}

/**
 * Scenario 1b: one step that streams data back. No hooks, so the first
 * invocation runs in turbo mode. Used to measure TTFS (turbo) with a streaming
 * step body (contrast with {@link benchStepWorkflow}).
 */
export async function benchStreamWorkflow(): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const step = await timedStreamingStep(3);
  return { steps: [step] };
}

/**
 * Scenario 2: N trivial sequential steps. Used to measure STSO (the gap
 * between consecutive step body executions), reported per step-index range.
 */
export async function benchSequentialStepsWorkflow(count: number): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const steps: BenchStepTiming[] = [];
  for (let i = 0; i < count; i++) {
    steps.push(await timedNoopStep(i));
  }
  return { steps };
}

/**
 * Fan-out scenario: `count` trivial steps started together in one
 * `Promise.all`.
 *
 * Every step is dispatched from the same suspension, so the run's step
 * timings describe how the runtime spreads a fan-out: the earliest step body
 * to finish is the first branch a caller could observe, the latest is when
 * the whole fan-out is joinable. The runner turns those into Fan-out
 * TTFS/TTLS. Steps are the same no-op bodies the sequential scenario uses, so
 * the spread is dispatch and concurrency cost, not body work.
 */
export async function benchFanOutStepsWorkflow(count: number): Promise<{
  steps: BenchStepTiming[];
}> {
  'use workflow';
  const pending: Promise<BenchStepTiming>[] = [];
  for (let i = 0; i < count; i++) {
    pending.push(timedNoopStep(i));
  }
  return { steps: await Promise.all(pending) };
}

/**
 * Scenario 3: registers a hook, then runs one step.
 *
 * The fire-and-forget hook is never awaited — its `hook_created` event at the
 * first suspension makes the runtime exit turbo mode, so this scenario
 * measures the non-turbo TTFS path (contrast with
 * {@link benchStreamWorkflow}).
 */
export async function benchHookStreamWorkflow(): Promise<{
  steps: BenchStepTiming[];
  hookToken: string;
}> {
  'use workflow';
  const hook = createHook<never>();
  const step = await timedStreamingStep(3);
  return { steps: [step], hookToken: hook.token };
}

/** Reader half of the SL scenario. Reads via `getRun(runId).getReadable()` —
 * the same in-deployment path a co-located consumer uses, so the
 * api.vercel.com read path is never involved. Initiates the SL read (which
 * establishes the server-side stream connection), signals readiness on the
 * ready stream, then awaits the first chunk and stamps `readAt`. */
async function slReaderStep(): Promise<BenchStreamLatency> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  const reader = getRun<BenchStreamChunk>(workflowRunId)
    .getReadable<BenchStreamChunk>({ namespace: SL_STREAM_NAMESPACE })
    .getReader();
  try {
    // Initiate the read BEFORE signalling ready so the stream GET is in flight;
    // the writer only writes after observing the signal (plus its own
    // round-trip), by which point this reader is attached and blocked.
    const readPromise = reader.read();

    const ready = getWritable<{ ready: true }>({
      namespace: SL_READY_NAMESPACE,
    });
    const readyWriter = ready.getWriter();
    await readyWriter.write({ ready: true });
    readyWriter.releaseLock();
    await ready.close();

    const { value } = await readPromise;
    const readAt = Date.now();
    if (!value || typeof value.writtenAt !== 'number') {
      throw new Error(
        `bench SL reader: malformed first chunk ${JSON.stringify(value)?.slice(0, 120)}`
      );
    }
    return { writtenAt: value.writtenAt, readAt };
  } finally {
    // Best-effort: don't let a hanging cancel fail the run.
    reader.cancel().catch(() => {});
  }
}

/** Writer half of the SL scenario: blocks on the reader-ready marker, then
 * writes a single chunk stamped with `writtenAt` and closes the stream. The
 * barrier read only needs to observe the marker (a retained chunk is fine), so
 * its own attach timing doesn't matter — it just gates the SL write. */
async function slWriterStep(): Promise<void> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  const readyReader = getRun<{ ready: true }>(workflowRunId)
    .getReadable<{ ready: true }>({ namespace: SL_READY_NAMESPACE })
    .getReader();
  try {
    await readyReader.read();
  } finally {
    readyReader.cancel().catch(() => {});
  }

  const writable = getWritable<BenchStreamChunk>({
    namespace: SL_STREAM_NAMESPACE,
  });
  const writer = writable.getWriter();
  await writer.write({ seq: 0, writtenAt: Date.now() });
  writer.releaseLock();
  await writable.close();
}

/**
 * Scenario 4: stream latency (SL), measured entirely on the deployment.
 *
 * The reader and writer steps run in parallel on a dedicated namespaced
 * stream, coordinated by an explicit reader-ready barrier (a second stream):
 * the writer writes its `writtenAt` chunk only after the reader has initiated
 * its read and signalled readiness, so SL reflects live write->read
 * propagation rather than a late reader catching up on a retained chunk. Both
 * `writtenAt` and `readAt` are step-body `Date.now()` values on the
 * deployment, so the returned SL is independent of the CI client and the
 * api.vercel.com read path.
 */
export async function benchSlWorkflow(): Promise<{ sl: BenchStreamLatency }> {
  'use workflow';
  const [sl] = await Promise.all([slReaderStep(), slWriterStep()]);
  return { sl };
}

/** Reader half of the SO scenario. Same attach/ready handshake as
 * {@link slReaderStep}, but instead of stamping on the first chunk it drains
 * the whole stream and stamps `doneAt` once the writer has closed it, so the
 * measured window covers writing *and* consuming every chunk. */
async function soReaderStep(): Promise<{ doneAt: number; received: number }> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  // The reader only counts chunks and stamps the drain time, so it is agnostic
  // to the payload shape the writer chose.
  const reader = getRun<BenchStreamDelta>(workflowRunId)
    .getReadable<BenchStreamDelta>({ namespace: SO_STREAM_NAMESPACE })
    .getReader();
  try {
    // Initiate the read BEFORE signalling ready so the stream GET is in flight
    // by the time the writer starts (identical to the SL handshake).
    const firstRead = reader.read();

    const ready = getWritable<{ ready: true }>({
      namespace: SO_READY_NAMESPACE,
    });
    const readyWriter = ready.getWriter();
    await readyWriter.write({ ready: true });
    readyWriter.releaseLock();
    await ready.close();

    let received = 0;
    let result = await firstRead;
    while (!result.done) {
      received++;
      result = await reader.read();
    }
    return { doneAt: Date.now(), received };
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Writer half of the SO scenario: blocks on the reader-ready marker (as in
 * {@link slWriterStep}), then streams `chunkCount` token deltas (in the given
 * `mode`) paced to one every `intervalMs`. `writtenAt` is stamped just before
 * the loop, and each write is scheduled at `writtenAt + (i + 1) * intervalMs`,
 * so the write phase spans `chunkCount * intervalMs` by construction — the
 * modelled generation window. Pacing only sleeps while ahead of schedule; if
 * backpressure puts the writer behind, it writes immediately and that lost time
 * surfaces as SO. */
async function soWriterStep(
  chunkCount: number,
  intervalMs: number,
  mode: BenchStreamOverheadMode
): Promise<{ writtenAt: number }> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  const readyReader = getRun<{ ready: true }>(workflowRunId)
    .getReadable<{ ready: true }>({ namespace: SO_READY_NAMESPACE })
    .getReader();
  try {
    await readyReader.read();
  } finally {
    readyReader.cancel().catch(() => {});
  }

  const writable = getWritable<BenchStreamDelta>({
    namespace: SO_STREAM_NAMESPACE,
  });
  const writer = writable.getWriter();
  const writtenAt = Date.now();
  for (let i = 0; i < chunkCount; i++) {
    const delay = writtenAt + (i + 1) * intervalMs - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    await writer.write(soChunk(mode, i));
  }
  writer.releaseLock();
  await writable.close();
  return { writtenAt };
}

/**
 * Scenario 6: stream overhead (SO), measured entirely on the deployment.
 *
 * Reuses the SL scenario's dedicated-stream + reader-ready-barrier setup, but
 * models a realistic LLM streaming workload: the writer emits `chunkCount`
 * variable-length token deltas (shape chosen by `mode`) paced at one every
 * `intervalMs` (e.g. 300 chunks at 10ms ≈ a haiku-size LLM streaming ~100
 * tokens/s for 3s) while the reader drains the whole stream in parallel. The
 * workflow returns the writer's `writtenAt` and the reader's `doneAt`; the
 * runner subtracts the modelled generation window (`chunkCount * intervalMs`)
 * from `doneAt - writtenAt`, so SO isolates the stream's write+consume
 * overhead/backpressure on top of the token rate. Running it in both `'text'`
 * and `'structured'` mode isolates serialization cost.
 */
export async function benchSoWorkflow(
  chunkCount: number,
  intervalMs: number,
  mode: BenchStreamOverheadMode = 'text'
): Promise<{ so: BenchStreamOverhead }> {
  'use workflow';
  const [reader, writer] = await Promise.all([
    soReaderStep(),
    soWriterStep(chunkCount, intervalMs, mode),
  ]);
  return {
    so: {
      writtenAt: writer.writtenAt,
      doneAt: reader.doneAt,
      received: reader.received,
    },
  };
}

/** Reader half of the CRTT scenario. Same attach/ready handshake as
 * {@link soReaderStep}, but each received chunk is scored individually:
 * `rtt = Date.now() - chunk.writtenAt` (clamped at 0 to absorb tiny
 * intra-Vercel clock skew between the writer's and reader's instances) and
 * an approximate serialized size (`JSON.stringify` length — the payloads are
 * ASCII, so chars ≈ UTF-8 bytes). Raw (unclamped) timestamps are also kept
 * in arrival order for chunk delay variation — the skew-free
 * delivery-jitter companion metric (see computeCdv). Everything is
 * aggregated here in the step, so the workflow returns compact summaries
 * rather than one number per chunk. */
async function crttReaderStep(): Promise<BenchChunkRttResult> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  const reader = getRun<BenchChunkRttDelta>(workflowRunId)
    .getReadable<BenchChunkRttDelta>({ namespace: CRTT_STREAM_NAMESPACE })
    .getReader();
  try {
    // Initiate the read BEFORE signalling ready so the stream GET is in flight
    // by the time the writer starts (identical to the SL/SO handshake).
    const firstRead = reader.read();

    const ready = getWritable<{ ready: true }>({
      namespace: CRTT_READY_NAMESPACE,
    });
    const readyWriter = ready.getWriter();
    await readyWriter.write({ ready: true });
    readyWriter.releaseLock();
    await ready.close();

    const all: number[] = [];
    // RTT per seq (indexed by the chunk's own seq, not arrival order) so the
    // progress profile bins by position in the stream even if delivery ever
    // reorders.
    const rttBySeq: (number | undefined)[] = [];
    // RAW timestamps in arrival order for CDV — the clamped RTTs below must
    // never feed it (clamping breaks cdv_i = CTT_i - CTT_{i-1} and hides the
    // negative catch-up half of every clump). Bytes ride along for the
    // delivered-throughput computation.
    const arrivals: (CdvArrival & { bytes: number })[] = [];
    const sizeSamples: { bytes: number; rttMs: number }[] = [];
    const byIndex = new Map<RttIndexBucket, number[]>();
    let received = 0;
    let result = await firstRead;
    while (!result.done) {
      const receivedAt = Date.now();
      const chunk = result.value;
      if (
        !chunk ||
        typeof chunk.seq !== 'number' ||
        typeof chunk.writtenAt !== 'number'
      ) {
        throw new Error(
          `bench CRTT reader: malformed chunk ${JSON.stringify(chunk)?.slice(0, 120)}`
        );
      }
      const rtt = Math.max(0, receivedAt - chunk.writtenAt);
      all.push(rtt);
      rttBySeq[chunk.seq] = rtt;
      // Approximate serialized bytes (ASCII payloads, so chars ≈ bytes).
      const bytes = JSON.stringify(chunk).length;
      arrivals.push({
        seq: chunk.seq,
        writtenAt: chunk.writtenAt,
        readAt: receivedAt,
        // Extra field beyond CdvArrival — reused for delivered throughput.
        bytes,
      });
      sizeSamples.push({ bytes, rttMs: rtt });
      const bucket = rttIndexBucket(chunk.seq);
      const samples = byIndex.get(bucket);
      if (samples) samples.push(rtt);
      else byIndex.set(bucket, [rtt]);
      received++;
      result = await reader.read();
    }

    const summarize = <K extends string>(buckets: Map<K, number[]>) => {
      const out: Partial<Record<K, BenchRttSummary>> = {};
      for (const [bucket, samples] of buckets) {
        out[bucket] = summarizeRttSamples(samples);
      }
      return out;
    };
    const cdv = computeCdv(arrivals);
    // Ordered, complete delivery is this bench's contract; a violation is a
    // stream-integrity failure, not a latency data point. With no
    // duplicates and no reorders, zero skipped pairs plus a first seq of 0
    // makes the received sequence exactly contiguous 0..received-1 — the
    // runner's received-count check alone can't distinguish a hole from a
    // relabeled range.
    if (
      cdv.duplicateSeqs > 0 ||
      cdv.reorderedArrivals > 0 ||
      cdv.skippedPairs > 0 ||
      (arrivals.length > 0 && arrivals[0].seq !== 0)
    ) {
      throw new Error(
        `bench CRTT reader: stream integrity violated (duplicates=${cdv.duplicateSeqs}, reordered=${cdv.reorderedArrivals}, holes=${cdv.skippedPairs}, firstSeq=${arrivals[0]?.seq})`
      );
    }
    return {
      received,
      all: summarizeRttSamples(all),
      byIndex: summarize(byIndex),
      progress: progressProfile(rttBySeq),
      size: sizeProfile(sizeSamples),
      cdv: {
        pairs: cdv.cdvMs.length,
        skippedPairs: cdv.skippedPairs,
        positive: summarizeDelayTail(cdv.cdvMs.filter((v) => v > 0)),
        progress: progressProfile(cdv.positiveBySeq),
      },
      delivered: steadyRate(
        arrivals.map((a) => ({ atMs: a.readAt, bytes: a.bytes }))
      ),
    };
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Writer half of the CRTT scenario: identical pacing to {@link soWriterStep}
 * (ready barrier, then `chunkCount` chunks at one per `intervalMs`, writing
 * immediately when behind schedule), but every chunk is self-timestamping —
 * `writtenAt` is stamped immediately before its write — so the reader can
 * compute a per-chunk RTT instead of a whole-stream span.
 *
 * Also reports write slip: `writtenAt_i - scheduledAt_i`, how late each write
 * happened vs its open-loop schedule. This is the producer-stall guard
 * per-chunk RTT structurally cannot provide — a write delayed by
 * backpressure is stamped late, so its RTT still looks fine (coordinated
 * omission), but its slip grows. For slip to mean anything the schedule MUST
 * stay absolute from `startedAt` (as below): sleeping a fixed interval after
 * each awaited write would re-anchor the schedule to the writes themselves
 * (closed-loop) and hide the stall. */
async function crttWriterStep(
  chunkCount: number,
  intervalMs: number,
  variant: BenchChunkRttVariant
): Promise<{ slip?: BenchDelayTail; achieved?: BenchSteadyRate }> {
  'use step';
  const { workflowRunId } = getWorkflowMetadata();
  const readyReader = getRun<{ ready: true }>(workflowRunId)
    .getReadable<{ ready: true }>({ namespace: CRTT_READY_NAMESPACE })
    .getReader();
  try {
    await readyReader.read();
  } finally {
    readyReader.cancel().catch(() => {});
  }

  const writable = getWritable<BenchChunkRttDelta>({
    namespace: CRTT_STREAM_NAMESPACE,
  });
  const writer = writable.getWriter();
  const slips: number[] = [];
  const writes: { atMs: number; bytes: number }[] = [];
  const startedAt = Date.now();
  for (let i = 0; i < chunkCount; i++) {
    const scheduledAt = startedAt + (i + 1) * intervalMs;
    const delay = scheduledAt - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const chunk: BenchChunkRttDelta = {
      seq: i,
      writtenAt: Date.now(),
      text: SO_TEXT_FRAGMENTS[i % SO_TEXT_FRAGMENTS.length],
    };
    if (variant === 'sweep') {
      chunk.pad = 'x'.repeat(
        CRTT_SWEEP_PAD_LENGTHS[i % CRTT_SWEEP_PAD_LENGTHS.length]
      );
    }
    // Slip is stamped at the same instant as `writtenAt` (just before the
    // write is enqueued); the awaited write's own duration surfaces in the
    // NEXT chunk's slip when it pushes that chunk past its schedule.
    slips.push(Math.max(0, chunk.writtenAt - scheduledAt));
    writes.push({ atMs: chunk.writtenAt, bytes: JSON.stringify(chunk).length });
    await writer.write(chunk);
  }
  writer.releaseLock();
  await writable.close();
  return {
    slip: summarizeDelayTail(slips),
    // Achieved (writer-side) sustained rate over the steady window: under
    // healthy pacing ≈ the nominal rate; if writes block, this is what the
    // producer actually managed.
    achieved: steadyRate(writes),
  };
}

/**
 * Scenario 7: per-chunk round-trip time (CRTT), measured entirely on the
 * deployment.
 *
 * Same shape as the SO scenario (paced writer + parallel draining reader on a
 * dedicated namespaced stream, reader-ready barrier), but the measurement is
 * per chunk rather than per stream: every delta embeds `{ seq, writtenAt }`
 * (the SL scenario's payload-embedded-timestamp trick applied to all chunks),
 * and the reader computes each chunk's write->read RTT on arrival (the "round
 * trip" being deployment -> stream backend -> co-located reader, not an echo
 * back to the writer).
 *
 * Naming: CRTT (chunk ROUND-trip time) is reserved for this same-clock-domain
 * setup, where "round" is literally true — the chunk returns to the
 * deployment whose clock stamped it. The future production write->read
 * metric crosses clocks (producer deployment -> arbitrary consumer) and is a
 * one-way trip: that one is CTT (chunk trip time), a separate metric with
 * its own clock-skew caveats. Keep the names distinct. The reader aggregates the samples on the deployment
 * (see 97_bench_rtt.ts): chunk-index buckets, a per-tenth-of-stream progress
 * profile, a per-log-size-bin size profile, and fixed log-bin histograms so
 * distributions merge and diff exactly across runs. The `'llm'` variant
 * streams the same LLM-shaped deltas as SO (index/progress numbers pure of
 * padding); the `'sweep'` variant pads deltas in rotation across log-spaced
 * sizes (~160B to ~12KB serialized) so the size profile becomes a
 * size->latency curve.
 */
export async function benchCrttWorkflow(
  chunkCount: number,
  intervalMs: number,
  variant: BenchChunkRttVariant = 'llm'
): Promise<{
  crtt: BenchChunkRttResult;
  writeSlip?: BenchDelayTail;
  achieved?: BenchSteadyRate;
}> {
  'use workflow';
  const [crtt, writer] = await Promise.all([
    crttReaderStep(),
    crttWriterStep(chunkCount, intervalMs, variant),
  ]);
  return { crtt, writeSlip: writer.slip, achieved: writer.achieved };
}

/** Writer half of the replay scenario: identical structure to
 * {@link crttWriterStep} (ready barrier, absolute open-loop schedule, slip +
 * achieved-rate reporting), but the schedule and per-chunk sizes come from a
 * REAL captured eve cadence (see 97_bench_cadence.ts) instead of a fixed
 * interval: chunk i is scheduled at `startedAt + offsetsMs[i] / speed` and
 * padded so its serialized size matches the capture. Missed ticks are never
 * re-spread — overdue chunks write back-to-back and the lost time surfaces
 * as slip (open-loop; see the crttWriterStep caveat). */
async function replayWriterStep(
  cadenceId: string,
  speed: number
): Promise<{ slip?: BenchDelayTail; achieved?: BenchSteadyRate }> {
  'use step';
  const cadence = BENCH_CADENCES[cadenceId];
  if (!cadence) {
    throw new Error(`bench replay writer: unknown cadence "${cadenceId}"`);
  }
  const { workflowRunId } = getWorkflowMetadata();
  const readyReader = getRun<{ ready: true }>(workflowRunId)
    .getReadable<{ ready: true }>({ namespace: CRTT_READY_NAMESPACE })
    .getReader();
  try {
    await readyReader.read();
  } finally {
    readyReader.cancel().catch(() => {});
  }

  const writable = getWritable<BenchChunkRttDelta>({
    namespace: CRTT_STREAM_NAMESPACE,
  });
  const writer = writable.getWriter();
  const slips: number[] = [];
  const writes: { atMs: number; bytes: number }[] = [];
  const startedAt = Date.now();
  for (let i = 0; i < cadence.offsetsMs.length; i++) {
    const scheduledAt = startedAt + cadence.offsetsMs[i] / speed;
    const delay = scheduledAt - Date.now();
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    const chunk: BenchChunkRttDelta = {
      seq: i,
      writtenAt: Date.now(),
      text: SO_TEXT_FRAGMENTS[i % SO_TEXT_FRAGMENTS.length],
    };
    // Pad the delta so its serialized size matches the captured event's
    // (~60B envelope of seq/writtenAt/text; exactness beyond a few bytes
    // doesn't matter — the doubling size bins absorb it).
    const pad = cadence.sizes[i] - 60;
    if (pad > 0) chunk.pad = 'x'.repeat(pad);
    slips.push(Math.max(0, chunk.writtenAt - scheduledAt));
    writes.push({ atMs: chunk.writtenAt, bytes: JSON.stringify(chunk).length });
    await writer.write(chunk);
  }
  writer.releaseLock();
  await writable.close();
  return { slip: summarizeDelayTail(slips), achieved: steadyRate(writes) };
}

/**
 * Scenario 8: cadence replay, measured entirely on the deployment.
 *
 * Same reader, barrier, and measurement machinery as {@link benchCrttWorkflow}
 * (per-chunk CRTT, CDV, profiles, delivered rate), but the writer replays a
 * REAL captured eve stream cadence at `speed`x: every write instant and every
 * chunk size comes from the capture, so nothing about the workload shape is a
 * judgment call except the speed multiplier. Eve's protocol re-ships the
 * cumulative message per delta, so sizes ramp through the turn — the
 * end-of-turn byte-rate peak is part of the workload, not an accident.
 */
export async function benchReplayWorkflow(
  cadenceId: string,
  speed: number
): Promise<{
  crtt: BenchChunkRttResult;
  writeSlip?: BenchDelayTail;
  achieved?: BenchSteadyRate;
}> {
  'use workflow';
  const [crtt, writer] = await Promise.all([
    crttReaderStep(),
    replayWriterStep(cadenceId, speed),
  ]);
  return { crtt, writeSlip: writer.slip, achieved: writer.achieved };
}
