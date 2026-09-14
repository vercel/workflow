import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Drizzle } from './drizzle/index.js';
import { createStreamer } from './streamer.js';

vi.mock('pg', () => ({
  Client: vi.fn(function Client() {
    return {
      connect: vi.fn(async () => {}),
      query: vi.fn(async () => {}),
      on: vi.fn(),
      removeListener: vi.fn(),
      end: vi.fn(async () => {}),
    };
  }),
  Pool: vi.fn(),
}));

const fakePool = {
  options: {},
  query: vi.fn(async () => ({ rows: [] })),
} as any;

/**
 * Minimal fake for the drizzle query chain used by `streams.get()`:
 * `drizzle.select(...).from(...).where(...).orderBy(...)`.
 */
function createFakeDrizzle(
  rows: () => Promise<Array<{ id: string; eof: boolean; data: Buffer }>>
): Drizzle {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => rows(),
          limit: () => rows(),
        }),
      }),
    }),
  } as unknown as Drizzle;
}

describe('postgres streamer reader listener cleanup', () => {
  // `createStreamer()` keeps its EventEmitter private, so capture any
  // emitter that receives a `strm:*` listener via a prototype spy.
  let streamEmitters: Set<EventEmitter>;

  const listenerCount = (name: string) => {
    let count = 0;
    for (const emitter of streamEmitters) {
      count += emitter.listenerCount(`strm:${name}`);
    }
    return count;
  };

  beforeEach(() => {
    streamEmitters = new Set();
    const originalOn = EventEmitter.prototype.on;
    vi.spyOn(EventEmitter.prototype, 'on').mockImplementation(function (
      this: EventEmitter,
      eventName,
      listener
    ) {
      if (typeof eventName === 'string' && eventName.startsWith('strm:')) {
        streamEmitters.add(this);
      }
      return originalOn.call(this, eventName, listener);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the listener when a persisted EOF closes the stream', async () => {
    const drizzle = createFakeDrizzle(async () => [
      {
        id: 'chnk_00000000000000000000000001',
        eof: false,
        data: Buffer.from('hello'),
      },
      {
        id: 'chnk_00000000000000000000000002',
        eof: true,
        data: Buffer.from([]),
      },
    ]);
    const streamer = createStreamer(fakePool, drizzle);

    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);

    try {
      // Repeated reads of the same completed stream must not accumulate
      // listeners (issue reproduction uses 12 readers to trip the default
      // max-listeners threshold of 10).
      for (let i = 0; i < 12; i++) {
        const stream = await streamer.streams.get('run_1', 'stream-eof');
        const reader = stream.getReader();
        let done = false;
        while (!done) {
          ({ done } = await reader.read());
        }
        expect(listenerCount('stream-eof')).toBe(0);
      }

      // Warnings are emitted via process.nextTick; flush before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        warnings.filter((w) => w.name === 'MaxListenersExceededWarning')
      ).toEqual([]);
    } finally {
      process.removeListener('warning', onWarning);
      await streamer.close();
    }
  });

  it('removes the listener when the initial chunk query rejects', async () => {
    const drizzle = createFakeDrizzle(async () => {
      throw new Error('initial query failed');
    });
    const streamer = createStreamer(fakePool, drizzle);

    try {
      for (let i = 0; i < 12; i++) {
        const stream = await streamer.streams.get('run_1', 'stream-err');
        const reader = stream.getReader();
        await expect(reader.read()).rejects.toThrow('initial query failed');
      }
      expect(listenerCount('stream-err')).toBe(0);
    } finally {
      await streamer.close();
    }
  });

  it('removes the listener when a live EOF arrives via notification', async () => {
    // No persisted EOF: the reader tails live events and is closed by an
    // EOF chunk delivered through the LISTEN emitter.
    const drizzle = createFakeDrizzle(async () => [
      {
        id: 'chnk_00000000000000000000000001',
        eof: false,
        data: Buffer.from('hello'),
      },
    ]);
    const streamer = createStreamer(fakePool, drizzle);

    try {
      for (let i = 0; i < 12; i++) {
        const stream = await streamer.streams.get('run_1', 'stream-live-eof');
        const reader = stream.getReader();
        await reader.read();
        expect(listenerCount('stream-live-eof')).toBe(1);

        for (const emitter of streamEmitters) {
          emitter.emit('strm:stream-live-eof', {
            id: 'chnk_00000000000000000000000002',
            eof: true,
            data: Buffer.from([]),
          });
        }
        expect(await reader.read()).toEqual({ done: true, value: undefined });
        expect(listenerCount('stream-live-eof')).toBe(0);
      }
    } finally {
      await streamer.close();
    }
  });

  it('detaches and fails pending readers when the streamer is closed', async () => {
    // No EOF chunk: readers stay open, tailing live events.
    const drizzle = createFakeDrizzle(async () => [
      {
        id: 'chnk_00000000000000000000000001',
        eof: false,
        data: Buffer.from('hello'),
      },
    ]);
    const streamer = createStreamer(fakePool, drizzle);

    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    for (let i = 0; i < 10; i++) {
      const stream = await streamer.streams.get('run_1', 'stream-open');
      readers.push(stream.getReader());
      // Consume the persisted chunk; the reader keeps waiting for more.
      await readers[i].read();
    }
    expect(listenerCount('stream-open')).toBe(10);

    // An outstanding read() must settle once the streamer shuts down: the
    // LISTEN client is gone, so nothing could ever wake it otherwise.
    const pending = readers[0].read();

    await streamer.close();
    expect(listenerCount('stream-open')).toBe(0);
    await expect(pending).rejects.toThrow('streamer has been closed');
    for (const reader of readers) {
      await expect(reader.read()).rejects.toThrow('streamer has been closed');
    }
  });

  it('rejects streams.get() after the streamer is closed', async () => {
    const drizzle = createFakeDrizzle(async () => []);
    const streamer = createStreamer(fakePool, drizzle);
    await streamer.close();

    await expect(
      streamer.streams.get('run_1', 'stream-after-close')
    ).rejects.toThrow('streamer has been closed');
    // A rejected get() must not leave a listener behind on the dead emitter.
    expect(listenerCount('stream-after-close')).toBe(0);
  });

  it('cleans up when cancelled while the initial query is in flight', async () => {
    let resolveQuery!: (
      rows: Array<{ id: string; eof: boolean; data: Buffer }>
    ) => void;
    const drizzle = createFakeDrizzle(
      () => new Promise((resolve) => (resolveQuery = resolve))
    );
    const streamer = createStreamer(fakePool, drizzle);

    try {
      const stream = await streamer.streams.get('run_1', 'stream-cancel-early');
      const reader = stream.getReader();
      expect(listenerCount('stream-cancel-early')).toBe(1);
      await reader.cancel();
      expect(listenerCount('stream-cancel-early')).toBe(0);

      // The query resolving into a cancelled stream is dropped; the listener
      // count must not bounce back.
      resolveQuery([
        {
          id: 'chnk_00000000000000000000000001',
          eof: false,
          data: Buffer.from('hello'),
        },
        {
          id: 'chnk_00000000000000000000000002',
          eof: true,
          data: Buffer.from([]),
        },
      ]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(listenerCount('stream-cancel-early')).toBe(0);
    } finally {
      await streamer.close();
    }
  });

  it('does not count a redelivered skipped chunk against the start offset', async () => {
    const drizzle = createFakeDrizzle(async () => []);
    const streamer = createStreamer(fakePool, drizzle);

    try {
      // startIndex 2: skip 'first' and 'second', deliver from 'third'.
      const stream = await streamer.streams.get('run_1', 'stream-offset', 2);
      const reader = stream.getReader();
      const first = {
        id: 'chnk_00000000000000000000000001',
        eof: false,
        data: Buffer.from('first'),
      };
      const emit = (chunk: typeof first) => {
        for (const emitter of streamEmitters) {
          emitter.emit('strm:stream-offset', chunk);
        }
      };
      // Let start() finish its (empty) initial query so notifications are
      // enqueued directly rather than buffered.
      await new Promise((resolve) => setImmediate(resolve));

      emit(first);
      // A redelivered NOTIFY for the chunk that was just skipped must not
      // decrement the remaining offset a second time.
      emit(first);
      emit({
        id: 'chnk_00000000000000000000000002',
        eof: false,
        data: Buffer.from('second'),
      });
      emit({
        id: 'chnk_00000000000000000000000003',
        eof: false,
        data: Buffer.from('third'),
      });

      const result = await reader.read();
      expect(result.done).toBe(false);
      expect(Buffer.from(result.value as Uint8Array).toString()).toBe('third');
    } finally {
      await streamer.close();
    }
  });

  it('still cleans up on explicit consumer cancellation', async () => {
    const drizzle = createFakeDrizzle(async () => []);
    const streamer = createStreamer(fakePool, drizzle);

    try {
      const stream = await streamer.streams.get('run_1', 'stream-cancel');
      const reader = stream.getReader();
      expect(listenerCount('stream-cancel')).toBe(1);
      await reader.cancel();
      expect(listenerCount('stream-cancel')).toBe(0);
    } finally {
      await streamer.close();
    }
  });
});
