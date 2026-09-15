import { afterEach, describe, expect, it, vi } from 'vitest';
import { BENCH_CADENCES } from '../../../workbench/example/workflows/97_bench_cadence.js';
import {
  MAX_BYTES_PER_BATCH,
  MAX_CHUNKS_PER_BATCH,
} from '../../core/src/flushable-stream.js';
import {
  createStreamDiagnostic,
  isStreamSlowdownDiagnosticsEnabled,
  STREAM_DIAGNOSTIC_LIMITS,
  setStreamDiagnosticSinkForTest,
} from './stream-diagnostics.js';

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RUN = `wrun_${ULID}`;
const STREAM = `strm_${ULID}_user_YmVuY2gtY3R0`;
const WRITER = `wrtr_${ULID}`;

function enable(): void {
  process.env.VERCEL_ENV = 'preview';
  process.env.VERCEL_PROJECT_ID = 'prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm';
}

afterEach(() => {
  delete process.env.WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS;
  delete process.env.VERCEL_ENV;
  delete process.env.VERCEL_PROJECT_ID;
  setStreamDiagnosticSinkForTest(undefined);
});

describe('stream slowdown diagnostic gate', () => {
  it('activates with no runtime toggle when preview, project, and canonical IDs match', () => {
    enable();
    delete process.env.WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS;
    expect(isStreamSlowdownDiagnosticsEnabled(RUN, STREAM, WRITER)).toBe(true);
    process.env.WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS = 'false';
    expect(isStreamSlowdownDiagnosticsEnabled(RUN, STREAM, WRITER)).toBe(true);
  });

  it('fails closed for the wrong environment, project, run, stream, or writer', () => {
    enable();
    for (const [run, stream, writer] of [
      [
        `wrun_${'A'.repeat(26)}`,
        `strm_${'A'.repeat(26)}_user_YmVuY2gtY3R0`,
        `wrtr_${'A'.repeat(26)}`,
      ],
      [RUN, STREAM, `wrtr_${'A'.repeat(26)}`],
      [RUN, `strm_${ULID}_user_YmVuY2gtY3R0LXJlYWR5`, WRITER],
      [RUN, `${STREAM}-near`, WRITER],
      ['invalid', STREAM, WRITER],
      [RUN, STREAM, `writer_${ULID}`],
    ]) {
      expect(isStreamSlowdownDiagnosticsEnabled(run, stream, writer)).toBe(
        false
      );
    }
    process.env.VERCEL_PROJECT_ID = 'prj_other';
    expect(isStreamSlowdownDiagnosticsEnabled(RUN, STREAM, WRITER)).toBe(false);
    process.env.VERCEL_PROJECT_ID = 'prj_bXW1R9CdeOvxy0kOk0i4iFGrFMAm';
    process.env.VERCEL_ENV = 'production';
    expect(isStreamSlowdownDiagnosticsEnabled(RUN, STREAM, WRITER)).toBe(false);
  });

  it('requires a canonical writer ID when creating write diagnostics', () => {
    enable();
    const sink = vi.fn();
    setStreamDiagnosticSinkForTest(sink);

    expect(createStreamDiagnostic('write', RUN, STREAM)).toBeUndefined();
    expect(
      createStreamDiagnostic('write', RUN, STREAM, `writer_${ULID}`)
    ).toBeUndefined();
    expect(sink).not.toHaveBeenCalled();

    expect(createStreamDiagnostic('read', RUN, STREAM)).toBeDefined();
  });

  it('cannot be enabled by request data and emits no payload/header/error text', () => {
    const sink = vi.fn();
    setStreamDiagnosticSinkForTest(sink);
    process.env = {
      ...process.env,
      authorization: 'secret',
    };
    expect(createStreamDiagnostic('read', RUN, STREAM)).toBeUndefined();
    expect(sink).not.toHaveBeenCalled();

    enable();
    const diagnostic = createStreamDiagnostic('read', RUN, STREAM);
    expect(diagnostic).toBeDefined();
    if (!diagnostic) throw new Error('expected diagnostic');
    diagnostic.event('safe_phase', 123);
    diagnostic.finish('safe_outcome');
    const line = sink.mock.calls[0][0] as string;
    expect(line).not.toContain('secret');
    expect(line).not.toContain('authorization');
    expect(JSON.parse(line)).toMatchObject({
      diagnostic: 'workflow-stream-slowdown',
      lane: 'read',
      outcome: 'safe_outcome',
    });
  });
});

