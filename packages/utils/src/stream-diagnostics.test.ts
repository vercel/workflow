import { afterEach, describe, expect, it, vi } from 'vitest';
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
  process.env.WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS = 'true';
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
  it('requires the exact opt-in, preview, project, run, stream, and writer', () => {
    enable();
    expect(isStreamSlowdownDiagnosticsEnabled(RUN, STREAM, WRITER)).toBe(true);
    for (const [run, stream, writer] of [
      [`wrun_${'A'.repeat(26)}`, STREAM, WRITER],
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
    process.env.VERCEL_ENV = 'preview';
    process.env.WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS = 'TRUE';
    expect(isStreamSlowdownDiagnosticsEnabled(RUN, STREAM, WRITER)).toBe(false);
  });

  it('cannot be enabled by request data and emits no payload/header/error text', () => {
    const sink = vi.fn();
    setStreamDiagnosticSinkForTest(sink);
    process.env = {
      ...process.env,
      authorization: 'secret',
      WORKFLOW_STREAM_SLOWDOWN_DIAGNOSTICS: 'false',
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

describe('stream slowdown diagnostic bounds and safety', () => {
  it('batches continuous numeric tuples and records omissions within limits', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    expect(diagnostic).toBeDefined();
    if (!diagnostic) throw new Error('expected diagnostic');
    for (let i = 0; i < 300; i++) diagnostic.event('phase', i, 1, 2, 3);
    diagnostic.finish('done');

    expect(lines.length).toBeLessThan(10);
    const records = lines.map((line) => {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(
        STREAM_DIAGNOSTIC_LIMITS.maxLineBytes
      );
      return JSON.parse(line) as {
        tuples: [number, number, string][];
        omitted: number;
      };
    });
    const tuples = records.flatMap((record) => record.tuples);
    expect(tuples).toHaveLength(STREAM_DIAGNOSTIC_LIMITS.maxRecordsPerLane);
    expect(tuples.map((tuple) => tuple[0])).toEqual(
      Array.from({ length: tuples.length }, (_, i) => i + 1)
    );
    expect(records.at(-1)?.omitted).toBe(108);
    expect(records.every((r) => r.tuples.length <= 64)).toBe(true);
  });

  it('swallows a throwing sink without changing caller control flow', () => {
    enable();
    setStreamDiagnosticSinkForTest(() => {
      throw new Error('sink secret');
    });
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    expect(diagnostic).toBeDefined();
    if (!diagnostic) throw new Error('expected diagnostic');
    expect(() => {
      for (let i = 0; i < 70; i++) diagnostic.event('phase', i);
      diagnostic.finish('done');
    }).not.toThrow();
  });
});
