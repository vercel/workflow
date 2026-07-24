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
//   step-to-step overhead (STSO), and workflow overhead (WO).
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

import { createHook, getWorkflowMetadata, getWritable } from 'workflow';
import { getRun } from 'workflow/api';

export interface BenchStepTiming {
  /** Date.now() at step body entry */
  start: number;
  /** Date.now() at step body exit (just before step_completed is sent) */
  end: number;
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

async function timedNoopStep(index: number): Promise<BenchStepTiming> {
  'use step';
  const start = Date.now();
  // No body work: `end - start` is ~0, so the gap between consecutive step
  // timings is pure framework overhead.
  void index;
  return { start, end: Date.now() };
}

async function timedStreamingStep(chunks: number): Promise<BenchStepTiming> {
  'use step';
  const start = Date.now();
  const writable = getWritable<BenchStreamChunk>();
  const writer = writable.getWriter();
  for (let i = 0; i < chunks; i++) {
    await writer.write({ seq: i, writtenAt: Date.now() });
  }
  writer.releaseLock();
  // Close so the benchmark reader's read loop terminates.
  await writable.close();
  return { start, end: Date.now() };
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
