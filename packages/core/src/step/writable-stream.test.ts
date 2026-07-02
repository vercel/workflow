import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCK_POLL_INTERVAL_MS } from '../flushable-stream.js';
import { setWorld } from '../runtime/world.js';
import { STREAM_SERVER_DEPLOYMENT_ID_SYMBOL } from '../symbols.js';

// Captures every chunk written to `world.streams.write` / `writeMulti`
// in arrival order, so tests can assert the on-wire sequence after
// going through the (de)serialize transforms.
let writeCalls: Uint8Array[];

function makeStepCtx(): any {
  return {
    stepMetadata: {
      stepName: 'test-step',
      stepId: 'step_001',
      stepStartedAt: new Date(),
      attempt: 1,
    },
    workflowMetadata: {
      workflowName: 'test-workflow',
      workflowRunId: 'wrun_test123',
      workflowStartedAt: new Date(),
      url: 'http://localhost:3000',
      features: { encryption: false },
    },
    ops: [] as Promise<void>[],
    encryptionKey: undefined,
  };
}

describe('step-level getWritable', () => {
  beforeEach(() => {
    writeCalls = [];
    const mockWorld = {
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        write: vi.fn(
          async (_runId: string, _name: string, chunk: Uint8Array) => {
            writeCalls.push(chunk);
          }
        ),
        writeMulti: vi.fn(
          async (_runId: string, _name: string, chunks: Uint8Array[]) => {
            writeCalls.push(...chunks);
          }
        ),
        close: vi.fn().mockResolvedValue(undefined),
      },
    };

    setWorld(mockWorld as any);
  });

  afterEach(() => {
    setWorld(undefined);
    vi.clearAllMocks();
  });

  it('ops promise should resolve when writer lock is released (without closing stream)', async () => {
    const { contextStorage } = await import('./context-storage.js');

    const ctx = makeStepCtx();
    const ops = ctx.ops as Promise<void>[];

    const writable = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return getWritable<string>();
    });

    // Simulate user pattern: write data, then release lock
    const writer = writable.getWriter();
    await writer.write('hello');
    await writer.write('world');
    writer.releaseLock();

    // Without the fix (.pipeTo()), this hangs because pipeTo only resolves on stream close.
    // With flushablePipe + pollWritableLock, it resolves once the lock is released.
    await expect(
      Promise.race([
        Promise.all(ops),
        new Promise((_, r) =>
          setTimeout(
            () => r(new Error('ops did not resolve after releaseLock')),
            LOCK_POLL_INTERVAL_MS * 5 + 200
          )
        ),
      ])
    ).resolves.not.toThrow();
  });

  it('ops promise should resolve when stream is explicitly closed', async () => {
    const { contextStorage } = await import('./context-storage.js');

    const ctx = makeStepCtx();
    const ops = ctx.ops as Promise<void>[];

    const writable = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return getWritable<string>();
    });

    const writer = writable.getWriter();
    await writer.write('data');
    await writer.close();

    await expect(
      Promise.race([
        Promise.all(ops),
        new Promise((_, r) =>
          setTimeout(
            () => r(new Error('ops did not resolve after close')),
            LOCK_POLL_INTERVAL_MS * 5 + 200
          )
        ),
      ])
    ).resolves.not.toThrow();
  });

  // Regression for https://github.com/vercel/workflow/issues/2058.
  // Repeat calls to `getWritable()` from the same step previously spawned
  // independent TransformStream + pipe pairs that all flushed to the same
  // (runId, name). On world-vercel the 50-100ms HTTP write latency turned
  // that race window into deterministic reordering; locally it was
  // invisible. We now memoize per (runId, namespace) so a single serial
  // sink is shared across calls.
  it('returns the same writable for repeat calls with the same namespace', async () => {
    const { contextStorage } = await import('./context-storage.js');
    const ctx = makeStepCtx();

    const [a, b] = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return [getWritable<string>(), getWritable<string>()] as const;
    });

    expect(a).toBe(b);

    // Different namespaces still get distinct writables.
    const [c, d] = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return [
        getWritable<string>({ namespace: 'left' }),
        getWritable<string>({ namespace: 'right' }),
      ] as const;
    });

    expect(c).not.toBe(d);
    expect(c).not.toBe(a);
  });

  it('preserves chunk order across per-write getWritable() calls in a loop', async () => {
    const { contextStorage } = await import('./context-storage.js');
    const { getDeserializeStream } = await import('../serialization.js');

    const ctx = makeStepCtx();
    const ops = ctx.ops as Promise<void>[];

    // Repro of the user-reported pattern: acquire a fresh writer per chunk
    // and release between writes. With the pre-fix per-call pipe, these
    // chunks could land out of order on the server.
    const chunks = ['nov', 'o', ' e', '2', 'e', ' ok'];
    await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      for (const chunk of chunks) {
        const writer = getWritable<string>().getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
      }
    });

    // Wait for all pending writes to flush through the shared pipe.
    await Promise.race([
      Promise.all(ops),
      new Promise((_, r) =>
        setTimeout(
          () => r(new Error('ops did not resolve')),
          LOCK_POLL_INTERVAL_MS * 20 + 500
        )
      ),
    ]);

    // Decode the recorded server writes via the matching deserialize
    // stream and confirm chunks arrived in the order we wrote them.
    const deserialize = getDeserializeStream({}, undefined);
    const decoded: string[] = [];
    const reader = deserialize.readable.getReader();
    const drain = (async () => {
      while (true) {
        const r = await reader.read();
        if (r.done) return;
        decoded.push(r.value);
      }
    })();

    const writer = deserialize.writable.getWriter();
    for (const buf of writeCalls) {
      await writer.write(buf);
    }
    await writer.close();
    await drain;

    expect(decoded).toEqual(chunks);
  });

  it('registers exactly one pipe per (runId, namespace), regardless of call count', async () => {
    const { contextStorage } = await import('./context-storage.js');

    const ctx = makeStepCtx();
    const ops = ctx.ops as Promise<void>[];

    await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      getWritable<string>();
      getWritable<string>();
      getWritable<string>();
      // A distinct namespace gets its own pipe.
      getWritable<string>({ namespace: 'other' });
    });

    expect(ops).toHaveLength(2);
  });

  it('tags a writable with its owning deployment for child workflow forwarding', async () => {
    const { contextStorage } = await import('./context-storage.js');
    const ctx = {
      ...makeStepCtx(),
      workflowDeploymentId: 'dpl_parent',
    };

    const writable = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return getWritable<string>();
    });

    expect((writable as any)[STREAM_SERVER_DEPLOYMENT_ID_SYMBOL]).toBe(
      'dpl_parent'
    );
    await Promise.all(ctx.ops);
  });
});

