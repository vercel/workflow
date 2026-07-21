import {
  WorkflowRunCancelledError,
  WorkflowRunFailedError,
} from '@workflow/errors';
import { SPEC_VERSION_CURRENT, type World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Avoid the generated version file.
vi.mock('../version.js', () => ({ version: '0.0.0-test' }));

// Keep serialization real except for the hydrate helpers, which would
// otherwise need real serialized payloads. Passthrough is enough to assert
// the poll loop's control flow (which value/error it surfaces).
vi.mock('../serialization.js', async (importActual) => {
  const actual = await importActual<typeof import('../serialization.js')>();
  return {
    ...actual,
    hydrateWorkflowReturnValue: vi.fn(async (v: unknown) => v),
    hydrateRunError: vi.fn(async (v: unknown) => v),
  };
});

import { Run } from './run.js';
import { setWorld } from './world.js';

type RunRecord = Record<string, unknown> & { status: string };

/** A ReadableStream that emits the given chunks then closes. */
function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

function makeWorld(opts: {
  getImpl: () => Promise<RunRecord>;
  streamsGet?: ReturnType<typeof vi.fn>;
}): World {
  return {
    specVersion: SPEC_VERSION_CURRENT,
    runs: {
      get: vi.fn(opts.getImpl),
    },
    streams: {
      get:
        opts.streamsGet ??
        vi.fn().mockResolvedValue(streamOf(new Uint8Array([1]))),
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as World;
}

beforeEach(() => {
  delete process.env.WORKFLOW_RETURN_VALUE_STREAM;
});

afterEach(() => {
  delete process.env.WORKFLOW_RETURN_VALUE_STREAM;
  setWorld(undefined);
  vi.useRealTimers();
});

describe('Run#returnValue', () => {
  it('resolves immediately for an already-completed run without touching the stream (late attach)', async () => {
    // Default-on; no env set.
    const streamsGet = vi.fn();
    const world = makeWorld({
      getImpl: async () => ({ status: 'completed', output: 'RESULT' }),
      streamsGet,
    });
    setWorld(world);

    const run = new Run<string>('wrun_late');
    await expect(run.returnValue).resolves.toBe('RESULT');
    // First runs.get is terminal, so the wait (and thus the stream) is never
    // reached — the late-attach fast resolution needs no stream catch-up.
    expect(streamsGet).not.toHaveBeenCalled();
  });

  it('throws WorkflowRunFailedError for a failed run', async () => {
    const world = makeWorld({
      getImpl: async () => ({
        status: 'failed',
        error: new Error('boom'),
        errorCode: 'USER_ERROR',
      }),
    });
    setWorld(world);

    const run = new Run<string>('wrun_failed');
    await expect(run.returnValue).rejects.toBeInstanceOf(
      WorkflowRunFailedError
    );
  });

  it('throws WorkflowRunCancelledError for a cancelled run', async () => {
    const world = makeWorld({
      getImpl: async () => ({ status: 'cancelled' }),
    });
    setWorld(world);

    const run = new Run<string>('wrun_cancelled');
    await expect(run.returnValue).rejects.toBeInstanceOf(
      WorkflowRunCancelledError
    );
  });

  it('fast path (default): wakes on the stream signal, then re-reads the authoritative result', async () => {
    let call = 0;
    const streamsGet = vi.fn().mockResolvedValue(streamOf(new Uint8Array([1])));
    const world = makeWorld({
      getImpl: async () => {
        call += 1;
        // First observation: still running → wait on the stream. The stream
        // signals immediately, so the next read observes completion.
        return call === 1
          ? { status: 'running' }
          : { status: 'completed', output: 'RESULT' };
      },
      streamsGet,
    });
    setWorld(world);

    const run = new Run<string>('wrun_fast');
    await expect(run.returnValue).resolves.toBe('RESULT');
    expect(streamsGet).toHaveBeenCalledWith('wrun_fast', expect.any(String), 0);
  });

  it('kill switch off: keeps the fixed 1s poll and never opens the stream', async () => {
    vi.useFakeTimers();
    process.env.WORKFLOW_RETURN_VALUE_STREAM = '0';
    const streamsGet = vi.fn();
    let call = 0;
    const world = makeWorld({
      getImpl: async () => {
        call += 1;
        return call === 1
          ? { status: 'running' }
          : { status: 'completed', output: 'RESULT' };
      },
      streamsGet,
    });
    setWorld(world);

    const run = new Run<string>('wrun_killswitch');
    const p = run.returnValue;
    // Advance through the legacy 1s sleep between poll iterations.
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBe('RESULT');
    expect(streamsGet).not.toHaveBeenCalled();
  });
});
