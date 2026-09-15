import { globalSingleton } from './global-singleton.js';

const PROJECT_ID = 'prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm';
const RUN = /^wrun_([0-9A-HJKMNP-TV-Z]{26})$/;
const STREAM = /^strm_([0-9A-HJKMNP-TV-Z]{26})_user_YmVuY2gtY3R0$/;
const WRITER = /^wrtr_[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;
const MAX_TUPLES = 64;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_RECORDS_PER_LANE = 192;

type Lane = 'read' | 'write';
type Sink = (line: string) => void;
type Tuple = readonly [
  number,
  number,
  string,
  number?,
  number?,
  number?,
  number?,
];

type DiagnosticState = {
  nextSession: number;
  sink?: Sink;
};

const state = globalSingleton<DiagnosticState>(
  'workflow.stream.slowdown-diagnostics',
  1,
  () => ({ nextSession: 1 })
);

export type StreamDiagnostic = {
  event(phase: string, a?: number, b?: number, c?: number, d?: number): void;
  finish(outcome: string): void;
};

export function isCanonicalBenchCttStream(
  runId: string,
  name: string
): boolean {
  const run = RUN.exec(runId);
  const stream = STREAM.exec(name);
  return Boolean(run && stream && run[1] === stream[1]);
}

export function isStreamSlowdownDiagnosticsEnabled(
  runId: string,
  name: string,
  writerId?: string
): boolean {
  return (
    process.env.WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS === 'true' &&
    process.env.VERCEL_ENV === 'preview' &&
    process.env.VERCEL_PROJECT_ID === PROJECT_ID &&
    isCanonicalBenchCttStream(runId, name) &&
    (writerId === undefined || WRITER.test(writerId))
  );
}

/** Test seam only. The sink is process-global because bundled module copies are not. */
export function setStreamDiagnosticSinkForTest(sink?: Sink): void {
  state.sink = sink;
}

/**
 * Bounded, best-effort client stream diagnostic. Timestamps are performance.now()
 * values from one process clock. Logging is never allowed to affect stream work.
 */
export function createStreamDiagnostic(
  lane: Lane,
  runId: string,
  name: string,
  writerId?: string
): StreamDiagnostic | undefined {
  if (!isStreamSlowdownDiagnosticsEnabled(runId, name, writerId)) return;
  const session = state.nextSession++;
  const tuples: Tuple[] = [];
  let attempted = 0;
  let omitted = 0;
  let emitted = 0;
  let sinkFailures = 0;
  let finished = false;

  const emit = (kind: 'batch' | 'teardown', outcome?: string): void => {
    if (tuples.length === 0 && kind === 'batch') return;
    const batch = tuples.splice(0, MAX_TUPLES);
    const record = {
      v: 1,
      diagnostic: 'workflow-stream-slowdown',
      lane,
      kind,
      runId,
      streamId: name,
      ...(writerId ? { writerId } : {}),
      session,
      clock: 'performance.now',
      timeOrigin: performance.timeOrigin,
      firstSeq: batch[0]?.[0] ?? null,
      lastSeq: batch.at(-1)?.[0] ?? null,
      tuples: batch,
      attempted,
      omitted,
      emitted: emitted + batch.length,
      sinkFailures,
      ...(outcome ? { outcome } : {}),
    };
    try {
      const line = JSON.stringify(record);
      // The tuple cap normally provides this bound; fail closed if future fields
      // grow instead of emitting an oversized platform log record.
      if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) {
        omitted += batch.length;
        return;
      }
      (state.sink ?? console.log)(line);
      emitted += batch.length;
    } catch {
      sinkFailures++;
    }
  };

  return {
    event(phase, a, b, c, d) {
      if (finished) return;
      attempted++;
      if (attempted > MAX_RECORDS_PER_LANE) {
        omitted++;
        return;
      }
      try {
        tuples.push([attempted, performance.now(), phase, a, b, c, d]);
        if (tuples.length >= MAX_TUPLES) emit('batch');
      } catch {
        omitted++;
      }
    },
    finish(outcome) {
      if (finished) return;
      finished = true;
      emit('teardown', outcome);
    },
  };
}

export const STREAM_DIAGNOSTIC_LIMITS = {
  maxTuplesPerLine: MAX_TUPLES,
  maxLineBytes: MAX_LINE_BYTES,
  maxRecordsPerLane: MAX_RECORDS_PER_LANE,
} as const;
