import { describe, expect, it } from 'vitest';
import {
  createPagedStream,
  type PagedStreamRow,
  type PagedStreamSource,
  type PagedStreamStart,
  STREAM_READ_PAGE_SIZE,
} from './paged-stream.js';

const rowId = (n: number) =>
  `chnk_${String(n).padStart(26, '0')}` as `chnk_${string}`;

/**
 * In-memory source with the Postgres adapter's semantics: rows in id order,
 * offsets count data rows before the first EOF, and every append wakes the
 * subscribed readers. `hold()` parks the next queries until released.
 */
class FakeSource implements PagedStreamSource {
  rows: PagedStreamRow[] = [];
  closed = false;
  readonly wakes = new Set<() => void>();
  readonly aborts = new Set<() => void>();
  readonly limits: number[] = [];
  failure: Error | undefined;
  private held: Promise<void> | undefined;
  private release: (() => void) | undefined;

  append(text: string, eof = false) {
    this.rows.push({
      id: rowId(this.rows.length + 1),
      eof,
      data: Buffer.from(text),
    });
    for (const wake of [...this.wakes]) wake();
  }
  hold() {
    this.held = new Promise((resolve) => (this.release = resolve));
  }
  unhold() {
    this.held = undefined;
    this.release?.();
  }
  close() {
    this.closed = true;
    for (const abort of [...this.aborts]) abort();
  }
  isClosed() {
    return this.closed;
  }
  closedError() {
    return new Error('the source is closed');
  }
  subscribe(wake: () => void) {
    this.wakes.add(wake);
    return () => {
      this.wakes.delete(wake);
    };
  }
  registerAbort(abort: () => void) {
    this.aborts.add(abort);
    return () => {
      this.aborts.delete(abort);
    };
  }
  async prepareStart(index: number): Promise<PagedStreamStart> {
    const firstEof = this.rows.findIndex((row) => row.eof);
    const data = (
      firstEof === -1 ? this.rows : this.rows.slice(0, firstEof)
    ).filter((row) => !row.eof);
    const offset = index < 0 ? Math.max(0, data.length + index) : index;
    const skip = Math.min(offset, data.length);
    return {
      cursor: skip === 0 ? undefined : data[skip - 1]?.id,
      remainingOffset: offset - skip,
    };
  }
  async loadPage(cursor: `chnk_${string}` | undefined, limit: number) {
    this.limits.push(limit);
    const snapshot = this.rows.filter(
      (row) => cursor === undefined || row.id > cursor
    );
    if (this.held) await this.held;
    if (this.failure) throw this.failure;
    return snapshot.slice(0, limit);
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The text of one read, failing on a closed stream. */
function text(result: ReadableStreamReadResult<Uint8Array>): string {
  if (result.done) throw new Error('the stream closed');
  return Buffer.from(result.value).toString();
}

describe('createPagedStream', () => {
  it('reads every row in order across pages and never asks for more than one page', async () => {
    const source = new FakeSource();
    const expected: string[] = [];
    for (let i = 0; i < STREAM_READ_PAGE_SIZE * 3 + 7; i++) {
      source.append(`${i},`);
      expected.push(`${i},`);
    }
    source.append('', true);

    await expect(drain(createPagedStream(source))).resolves.toBe(
      expected.join('')
    );
    expect(Math.max(...source.limits)).toBe(STREAM_READ_PAGE_SIZE);
    expect(source.wakes.size).toBe(0);
    expect(source.aborts.size).toBe(0);
  });

  it('pulls the next page only when the consumer has read the previous one', async () => {
    const source = new FakeSource();
    for (let i = 0; i < STREAM_READ_PAGE_SIZE * 4; i++) source.append('x');
    const reader = createPagedStream(source).getReader();

    await reader.read();
    await tick();
    expect(source.limits.length).toBe(1);
    for (let i = 1; i < STREAM_READ_PAGE_SIZE + 1; i++) await reader.read();
    await tick();
    expect(source.limits.length).toBeLessThanOrEqual(3);
    await reader.cancel();
  });

  it('waits for a wake, then reads the rows appended after it caught up', async () => {
    const source = new FakeSource();
    source.append('a');
    const reader = createPagedStream(source).getReader();
    expect(text(await reader.read())).toBe('a');

    const next = reader.read();
    await tick();
    source.append('b');
    expect(text(await next)).toBe('b');
    source.append('', true);
    await expect(reader.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(source.wakes.size).toBe(0);
  });

  it('does not miss a row appended while an empty page query is in flight', async () => {
    const source = new FakeSource();
    source.hold();
    const reader = createPagedStream(source).getReader();
    const first = reader.read();
    await tick();
    // The in-flight query already took its (empty) snapshot.
    source.append('late');
    source.unhold();
    expect(text(await first)).toBe('late');
    await reader.cancel();
  });

  it('skips the requested data rows once, whatever wakes arrive', async () => {
    const source = new FakeSource();
    const reader = createPagedStream(source, 2).getReader();
    const read = reader.read();
    await tick();
    for (const text of ['first', 'second', 'third']) {
      source.append(text);
      // A redelivered notification for the same row is only another wake.
      for (const wake of [...source.wakes]) wake();
    }
    expect(text(await read)).toBe('third');
    await reader.cancel();
  });

  it('ignores rows written after the first EOF', async () => {
    const source = new FakeSource();
    for (const text of ['a', 'b', 'c', 'd', 'e']) source.append(`${text}\n`);
    source.append('', true);
    source.append('e\n');
    source.append('', true);
    await expect(drain(createPagedStream(source))).resolves.toBe(
      'a\nb\nc\nd\ne\n'
    );
  });

  it.each([
    5, 6, 50,
  ])('closes at the first EOF for a start index at or past the data count (%i)', async (startIndex) => {
    const source = new FakeSource();
    for (const text of ['a', 'b', 'c', 'd', 'e']) source.append(`${text}\n`);
    source.append('', true);
    source.append('e\n');
    await expect(drain(createPagedStream(source, startIndex))).resolves.toBe(
      ''
    );
  });

  it.each([
    [-1, 'e\n'],
    [-2, 'd\ne\n'],
    [-50, 'a\nb\nc\nd\ne\n'],
  ])('counts a negative start index (%i) from the data rows before the first EOF', async (startIndex, expected) => {
    const source = new FakeSource();
    for (const text of ['a', 'b', 'c', 'd', 'e']) source.append(`${text}\n`);
    source.append('', true);
    source.append('e\n');
    await expect(drain(createPagedStream(source, startIndex))).resolves.toBe(
      expected
    );
  });

  it('applies a start index past the current tail to rows appended later', async () => {
    const source = new FakeSource();
    for (const text of ['a', 'b', 'c']) source.append(text);
    const reader = createPagedStream(source, 5).getReader();
    const read = reader.read();
    await tick();
    for (const text of ['d', 'e', 'f']) source.append(text);
    expect(text(await read)).toBe('f');
    await reader.cancel();
  });

  it('cleans up after a failed query and surfaces its error', async () => {
    const source = new FakeSource();
    source.failure = new Error('query failed');
    const reader = createPagedStream(source).getReader();
    await expect(reader.read()).rejects.toThrow('query failed');
    expect(source.wakes.size).toBe(0);
    expect(source.aborts.size).toBe(0);
  });

  it('drops the result of a query that settles after the consumer cancelled', async () => {
    const source = new FakeSource();
    source.append('a');
    source.hold();
    const reader = createPagedStream(source).getReader();
    const read = reader.read();
    await tick();
    await reader.cancel();
    expect(source.wakes.size).toBe(0);
    source.unhold();
    await expect(read).resolves.toEqual({ done: true, value: undefined });
  });

  it('fails pending readers and detaches them when the source closes', async () => {
    const source = new FakeSource();
    source.append('a');
    const [first, second] = [
      createPagedStream(source),
      createPagedStream(source),
    ].map((stream) => stream.getReader());
    if (!first || !second) throw new Error('two readers expected');
    for (const reader of [first, second]) await reader.read();
    const pending = first.read();
    await tick();
    source.close();
    await expect(pending).rejects.toThrow('the source is closed');
    await expect(second.read()).rejects.toThrow('the source is closed');
    expect(source.wakes.size).toBe(0);
    expect(source.aborts.size).toBe(0);
  });

  it('refuses to open on a closed source', () => {
    const source = new FakeSource();
    source.close();
    expect(() => createPagedStream(source)).toThrow('the source is closed');
    expect(source.wakes.size).toBe(0);
  });

  it('fails closed on a page larger than its bound', async () => {
    const source = new FakeSource();
    for (let i = 0; i <= STREAM_READ_PAGE_SIZE; i++) source.append('x');
    source.loadPage = async () => source.rows;
    await expect(drain(createPagedStream(source))).rejects.toThrow(
      'exceeded its bound'
    );
    expect(source.wakes.size).toBe(0);
  });

  it('fails closed on rows that are not strictly ordered', async () => {
    const source = new FakeSource();
    source.append('a');
    source.append('b');
    source.rows.reverse();
    await expect(drain(createPagedStream(source))).rejects.toThrow(
      'not strictly ordered'
    );
  });
});
