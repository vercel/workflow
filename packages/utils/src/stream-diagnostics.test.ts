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

  it('shares sequence and budget across handles for one logical lane', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const first = createStreamDiagnostic('read', RUN, STREAM);
    const second = createStreamDiagnostic('read', RUN, STREAM);
    if (!first || !second) throw new Error('expected diagnostics');
    first.event('raw', 1);
    second.event('decoded', 2);
    second.finish('done');
    const record = JSON.parse(lines[0]) as {
      session: number;
      tuples: [number, number, string][];
    };
    expect(record.tuples.map(([seq, , phase]) => [seq, phase])).toEqual([
      [1, 'raw'],
      [2, 'decoded'],
    ]);
  });

  it('removes a finished shared session so repeated canceled reads stay independent', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    for (let i = 0; i < 300; i++) {
      const diagnostic = createStreamDiagnostic('read', RUN, STREAM);
      if (!diagnostic) throw new Error('expected diagnostic');
      diagnostic.event('reader_entry', i);
      diagnostic.finish('cancel');
    }
    const records = lines.map(
      (line) => JSON.parse(line) as { session: number }
    );
    expect(records).toHaveLength(300);
    expect(new Set(records.map(({ session }) => session))).toHaveLength(300);
  });

  it('caps unfinished unique sessions without evicting live continuity', () => {
    enable();
    const lines: string[] = [];
    setStreamDiagnosticSinkForTest((line) => lines.push(line));
    const handles = Array.from(
      { length: STREAM_DIAGNOSTIC_LIMITS.maxActiveSessions + 10 },
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
    expect(lines).toHaveLength(0);

    handles[0]?.event('retained');
    handles[0]?.finish('cancel');
    const replacementUlid = `0${'Z'.repeat(25)}`;
    const replacement = createStreamDiagnostic(
      'read',
      `wrun_${replacementUlid}`,
      `strm_${replacementUlid}_user_YmVuY2gtY3R0`
    );
    expect(replacement).toBeDefined();
    for (const handle of handles.slice(1)) handle?.finish('cleanup');
    replacement?.finish('cleanup');
  });

  it('accounts for tuples lost to a throwing sink', () => {
    enable();
    const lines: string[] = [];
    let throws = true;
    setStreamDiagnosticSinkForTest((line) => {
      if (throws) {
        throws = false;
        throw new Error('sink secret');
      }
      lines.push(line);
    });
    const diagnostic = createStreamDiagnostic('write', RUN, STREAM, WRITER);
    if (!diagnostic) throw new Error('expected diagnostic');
    expect(() => {
      for (let i = 0; i < 64; i++) diagnostic.event('phase', i);
      diagnostic.event('after_failure');
      diagnostic.finish('done');
    }).not.toThrow();
    expect(JSON.parse(lines[0])).toMatchObject({
      omitted: 64,
      sinkFailures: 1,
      firstSeq: 65,
      lastSeq: 65,
    });
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