describe('getWritable framed-v2 flip (WORKFLOW_EXPERIMENTAL_STREAM_MARKERS)', () => {
  /** Chunks that arrived on the world's write channel, in order. */
  let channelFrames: Uint8Array[];
  let channelsOpened: number;

  function installWorld(opts: { withConnectWrite: boolean }) {
    channelFrames = [];
    channelsOpened = 0;
    writeCalls = [];
    const streams: any = {
      write: vi.fn(async (_r: string, _n: string, chunk: Uint8Array) => {
        writeCalls.push(chunk);
      }),
      writeMulti: vi.fn(
        async (_r: string, _n: string, chunks: Uint8Array[]) => {
          writeCalls.push(...chunks);
        }
      ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    if (opts.withConnectWrite) {
      streams.connectWrite = vi.fn(
        async (
          _r: string,
          _n: string,
          handlers: {
            onAck(ack: { index: number; chunkIndex: number }): void;
          }
        ) => {
          channelsOpened++;
          let index = 0;
          return {
            send(frame: Uint8Array) {
              channelFrames.push(frame);
              const i = index++;
              queueMicrotask(() => handlers.onAck({ index: i, chunkIndex: i }));
            },
            close() {},
          };
        }
      );
    }
    setWorld({ specVersion: SPEC_VERSION_CURRENT, streams } as any);
  }

  beforeEach(() => {
    vi.stubEnv('WORKFLOW_EXPERIMENTAL_STREAM_MARKERS', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    setWorld(undefined);
    vi.clearAllMocks();
  });

  async function writeThroughGetWritable(values: string[]) {
    const { contextStorage } = await import('./context-storage.js');
    const ctx = makeStepCtx();
    const writable = await contextStorage.run(ctx, async () => {
      const { getWritable } = await import('./writable-stream.js');
      return getWritable<string>();
    });
    const writer = writable.getWriter();
    for (const value of values) await writer.write(value);
    await writer.close();
    await Promise.all(ctx.ops as Promise<void>[]);
    return writable;
  }

  it('sends framed-v2 frames over the write channel and round-trips them', async () => {
    installWorld({ withConnectWrite: true });
    const { FRAME_HEADER_SIZE, readFrameMarker } = await import(
      '../serialization/frame-marker.js'
    );
    const { getDeserializeStream } = await import('../serialization.js');

    const writable = await writeThroughGetWritable(['hello', 'world']);

    // The channel carried the frames; the batch path was never used.
    expect(channelsOpened).toBe(1);
    expect(writeCalls).toHaveLength(0);
    expect(channelFrames).toHaveLength(2);

    // Every frame carries the SAME writerId with increasing seq.
    const markers = channelFrames.map((f) =>
      readFrameMarker(f.subarray(FRAME_HEADER_SIZE))
    );
    expect(markers[0].writerId).toEqual(markers[1].writerId);
    expect(markers[1].seq).toBe(markers[0].seq + 1n);

    // The forwarding tag matches, so descriptors reproduce the framing.
    const { STREAM_FRAMING_SYMBOL } = await import('../symbols.js');
    expect((writable as any)[STREAM_FRAMING_SYMBOL]).toBe('framed-v2');

    // Frames round-trip through the framed-v2 deserializer back to values.
    // Read concurrently with writing — the transform applies backpressure
    // once its readable queue fills, so a write-everything-then-read pattern
    // would deadlock.
    const deserialize = getDeserializeStream({}, undefined, 'framed-v2');
    const outPromise = (async () => {
      const out: unknown[] = [];
      const reader = deserialize.readable.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
      return out;
    })();
    const w = deserialize.writable.getWriter();
    for (const frame of channelFrames) await w.write(frame);
    await w.close();
    expect(await outPromise).toEqual(['hello', 'world']);
  });

  it('still emits framed-v2 markers on the batch path (world without channels)', async () => {
    installWorld({ withConnectWrite: false });
    const { FRAME_HEADER_SIZE, readFrameMarker } = await import(
      '../serialization/frame-marker.js'
    );

    await writeThroughGetWritable(['solo']);

    // The framing decision is independent of the transport: no channel, so
    // frames went through write/writeMulti — but they still carry markers
    // (the ref/descriptor says framed-v2, so readers strip them).
    expect(channelsOpened).toBe(0);
    expect(writeCalls.length).toBeGreaterThan(0);
    const marker = readFrameMarker(writeCalls[0].subarray(FRAME_HEADER_SIZE));
    expect(marker.writerId).toHaveLength(8);
    expect(marker.seq).toBe(0n);
  });

  it('emits framed-v1 (no markers) when the override is off and the version gate is below the cutoff', async () => {
    vi.unstubAllEnvs();
    installWorld({ withConnectWrite: true });
    const { getDeserializeStream } = await import('../serialization.js');

    await writeThroughGetWritable(['legacy']);

    // Dormant: version gate (current dev version < capability cutoff) keeps
    // the writer on framed-v1 + the batch path, and plain deserialization
    // reads it — exactly the pre-flip behavior.
    expect(channelsOpened).toBe(0);
    expect(writeCalls.length).toBeGreaterThan(0);
    const deserialize = getDeserializeStream({}, undefined);
    const readPromise = (async () => {
      const reader = deserialize.readable.getReader();
      const { value } = await reader.read();
      return value;
    })();
    const w = deserialize.writable.getWriter();
    for (const frame of writeCalls) await w.write(frame);
    await w.close();
    expect(await readPromise).toBe('legacy');
  });
});
