import { globalSingleton } from './global-singleton.js';

const PROJECT_ID = 'prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm';
const ULID = '[01234567][0-9A-HJKMNP-TV-Z]{25}';
const RUN = new RegExp(`^wrun_(${ULID})$`);
const STREAM = new RegExp(`^strm_(${ULID})_user_YmVuY2gtY3R0$`);
const WRITER = new RegExp(`^wrtr_${ULID}$`);
const MAX_TUPLES = 48;
const MAX_LINE_BYTES = 16 * 1024;
// Deliberately retained from the raw recorder. It now bounds incident/detail
// records, not completed groups; normal group continuity has its own budget.
const MAX_RECORDS_PER_LANE = 192;
const MAX_COMPLETED_WRITE_GROUPS = 2_720;
const MAX_READ_RECORDS = 64;
const MAX_NORMAL_LINES = 72;
const MAX_ACTIVE_SESSIONS = 64;
const MAX_LIVE_GROUPS = 8;
const MAX_LIVE_REQUESTS = 2;

type Lane = 'read' | 'write';
type Sink = (line: string) => void;
type Offset = number | null;
export type CompletedWriteTuple = readonly [
  groupOrdinal: number,
  reqId: number | null,
  chunkSeq: number,
  chunkCount: number,
  chunkBytes: number,
  connectionGeneration: number | null,
  connectionAttempt: number | null,
  outcome: 'ws_success' | 'http_success' | 'http_fallback_success' | 'rejected',
  coreDispatch: Offset,
  sessionEntry: Offset,
  encodeBegin: Offset,
  encodeEnd: Offset,
  wsSendCall: Offset,
  wsSendReturn: Offset,
  wsSendCallback: Offset,
  rawMessageCallback: Offset,
  decodeComplete: Offset,
  pendingResolve: Offset,
  sessionReturn: Offset,
  coreSettle: Offset,
];

type GroupTiming = {
  ordinal: number;
  reqId?: number;
  chunkSeq: number;
  count: number;
  bytes: number;
  generation?: number;
  attempt?: number;
  coreDispatch?: number;
  sessionEntry?: number;
  encodeBegin?: number;
  encodeEnd?: number;
  wsSendCall?: number;
  wsSendReturn?: number;
  wsSendCallback?: number;
  rawMessageCallback?: number;
  decodeComplete?: number;
  pendingResolve?: number;
  sessionReturn?: number;
  coreSettle?: number;
  rejected?: boolean;
  httpFallback?: boolean;
};

type ReadConnection = {
  ordinal: number;
  startIndex?: number;
  reconnect?: number;
  dispatch?: number;
  entry?: number;
  fetchCall?: number;
  headers?: number;
  rawFirst?: number;
  firstFrame?: number;
  status?: number;
  rawBytes?: number;
  frameIndex?: number;
  frameBytes?: number;
  outcome?: string;
};

type Session = {
  lane: Lane;
  runId: string;
  name: string;
  writerId?: string;
  id: number;
  startedAt: number;
  completed: CompletedWriteTuple[];
  groups: Map<number, GroupTiming>;
  requests: Map<number, number>;
  writeHttpFallback: boolean;
  currentConnection?: ReadConnection;
  readConnections: ReadConnection[];
  readDecoded: number;
  readDecodedBytes: number;
  readEnqueued: number;
  readEnqueuedBytes: number;
  readLatencyTotal: number;
  readLatencyMax: number;
  readLatencySamples: number;
  readLatencyOmitted: number;
  lastDecodedAt?: number;
  incidents: Array<readonly [number, string, number?, number?, number?]>;
  attempted: number;
  emitted: number;
  omitted: number;
  groupsAttempted: number;
  groupsEmitted: number;
  groupsOmitted: number;
  chunksAttempted: number;
  chunksEmitted: number;
  chunksOmitted: number;
  bytesAttempted: number;
  bytesEmitted: number;
  bytesOmitted: number;
  sinkFailures: number;
  lines: number;
  overflow: boolean;
  finished: boolean;
};

type DiagnosticState = {
  nextSession: number;
  sink?: Sink;
  sessions: Map<string, Session>;
};

