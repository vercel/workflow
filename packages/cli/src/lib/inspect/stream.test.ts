import type { World } from '@workflow/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../config/log.js';
import { showStream } from './output.js';
import { streamToConsole } from './stream.js';

const RUN = 'wrun_01K4BZQ5T2J8HXFM6WD3PNAVCE';

const erroring = (error: Error, chunks: unknown[] = []) =>
  new ReadableStream<unknown>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.error(error);
    },
  });

const bytes = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

beforeEach(() => {
  process.exitCode = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

describe('streamToConsole', () => {
  it.each([
    false,
    true,
  ])('prints BigInt chunks and continues (json=%s)', async (json) => {
    const chunks = [
      9007199254740993n,
      { count: -9007199254740993n },
      [0n, { count: 1n }],
      'last',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const log = vi.spyOn(logger, 'log').mockImplementation(() => undefined);

    await streamToConsole(stream, 'strm_1', { json });

    expect(process.exitCode).toBe(0);
    if (json) {
      const write = vi.mocked(process.stdout.write);
      expect(
        write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)))
      ).toEqual([
        '9007199254740993',
        { count: '-9007199254740993' },
        ['0', { count: '1' }],
        'last',
      ]);
      expect(
        write.mock.calls.every(([chunk]) => String(chunk).endsWith('\n'))
      ).toBe(true);
    } else {
      expect(log.mock.calls.map(([text]) => text)).toEqual([
        '[0] "9007199254740993"',
        '[1] {\n  "count": "-9007199254740993"\n}',
        '[2] [\n  "0",\n  {\n    "count": "1"\n  }\n]',
        '[3] last',
      ]);
    }
  });

  // It printed "Failed to read stream" and exited 0, so a script saw a
  // successful read of an empty stream.
  it.each([
    ['table', {}],
    ['JSON', { json: true }],
  ])('exits non-zero when the stream fails (%s output)', async (_label, opts) => {
    await streamToConsole(
      erroring(new Error('Invalid input'), ['first']),
      'strm_1',
      opts
    );
    expect(process.exitCode).toBe(1);
  });

  it('exits non-zero for an encrypted stream read without --decrypt', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    await streamToConsole(
      erroring(new Error('Encrypted stream data but no encryption key')),
      'strm_1',
      {}
    );
    expect(error.mock.calls.flat().join(' ')).toContain('--decrypt');
    expect(process.exitCode).toBe(1);
  });

  it('leaves the exit code alone for a stream that closes cleanly', async () => {
    await streamToConsole(bytes('ok'), 'strm_1', { json: true });
    expect(process.exitCode).toBe(0);
  });
});

describe('showStream', () => {
  // A stream of plain JSON lines, not devalue: the deserializer rejects the
  // first line, which is what a stream written outside the SDK looks like.
  it('exits non-zero when the stream cannot be decoded', async () => {
    const world = {
      streams: { get: vi.fn().mockResolvedValue(bytes('{"type":"x"}\n')) },
    } as unknown as World;

    await showStream(world, 'strm_1', { runId: RUN, json: true });

    expect(world.streams.get).toHaveBeenCalledWith(RUN, 'strm_1');
    expect(process.exitCode).toBe(1);
  });
});
