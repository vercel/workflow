import { globalSingleton } from './global-singleton.js';

const PROJECT_ID = 'prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm';
const ULID = '[01234567][0-9A-HJKMNP-TV-Z]{25}';
const RUN = new RegExp(`^wrun_(${ULID})$`);
const STREAM = new RegExp(`^strm_(${ULID})_user_YmVuY2gtY3R0$`);
const WRITER = new RegExp(`^wrtr_${ULID}$`);
const MAX_TUPLES = 64;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_RECORDS_PER_LANE = 192;
const MAX_LINES_PER_LANE = 8;
const MAX_ACTIVE_SESSIONS = 64;

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

type Session = {
  lane: Lane;
  runId: string;
  name: string;
  writerId?: string;
  id: number;
  tuples: Tuple[];
  attempted: number;
  omitted: number;
  emitted: number;
  sinkFailures: number;
  lines: number;
  finished: boolean;
};

type DiagnosticState = {
  nextSession: number;
  sink?: Sink;
  sessions: Map<string, Session>;
};

const state = globalSingleton<DiagnosticState>(
  'workflow.stream.slowdown-diagnostics',
  2,
  () => ({ nextSession: 1, sessions: new Map() })
);

export type StreamDiagnostic = {
  event(phase: string, a?: number, b?: number, c?: number, d?: number): void;
  checkpoint(outcome: string): void;
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

/** Test seams only. State is process-global because bundled module copies are not. */
export function getActiveStreamDiagnosticSessionsForTest(): number {
  return state.sessions.size;
}

export function setStreamDiagnosticSinkForTest(sink?: Sink): void {
  state.sink = sink;
  state.sessions.clear();
}

function sessionKey(lane: Lane, runId: string, name: string): string {
  return `${lane}\0${runId}\0${name}`;
}

/**
 * Bounded, best-effort client stream diagnostic. All handles for one logical
 * lane/run/stream share one sequence, budget, and session across bundled layers.
 */
export function createStreamDiagnostic(
  lane: Lane,
  runId: string,
  name: string,
  writerId?: string
): StreamDiagnostic | undefined {
  if (!isStreamSlowdownDiagnosticsEnabled(runId, name, writerId)) return;
  const key = sessionKey(lane, runId, name);
  let session = state.sessions.get(key);
  if (!session || session.finished) {
    // Never evict a live session: doing so would silently fork its continuity.
    // New keys fail closed until a terminal owner frees capacity.
    if (state.sessions.size >= MAX_ACTIVE_SESSIONS) return;
    session = {
      lane,
      runId,
      name,
      writerId,
      id: state.nextSession++,
      tuples: [],
      attempted: 0,
      omitted: 0,
      emitted: 0,
      sinkFailures: 0,
      lines: 0,
      finished: false,
    };
    state.sessions.set(key, session);
  } else if (writerId) {
    session.writerId ??= writerId;
  }
  const shared = session;

  const emit = (
    kind: 'batch' | 'checkpoint' | 'teardown',
    outcome?: string
  ) => {
    if (shared.tuples.length === 0 && kind === 'batch') return;
    if (shared.lines >= MAX_LINES_PER_LANE) {
      shared.omitted += shared.tuples.length;
      shared.tuples.length = 0;
      return;
    }
    const batch = shared.tuples.slice(0, MAX_TUPLES);
    const record = {
      v: 2,
      diagnostic: 'workflow-stream-slowdown',
      lane: shared.lane,
      kind,
      runId: shared.runId,
      streamId: shared.name,
      ...(shared.writerId ? { writerId: shared.writerId } : {}),
      session: shared.id,
      clock: 'performance.now',
      timeOrigin: performance.timeOrigin,
      firstSeq: batch[0]?.[0] ?? null,
      lastSeq: batch.at(-1)?.[0] ?? null,
      tuples: batch,
      attempted: shared.attempted,
      omitted: shared.omitted,
      emitted: shared.emitted + batch.length,
      sinkFailures: shared.sinkFailures,
      ...(outcome ? { outcome } : {}),
    };
    try {
      const line = JSON.stringify(record);
      if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) {
        shared.omitted += batch.length;
        shared.tuples.splice(0, batch.length);
        return;
      }
      (state.sink ?? console.log)(line);
      shared.emitted += batch.length;
      shared.tuples.splice(0, batch.length);
      shared.lines++;
    } catch {
      shared.sinkFailures++;
      shared.omitted += batch.length;
      shared.tuples.splice(0, batch.length);
    }
  };

  return {
    event(phase, a, b, c, d) {
      if (shared.finished) return;
      shared.attempted++;
      if (shared.attempted > MAX_RECORDS_PER_LANE) {
        shared.omitted++;
        return;
      }
      try {
        shared.tuples.push([
          shared.attempted,
          performance.now(),
          phase,
          a,
          b,
          c,
          d,
        ]);
        if (shared.tuples.length >= MAX_TUPLES) emit('batch');
      } catch {
        shared.omitted++;
      }
    },
    checkpoint(outcome) {
      if (!shared.finished) emit('checkpoint', outcome);
    },
    finish(outcome) {
      if (shared.finished) return;
      shared.finished = true;
      emit('teardown', outcome);
      state.sessions.delete(key);
    },
  };
}

export const STREAM_DIAGNOSTIC_LIMITS = {
  maxTuplesPerLine: MAX_TUPLES,
  maxLineBytes: MAX_LINE_BYTES,
  maxRecordsPerLane: MAX_RECORDS_PER_LANE,
  maxLinesPerLane: MAX_LINES_PER_LANE,
  maxActiveSessions: MAX_ACTIVE_SESSIONS,
} as const;