const state = globalSingleton<DiagnosticState>(
  'workflow.stream.slowdown-diagnostics',
  3,
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

function offset(value: number | undefined, base: number | undefined): Offset {
  return value === undefined || base === undefined ? null : value - base;
}

function completeGroup(shared: Session, group: GroupTiming): void {
  shared.groups.delete(group.ordinal);
  if (group.reqId !== undefined) shared.requests.delete(group.reqId);
  const outcome = group.rejected
    ? 'rejected'
    : group.httpFallback
      ? 'http_fallback_success'
      : group.reqId === undefined
        ? 'http_success'
        : 'ws_success';
  const tuple: CompletedWriteTuple = [
    group.ordinal,
    group.reqId ?? null,
    group.chunkSeq,
    group.count,
    group.bytes,
    group.generation ?? null,
    group.attempt ?? null,
    outcome,
    offset(group.coreDispatch, group.coreDispatch),
    offset(group.sessionEntry, group.coreDispatch),
    offset(group.encodeBegin, group.coreDispatch),
    offset(group.encodeEnd, group.coreDispatch),
    offset(group.wsSendCall, group.coreDispatch),
    offset(group.wsSendReturn, group.coreDispatch),
    offset(group.wsSendCallback, group.coreDispatch),
    offset(group.rawMessageCallback, group.coreDispatch),
    offset(group.decodeComplete, group.coreDispatch),
    offset(group.pendingResolve, group.coreDispatch),
    offset(group.sessionReturn, group.coreDispatch),
    offset(group.coreSettle, group.coreDispatch),
  ];
  shared.groupsAttempted++;
  shared.chunksAttempted += group.count;
  shared.bytesAttempted += group.bytes;
  if (shared.groupsAttempted <= MAX_COMPLETED_WRITE_GROUPS) {
    shared.completed.push(tuple);
  } else {
    shared.overflow = true;
    shared.groupsOmitted++;
    shared.chunksOmitted += group.count;
    shared.bytesOmitted += group.bytes;
  }
}

function addIncident(
  shared: Session,
  phase: string,
  at: number,
  a?: number,
  b?: number,
  c?: number
): void {
  shared.attempted++;
  if (shared.incidents.length >= MAX_RECORDS_PER_LANE) {
    shared.omitted++;
    shared.overflow = true;
    return;
  }
  shared.incidents.push([at - shared.startedAt, phase, a, b, c]);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: fixed-shape envelope accounting keeps all continuity counters adjacent
function emit(
  shared: Session,
  kind: 'batch' | 'terminal',
  outcome?: string
): void {
  if (kind === 'batch' && shared.completed.length === 0) return;
  if (kind === 'batch' && shared.lines >= MAX_NORMAL_LINES) return;
  const tuples = shared.completed.slice(0, MAX_TUPLES);
  const readConnections =
    kind === 'terminal'
      ? shared.readConnections.slice(0, MAX_READ_RECORDS)
      : [];
  const incidents = kind === 'terminal' ? shared.incidents : [];
  const record = {
    v: 3,
    diagnostic: 'workflow-stream-slowdown',
    lane: shared.lane,
    kind,
    runId: shared.runId,
    streamId: shared.name,
    ...(shared.writerId ? { writerId: shared.writerId } : {}),
    session: shared.id,
    clock: 'performance.now',
    timeOrigin: performance.timeOrigin,
    writeTupleSchema:
      shared.lane === 'write' ? 'completed-group-v1' : undefined,
    tuples,
    readConnections,
    readAggregate:
      shared.lane === 'read'
        ? {
            decoded: shared.readDecoded,
            decodedBytes: shared.readDecodedBytes,
            enqueued: shared.readEnqueued,
            enqueuedBytes: shared.readEnqueuedBytes,
            latencyTotalMs: shared.readLatencyTotal,
            latencyMaxMs: shared.readLatencyMax,
            latencySamples: shared.readLatencySamples,
            latencyOmitted: shared.readLatencyOmitted,
          }
        : undefined,
    incidents,
    attempted: shared.attempted,
    emitted: shared.emitted + tuples.length,
    omitted: shared.omitted,
    groupsAttempted: shared.groupsAttempted,
    groupsEmitted: shared.groupsEmitted + tuples.length,
    groupsOmitted: shared.groupsOmitted,
    chunksAttempted: shared.chunksAttempted,
    chunksEmitted:
      shared.chunksEmitted + tuples.reduce((n, tuple) => n + tuple[3], 0),
    chunksOmitted: shared.chunksOmitted,
    bytesAttempted: shared.bytesAttempted,
    bytesEmitted:
      shared.bytesEmitted + tuples.reduce((n, tuple) => n + tuple[4], 0),
    bytesOmitted: shared.bytesOmitted,
    overflow: shared.overflow,
    sinkFailures: shared.sinkFailures,
    liveGroups: shared.groups.size,
    liveRequests: shared.requests.size,
    ...(outcome ? { outcome } : {}),
  };
  try {
    const line = JSON.stringify(record);
    if (new TextEncoder().encode(line).byteLength > MAX_LINE_BYTES) {
      // Batch size is selected so completed tuples fit. Terminal detail is
      // expendable: retry once without bounded incident/setup detail while
      // retaining counters and teardown continuity.
      if (kind === 'terminal') {
        const compact = JSON.stringify({
          ...record,
          readConnections: [],
          incidents: [],
        });
        if (new TextEncoder().encode(compact).byteLength <= MAX_LINE_BYTES) {
          (state.sink ?? console.log)(compact);
          shared.lines++;
          return;
        }
      }
      shared.overflow = true;
      return;
    }
    (state.sink ?? console.log)(line);
    shared.emitted += tuples.length;
    shared.groupsEmitted += tuples.length;
    shared.chunksEmitted += tuples.reduce((n, tuple) => n + tuple[3], 0);
    shared.bytesEmitted += tuples.reduce((n, tuple) => n + tuple[4], 0);
    shared.completed.splice(0, tuples.length);
    shared.lines++;
  } catch {
    shared.sinkFailures++;
    shared.omitted += tuples.length;
    shared.groupsOmitted += tuples.length;
    shared.chunksOmitted += tuples.reduce((n, tuple) => n + tuple[3], 0);
    shared.bytesOmitted += tuples.reduce((n, tuple) => n + tuple[4], 0);
    shared.completed.splice(0, tuples.length);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one dispatcher mirrors named lifecycle seams without changing their control flow
function processWriteEvent(
  shared: Session,
  phase: string,
  at: number,
  a?: number,
  b?: number,
  c?: number,
  d?: number
): boolean {
  let group: GroupTiming | undefined;
  if (
    phase === 'core_buffer_dispatch' &&
    a &&
    b !== undefined &&
    c !== undefined &&
    d !== undefined
  ) {
    if (shared.groups.size >= MAX_LIVE_GROUPS && !shared.groups.has(a)) {
      shared.overflow = true;
      addIncident(shared, 'live_group_overflow', at, a);
      return true;
    }
    group = shared.groups.get(a) ?? {
      ordinal: a,
      chunkSeq: b,
      count: c,
      bytes: d,
      httpFallback: shared.writeHttpFallback,
    };
    group.coreDispatch = at;
    shared.groups.set(a, group);
    return true;
  }
  if (
    (phase === 'session_write_entry' ||
      phase === 'session_write_return' ||
      phase === 'session_write_reject' ||
      phase === 'core_flush_settle') &&
    a
  ) {
    group = shared.groups.get(a);
    if (
      !group &&
      phase === 'session_write_entry' &&
      b !== undefined &&
      c !== undefined &&
      d !== undefined
    ) {
      group = {
        ordinal: a,
        chunkSeq: b,
        count: c,
        bytes: d,
        httpFallback: shared.writeHttpFallback,
      };
      shared.groups.set(a, group);
    }
    if (!group) return true;
    if (phase === 'session_write_entry') group.sessionEntry = at;
    else if (phase === 'session_write_return') {
      group.sessionReturn = at;
      // A direct world-vercel session has no core owner to provide settle.
      if (group.coreDispatch === undefined) completeGroup(shared, group);
    } else if (phase === 'session_write_reject') {
      group.sessionReturn = at;
      group.rejected = true;
      completeGroup(shared, group);
    } else {
      group.coreSettle = at;
      completeGroup(shared, group);
    }
    return true;
  }
  if (phase === 'encode_begin' && a !== undefined) {
    const ordinal = d;
    group = ordinal === undefined ? undefined : shared.groups.get(ordinal);
    if (!group || shared.requests.size >= MAX_LIVE_REQUESTS) {
      shared.overflow = true;
      addIncident(shared, 'live_request_overflow', at, a);
      return true;
    }
    group.reqId = a;
    group.encodeBegin = at;
    shared.requests.set(a, group.ordinal);
    return true;
  }
  if (
    a !== undefined &&
    [
      'encode_end',
      'ws_send_call',
      'ws_send_return',
      'ws_send_callback',
      'raw_correlated_message',
      'decode_complete',
      'pending_resolve',
    ].includes(phase)
  ) {
    const ordinal = shared.requests.get(a);
    group =
      ordinal === undefined
        ? [...shared.groups.values()].find((candidate) => candidate.reqId === a)
        : shared.groups.get(ordinal);
    if (!group) return true;
    if (phase === 'encode_end') group.encodeEnd = at;
    else if (phase === 'ws_send_call') {
      group.wsSendCall = at;
      group.attempt = c;
      group.generation = c;
    } else if (phase === 'ws_send_return') group.wsSendReturn = at;
    else if (phase === 'ws_send_callback') group.wsSendCallback = at;
    else if (phase === 'raw_correlated_message') {
      group.rawMessageCallback = c ?? at;
    } else if (phase === 'decode_complete') group.decodeComplete = at;
    else {
      group.pendingResolve = at;
      shared.requests.delete(a);
    }
    return true;
  }
  if (phase.startsWith('fallback_http')) {
    shared.writeHttpFallback = true;
    for (const ordinal of shared.requests.values()) {
      group = shared.groups.get(ordinal);
      if (group) group.httpFallback = true;
    }
    return false;
  }
  return false;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one dispatcher mirrors named lifecycle seams without wrappers or awaits
function processReadEvent(
  shared: Session,
  phase: string,
  at: number,
  a?: number,
  b?: number
): boolean {
  if (phase === 'get_dispatch') {
    if (
      shared.currentConnection &&
      !shared.readConnections.includes(shared.currentConnection)
    ) {
      shared.currentConnection.outcome ??= 'reconnect';
      if (shared.readConnections.length < MAX_READ_RECORDS) {
        shared.readConnections.push(shared.currentConnection);
      } else {
        shared.overflow = true;
      }
    }
    shared.currentConnection = {
      ordinal: shared.readConnections.length + 1,
      startIndex: a,
      reconnect: b,
      dispatch: at,
    };
    return true;
  }
  const connection = shared.currentConnection;
  if (phase === 'get_entry') {
    if (!connection)
      shared.currentConnection = {
        ordinal: shared.readConnections.length + 1,
        startIndex: a,
      };
    (shared.currentConnection as ReadConnection).entry = at;
    return true;
  }
  if (phase === 'instrumented_fetch_entry') {
    if (connection) connection.entry ??= at;
    return true;
  }
  if (phase === 'fetch_call') {
    if (connection) connection.fetchCall = at;
    return true;
  }
  if (phase === 'headers_received') {
    if (connection) {
      connection.headers = at;
      connection.status = a;
    }
    return true;
  }
  if (phase === 'raw_first_nonempty_body_chunk') {
    if (connection) {
      connection.rawFirst = at;
      connection.rawBytes = a;
    }
    return true;
  }
  if (phase === 'first_complete_outer_frame') {
    if (connection) {
      connection.firstFrame = at;
      connection.frameIndex = a;
      connection.frameBytes = b;
      connection.outcome = 'first_frame';
      if (shared.readConnections.length < MAX_READ_RECORDS)
        shared.readConnections.push(connection);
      else shared.overflow = true;
    }
    return true;
  }
  if (phase === 'decoded_delivery') {
    shared.readDecoded++;
    shared.readDecodedBytes += b ?? 0;
    if (shared.lastDecodedAt !== undefined) shared.readLatencyOmitted++;
    shared.lastDecodedAt = at;
    return true;
  }
  if (phase === 'deserialize_complete') return true;
  if (phase === 'consumer_enqueue') {
    shared.readEnqueued++;
    shared.readEnqueuedBytes += a ?? 0;
    if (shared.lastDecodedAt !== undefined) {
      const latency = at - shared.lastDecodedAt;
      shared.readLatencyTotal += latency;
      shared.readLatencyMax = Math.max(shared.readLatencyMax, latency);
      shared.readLatencySamples++;
      shared.lastDecodedAt = undefined;
    }
    return true;
  }
  return false;
}

/**
 * Bounded, best-effort client stream diagnostic. All handles for one logical
 * lane/run/stream share aggregation, budgets, and terminal ownership.
 */
export function createStreamDiagnostic(
  lane: Lane,
  runId: string,
  name: string,
  writerId?: string
): StreamDiagnostic | undefined {
  if (lane === 'write' && (!writerId || !WRITER.test(writerId))) return;
  if (!isStreamSlowdownDiagnosticsEnabled(runId, name, writerId)) return;
  const key = sessionKey(lane, runId, name);
  let session = state.sessions.get(key);
  if (!session || session.finished) {
    if (state.sessions.size >= MAX_ACTIVE_SESSIONS) return;
    session = {
      lane,
      runId,
      name,
      writerId,
      id: state.nextSession++,
      startedAt: performance.now(),
      completed: [],
      groups: new Map(),
      requests: new Map(),
      writeHttpFallback: false,
      readConnections: [],
      readDecoded: 0,
      readDecodedBytes: 0,
      readEnqueued: 0,
      readEnqueuedBytes: 0,
      readLatencyTotal: 0,
      readLatencyMax: 0,
      readLatencySamples: 0,
      readLatencyOmitted: 0,
      incidents: [],
      attempted: 0,
      emitted: 0,
      omitted: 0,
      groupsAttempted: 0,
      groupsEmitted: 0,
      groupsOmitted: 0,
      chunksAttempted: 0,
      chunksEmitted: 0,
      chunksOmitted: 0,
      bytesAttempted: 0,
      bytesEmitted: 0,
      bytesOmitted: 0,
      sinkFailures: 0,
      lines: 0,
      overflow: false,
      finished: false,
    };
    state.sessions.set(key, session);
  } else if (writerId) session.writerId ??= writerId;
  const shared = session;

  return {
    event(phase, a, b, c, d) {
      if (shared.finished) return;
      try {
        const at = performance.now();
        const handled =
          shared.lane === 'write'
            ? processWriteEvent(shared, phase, at, a, b, c, d)
            : processReadEvent(shared, phase, at, a, b);
        if (!handled) addIncident(shared, phase, at, a, b, c);
        if (shared.completed.length >= MAX_TUPLES) emit(shared, 'batch');
      } catch {
        shared.omitted++;
      }
    },
    checkpoint(outcome) {
      if (!shared.finished) addIncident(shared, outcome, performance.now());
    },
    finish(outcome) {
      if (shared.finished) return;
      shared.finished = true;
      for (const group of shared.groups.values()) {
        group.rejected = true;
        completeGroup(shared, group);
      }
      if (shared.lane === 'read' && shared.lastDecodedAt !== undefined) {
        shared.readLatencyOmitted++;
        shared.lastDecodedAt = undefined;
      }
      if (
        shared.lane === 'read' &&
        shared.currentConnection &&
        !shared.readConnections.includes(shared.currentConnection)
      ) {
        shared.currentConnection.outcome = outcome;
        if (shared.readConnections.length < MAX_READ_RECORDS) {
          shared.readConnections.push(shared.currentConnection);
        } else {
          shared.overflow = true;
        }
      }
      while (shared.completed.length > MAX_TUPLES) emit(shared, 'batch');
      emit(shared, 'terminal', outcome);
      shared.groups.clear();
      shared.requests.clear();
      state.sessions.delete(key);
    },
  };
}

export const STREAM_DIAGNOSTIC_LIMITS = {
  maxTuplesPerLine: MAX_TUPLES,
  maxLineBytes: MAX_LINE_BYTES,
  maxRecordsPerLane: MAX_RECORDS_PER_LANE,
  maxCompletedWriteGroups: MAX_COMPLETED_WRITE_GROUPS,
  maxNormalLines: MAX_NORMAL_LINES,
  maxActiveSessions: MAX_ACTIVE_SESSIONS,
  maxLiveGroups: MAX_LIVE_GROUPS,
  maxLiveRequests: MAX_LIVE_REQUESTS,
} as const;