describe('stream slowdown diagnostic aggregation and bounds', () => {
  function recordCompletedGroup(
    diagnostic: NonNullable<ReturnType<typeof createStreamDiagnostic>>,
    ordinal: number,
    bytes = 37,
    chunkSeq = ordinal - 1,
    chunkCount = 1
  ): void {
    const reqId = ordinal;
    diagnostic.event(
      'core_buffer_dispatch',
      ordinal,
      chunkSeq,
      chunkCount,
      bytes
    );
    diagnostic.event(
      'session_write_entry',
      ordinal,
      chunkSeq,
      chunkCount,
      bytes
    );
    diagnostic.event('encode_begin', reqId, chunkSeq, chunkCount, ordinal);
    diagnostic.event('encode_end', reqId, bytes + 12, 1);
    diagnostic.event('ws_send_call', reqId, bytes + 12, 1);
    diagnostic.event('ws_send_callback', reqId, 0, 1);
    diagnostic.event('ws_send_return', reqId, 1);
    diagnostic.event('raw_correlated_message', reqId, 9, performance.now());
    diagnostic.event('decode_complete', reqId, 9);
    diagnostic.event('pending_resolve', reqId);
    diagnostic.event(
      'session_write_return',
      ordinal,
      chunkSeq,
      chunkCount,
      bytes
    );
    diagnostic.event('core_flush_settle', ordinal, chunkSeq, chunkCount, bytes);
  }

  it('retains the actual 2,593-event single-chunk cadence through the tail', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');

    const cadence = BENCH_CADENCES['eve-gpt-5.6-sol-2000t'];
    expect(cadence.sizes).toHaveLength(cadence.events);
    expect(cadence.sizes.reduce((sum, bytes) => sum + bytes, 0)).toBe(
      cadence.totalBytes
    );
    // Worst-case transport shape: every real captured event settles before the
    // next arrives, so all 2,593 captured sizes form singleton groups.
    cadence.sizes.forEach((bytes, index) => {
      recordCompletedGroup(diagnostic, index + 1, bytes);
    });
    diagnostic.finish('closed_ws');

    const totalBytes = lines.reduce(
      (sum, line) => sum + Buffer.byteLength(line),
      0
    );
    expect(lines.length).toBeLessThan(80);
    expect(totalBytes).toBeLessThan(1024 * 1024);
    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(
        STREAM_DIAGNOSTIC_LIMITS.maxLineBytes
      );
    }
    const records = lines.map((line) => JSON.parse(line));
    const tuples = records.flatMap((record) => record.tuples);
    expect(tuples).toHaveLength(2_593);
    expect(tuples.map((tuple: number[]) => tuple[0])).toEqual(
      Array.from({ length: 2_593 }, (_, i) => i + 1)
    );
    expect(tuples.map((tuple: number[]) => tuple[1])).toEqual(
      Array.from({ length: 2_593 }, (_, i) => i + 1)
    );
    expect(tuples.map((tuple: number[]) => tuple.slice(2, 5))).toEqual(
      cadence.sizes.map((bytes, index) => [index, 1, bytes])
    );
    expect(tuples.at(-1)?.[7]).toBe('ws_success');
    expect(records.at(-1)).toMatchObject({
      kind: 'terminal',
      outcome: 'closed_ws',
      groupsAttempted: 2_593,
      groupsEmitted: 2_593,
      groupsOmitted: 0,
      chunksAttempted: 2_593,
      chunksEmitted: 2_593,
      chunksOmitted: 0,
      bytesAttempted: 17_144_887,
      bytesEmitted: 17_144_887,
      bytesOmitted: 0,
      overflow: false,
      sinkFailures: 0,
      liveGroups: 0,
      liveRequests: 0,
    });
  });

  it('preserves actual fixture ranges when packed to production request caps', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');
    const cadence = BENCH_CADENCES['eve-gpt-5.6-sol-2000t'];
    const groups: Array<{ chunkSeq: number; count: number; bytes: number }> =
      [];
    for (let chunkSeq = 0; chunkSeq < cadence.sizes.length; ) {
      let count = 0;
      let bytes = 0;
      while (
        chunkSeq + count < cadence.sizes.length &&
        count < MAX_CHUNKS_PER_BATCH &&
        (count === 0 ||
          bytes + cadence.sizes[chunkSeq + count] <= MAX_BYTES_PER_BATCH)
      ) {
        bytes += cadence.sizes[chunkSeq + count];
        count++;
      }
      groups.push({ chunkSeq, count, bytes });
      chunkSeq += count;
    }
    groups.forEach((group, index) => {
      recordCompletedGroup(
        diagnostic,
        index + 1,
        group.bytes,
        group.chunkSeq,
        group.count
      );
    });
    diagnostic.finish('closed_ws');
    const records = lines.map((line) => JSON.parse(line));
    const tuples = records.flatMap((record) => record.tuples);
    expect(tuples.map((tuple: number[]) => tuple.slice(2, 5))).toEqual(
      groups.map(({ chunkSeq, count, bytes }) => [chunkSeq, count, bytes])
    );
    expect(groups.at(-1)?.chunkSeq + (groups.at(-1)?.count ?? 0)).toBe(2_593);
    expect(records.at(-1)).toMatchObject({
      chunksAttempted: 2_593,
      chunksEmitted: 2_593,
      chunksOmitted: 0,
      bytesAttempted: cadence.totalBytes,
      bytesEmitted: cadence.totalBytes,
      bytesOmitted: 0,
      overflow: false,
    });
  });

  it('represents bootstrap HTTP groups and rejected groups without invented phases', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');
    diagnostic.event('core_buffer_dispatch', 1, 0, 1, 12);
    diagnostic.event('session_write_entry', 1, 0, 1, 12);
    diagnostic.event('session_write_return', 1, 0, 1, 12);
    diagnostic.event('core_flush_settle', 1, 0, 1, 12);
    diagnostic.event('core_buffer_dispatch', 2, 1, 1, 13);
    diagnostic.event('session_write_entry', 2, 1, 1, 13);
    diagnostic.event('session_write_reject', 2);
    diagnostic.event('fallback_http', 1);
    diagnostic.checkpoint('fallback_http_connect_rejected');
    diagnostic.event('core_buffer_dispatch', 3, 2, 1, 14);
    diagnostic.event('session_write_entry', 3, 2, 1, 14);
    diagnostic.event('session_write_return', 3, 2, 1, 14);
    diagnostic.event('core_flush_settle', 3, 2, 1, 14);
    diagnostic.finish('poisoned');
    const tuples = lines.flatMap((line) => JSON.parse(line).tuples);
    expect(tuples[0].slice(0, 8)).toEqual([
      1,
      null,
      0,
      1,
      12,
      null,
      null,
      'http_success',
    ]);
    expect(tuples[0].slice(10, 18)).toEqual(Array(8).fill(null));
    expect(tuples[1][7]).toBe('rejected');
    expect(tuples[2][7]).toBe('http_fallback_success');
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      outcome: 'poisoned',
    });
  });

  it('ignores an unscoped control request without hiding a malformed data group', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');

    diagnostic.event('encode_begin', 1);
    diagnostic.event('encode_end', 1, 12, 1);
    diagnostic.event('ws_send_call', 1, 12, 1);
    diagnostic.event('ws_send_callback', 1, 0, 1);
    diagnostic.event('ws_send_return', 1, 1);
    diagnostic.event('raw_correlated_message', 1, 9, performance.now());
    diagnostic.event('decode_complete', 1, 9);
    diagnostic.event('pending_resolve', 1);
    diagnostic.event('encode_begin', 2, 0, 1, 99);
    diagnostic.finish('closed_ws');

    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      overflow: true,
      liveGroups: 0,
      liveRequests: 0,
      incidents: [expect.arrayContaining(['live_request_overflow', 2])],
    });
  });

  it('does not attribute an uncorrelated control message to a pending write', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');
    diagnostic.event('core_buffer_dispatch', 1, 0, 1, 12);
    diagnostic.event('session_write_entry', 1, 0, 1, 12);
    diagnostic.event('encode_begin', 1, 0, 1, 1);
    diagnostic.event('ws_send_call', 1, 12, 1);
    diagnostic.event('raw_control_message', 9);
    diagnostic.event('session_write_reject', 1);
    diagnostic.finish('poisoned');
    const record = JSON.parse(lines.at(-1) ?? '{}');
    expect(record.tuples[0][15]).toBeNull();
    expect(
      record.incidents.some(
        ([, phase]: [number, string]) => phase === 'raw_control_message'
      )
    ).toBe(true);
  });

  it('keeps terminal reserve after a throwing sink and reports continuity loss', () => {
    enable();
    const lines: string[] = [];
    let throwOnce = true;
    setStreamDiagnosticSinkForTest((line) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('private sink text');
      }
      lines.push(line);
    });
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');
    for (let i = 1; i <= 49; i++) recordCompletedGroup(diagnostic, i);
    diagnostic.finish('closed_ws');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      kind: 'terminal',
      sinkFailures: 1,
      groupsAttempted: 49,
      groupsEmitted: 1,
      groupsOmitted: 48,
      chunksOmitted: 48,
    });
  });

  it('emits exact overflow counters beyond the normal group budget', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');
    for (
      let i = 1;
      i <= STREAM_DIAGNOSTIC_LIMITS.maxCompletedWriteGroups + 1;
      i++
    ) {
      recordCompletedGroup(diagnostic, i, 1);
    }
    diagnostic.finish('closed_ws');
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      overflow: true,
      groupsAttempted: STREAM_DIAGNOSTIC_LIMITS.maxCompletedWriteGroups + 1,
      groupsOmitted: 1,
      chunksOmitted: 1,
      bytesOmitted: 1,
    });
  });

  it('aggregates all selected reads while retaining bounded setup records', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('read', RUN, STREAM);
    if (!diagnostic) throw new Error('expected diagnostic');
    diagnostic.event('get_dispatch', 0, 0);
    diagnostic.event('get_entry', 0);
    diagnostic.event('instrumented_fetch_entry', 0);
    diagnostic.event('fetch_call');
    diagnostic.event('headers_received', 200);
    diagnostic.event('raw_first_nonempty_body_chunk', 100);
    diagnostic.event('first_complete_outer_frame', 0, 44);
    for (let i = 0; i < 2_593; i++) {
      diagnostic.event('decoded_delivery', i, 44);
      diagnostic.event('deserialize_complete', 40);
      diagnostic.event('consumer_enqueue', 40);
    }
    diagnostic.finish('reader_eof');
    const record = JSON.parse(lines.at(-1) ?? '{}');
    expect(lines).toHaveLength(1);
    expect(record.readConnections).toHaveLength(1);
    expect(record.readAggregate).toMatchObject({
      decoded: 2_593,
      decodedBytes: 2_593 * 44,
      enqueued: 2_593,
      enqueuedBytes: 2_593 * 40,
    });
    expect(record.readAggregate.latencyTotalMs).toBeGreaterThanOrEqual(0);
    expect(record.readAggregate.latencyMaxMs).toBeGreaterThanOrEqual(0);
    expect(record.readAggregate.latencySamples).toBe(2_593);
    expect(record.readAggregate.latencyOmitted).toBe(0);
    expect(record.incidents.length).toBeLessThanOrEqual(
      STREAM_DIAGNOSTIC_LIMITS.maxRecordsPerLane
    );
  });

  it('accounts for latency coverage when one raw pull yields multiple frames', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('read', RUN, STREAM);
    if (!diagnostic) throw new Error('expected diagnostic');
    diagnostic.event('decoded_delivery', 0, 10);
    diagnostic.event('decoded_delivery', 1, 20);
    diagnostic.event('decoded_delivery', 2, 30);
    diagnostic.event('consumer_enqueue', 6);
    diagnostic.event('consumer_enqueue', 7);
    diagnostic.event('consumer_enqueue', 8);
    diagnostic.finish('reader_eof');
    expect(JSON.parse(lines.at(-1) ?? '{}').readAggregate).toMatchObject({
      decoded: 3,
      decodedBytes: 60,
      enqueued: 3,
      enqueuedBytes: 21,
      latencySamples: 1,
      latencyOmitted: 2,
    });
  });

  it('caps unfinished unique sessions without evicting live continuity', () => {
    enable();
    const handles = Array.from(
      { length: STREAM_DIAGNOSTIC_LIMITS.maxActiveSessions + 1 },
      (_, i) => {
        const ulid = `0${i.toString().padStart(25, '0')}`;
        return createStreamDiagnostic(
          'read',
          `wrun_${ulid}`,
          `strm_${ulid}_user_YmVuY2gtY3R0`
        );
      }
    );
    expect(handles.filter(Boolean)).toHaveLength(
      STREAM_DIAGNOSTIC_LIMITS.maxActiveSessions
    );
    for (const handle of handles) handle?.finish('cleanup');
  });
});
