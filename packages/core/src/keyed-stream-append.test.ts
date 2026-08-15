import { SPEC_VERSION_CURRENT } from '@workflow/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendKeyedStreamChunk,
  KeyedStreamAppendUnavailableError,
} from './keyed-stream-append.js';
import { setWorld } from './runtime/world.js';

afterEach(() => setWorld(undefined));

describe('appendKeyedStreamChunk', () => {
  it('fails closed without selecting ordinary stream writes when keyed append is unavailable', async () => {
    const write = vi.fn();
    setWorld({
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        write,
        close: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        getChunks: vi.fn(),
        getInfo: vi.fn(),
      },
    } as any);

    await expect(
      appendKeyedStreamChunk('run', 'stream', {
        idempotencyKey: 'key',
        semanticDigest: 'digest',
        chunk: new Uint8Array([1]),
      })
    ).rejects.toBeInstanceOf(KeyedStreamAppendUnavailableError);
    expect(write).not.toHaveBeenCalled();
  });

  it('returns the canonical receipt directly instead of entering the ordinary batch writer', async () => {
    const appendKeyed = vi
      .fn()
      .mockResolvedValue({
        inserted: false,
        canonicalChunk: new Uint8Array([7]),
        index: 3,
      });
    const write = vi.fn();
    setWorld({
      keyedStreamAppendVersion: 1,
      specVersion: SPEC_VERSION_CURRENT,
      streams: {
        appendKeyed,
        write,
        close: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        getChunks: vi.fn(),
        getInfo: vi.fn(),
      },
    } as any);

    await expect(
      appendKeyedStreamChunk('run', 'stream', {
        idempotencyKey: 'key',
        semanticDigest: 'digest',
        chunk: new Uint8Array([1]),
      })
    ).resolves.toEqual({
      inserted: false,
      canonicalChunk: new Uint8Array([7]),
      index: 3,
    });
    expect(write).not.toHaveBeenCalled();
  });
});
