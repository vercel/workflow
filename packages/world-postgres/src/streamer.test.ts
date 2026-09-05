import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { Drizzle } from './drizzle/index.js';
import { createStreamer } from './streamer.js';

// `listenChannel` opens a dedicated LISTEN client; the live-tail leg is not
// under test here, so stub it out rather than open a socket.
vi.mock('pg', () => ({
  Client: class {
    async connect() {}
    async query() {}
    on() {}
    removeListener() {}
    async end() {}
  },
}));

type Row = { id: string; eof: boolean; data: Buffer };

/** The one query the catch-up loop runs: select(...).from(...).where(...).orderBy(...). */
function fakeDrizzle(rows: Row[]): Drizzle {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: async () => rows,
    limit: async () => rows,
  };
  return { select: () => chain } as unknown as Drizzle;
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('streams.get()', () => {
  it('ignores rows written after the first EOF instead of erroring the stream', async () => {
    // Several data rows before the EOF, on purpose: the catch-up loop is
    // synchronous, so all but the first sit in the controller's queue when
    // the EOF closes it. A post-EOF `enqueue` then threw out of `start()`,
    // which errors the stream and drops that queue — with a single queued
    // chunk the consumer happens to drain it first and the bug hides.
    const rows: Row[] = ['a', 'b', 'c', 'd', 'e'].map((text, i) => ({
      id: `chnk_0${i}`,
      eof: false,
      data: Buffer.from(`${text}\n`),
    }));
    rows.push(
      { id: 'chnk_10', eof: true, data: Buffer.alloc(0) },
      // A retried terminal write: the frame appended again, the stream
      // closed again.
      { id: 'chnk_11', eof: false, data: Buffer.from('e\n') },
      { id: 'chnk_12', eof: true, data: Buffer.alloc(0) }
    );
    const streamer = createStreamer(
      { options: {} } as unknown as Pool,
      fakeDrizzle(rows)
    );
    try {
      const stream = await streamer.streams.get('run_1', 'stream-1', 0);
      await expect(drain(stream)).resolves.toBe('a\nb\nc\nd\ne\n');
    } finally {
      await streamer.close();
    }
  });

  it.each([
    5, 6,
  ])('a start index at or past the data count (%i) closes at the first EOF instead of consuming it', async (startIndex) => {
    // Offsets count data chunks (`getInfo` reports tailIndex = dataCount - 1),
    // so the EOF marker must never be skipped as if it were data: before this
    // guard the marker was swallowed, the post-EOF duplicate came back as
    // live data, and with no later EOF the stream never closed.
    const rows: Row[] = ['a', 'b', 'c', 'd', 'e'].map((text, i) => ({
      id: `chnk_0${i}`,
      eof: false,
      data: Buffer.from(`${text}\n`),
    }));
    rows.push(
      { id: 'chnk_10', eof: true, data: Buffer.alloc(0) },
      { id: 'chnk_11', eof: false, data: Buffer.from('e\n') }
    );
    const streamer = createStreamer(
      { options: {} } as unknown as Pool,
      fakeDrizzle(rows)
    );
    try {
      const stream = await streamer.streams.get(
        'run_1',
        'stream-1',
        startIndex
      );
      await expect(drain(stream)).resolves.toBe('');
    } finally {
      await streamer.close();
    }
  }, 5_000);

  it.each([
    [-1, 'e\n'],
    [-2, 'd\ne\n'],
  ])(
    'a negative start index (%i) counts data chunks up to the first EOF only',
    async (startIndex, expected) => {
      // The negative offset used to resolve against every row, including the
      // ones after the first EOF, so `-1` on A…E + EOF + duplicate-E skipped
      // the last valid chunk and returned nothing.
      const rows: Row[] = ['a', 'b', 'c', 'd', 'e'].map((text, i) => ({
        id: `chnk_0${i}`,
        eof: false,
        data: Buffer.from(`${text}\n`),
      }));
      rows.push(
        { id: 'chnk_10', eof: true, data: Buffer.alloc(0) },
        { id: 'chnk_11', eof: false, data: Buffer.from('e\n') }
      );
      const streamer = createStreamer(
        { options: {} } as unknown as Pool,
        fakeDrizzle(rows)
      );
      try {
        const stream = await streamer.streams.get(
          'run_1',
          'stream-1',
          startIndex
        );
        await expect(drain(stream)).resolves.toBe(expected);
      } finally {
        await streamer.close();
      }
    },
    5_000
  );
});
