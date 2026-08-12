import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { createSimStreamer } from './streams.js';

describe('SimStreamer.getChunks', () => {
  it('resumes an open stream after its current tail', async () => {
    const streamer = createSimStreamer();
    await streamer.streams.write('run', 'stream', 'first');

    const first = await streamer.streams.getChunks('run', 'stream');
    expect(first).toMatchObject({ hasMore: false, done: false });
    expect(first.cursor).toBe('1');
    assert(first.cursor);

    await streamer.streams.write('run', 'stream', 'second');
    const second = await streamer.streams.getChunks('run', 'stream', {
      cursor: first.cursor,
    });

    expect(second.data.map(({ index }) => index)).toEqual([1]);
  });

  it('omits the cursor at a completed tail', async () => {
    const streamer = createSimStreamer();
    await streamer.streams.write('run', 'stream', 'only');
    await streamer.streams.close('run', 'stream');

    const page = await streamer.streams.getChunks('run', 'stream');
    expect(page).toMatchObject({ cursor: null, hasMore: false, done: true });
  });
});
