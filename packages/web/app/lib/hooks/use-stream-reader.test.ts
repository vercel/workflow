import { webcrypto } from 'node:crypto';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { importKey } from '@workflow/core/encryption';
import {
  deriveRunPayloadKeys,
  encodeWithFormatPrefix,
  encryptEnvelope,
  SerializationFormat,
  sealTo,
} from '@workflow/core/serialization-format';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamResponse } from '~/lib/client/workflow-streams';
import { readStream } from '~/lib/workflow-api-client';
import { useStreamReader } from './use-stream-reader';

vi.mock('~/lib/workflow-api-client', () => ({
  readStream: vi.fn(),
}));

const env = {};
const RUN_KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const ABORT_PACKET = { aborted: true, reason: 'Cancelled\nby the user' };
const ENCRYPTION_MODES = ['symmetric', 'sealed'] as const;

function serializeAbortPacket(): Uint8Array {
  return encodeWithFormatPrefix(
    SerializationFormat.DEVALUE_V1,
    Uint8Array.from(
      new TextEncoder().encode(
        JSON.stringify([{ aborted: 1, reason: 2 }, true, ABORT_PACKET.reason])
      )
    )
  ) as Uint8Array;
}

async function encryptedPacket(mode: (typeof ENCRYPTION_MODES)[number]) {
  const key =
    mode === 'symmetric'
      ? await importKey(RUN_KEY)
      : sealTo((await deriveRunPayloadKeys(RUN_KEY)).keyPair.publicKey);
  return (await encryptEnvelope(serializeAbortPacket(), key)) as Uint8Array;
}

function frame(payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + payload.byteLength);
  new DataView(framed.buffer).setUint32(0, payload.byteLength, false);
  framed.set(payload, 4);
  return framed;
}

function mockStreamResponse(payload: Uint8Array) {
  vi.mocked(readStream).mockResolvedValue({
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        // Split both the format/length prefix and the encrypted payload.
        for (const part of [
          payload.slice(0, 2),
          payload.slice(2, 7),
          payload.slice(7, 19),
          payload.slice(19),
        ]) {
          controller.enqueue(part);
        }
        controller.close();
      },
    }),
    cursor: null,
    done: true,
  });
}

function renderReader(key?: Uint8Array, streamId = 'strm_test_system_abort') {
  return renderHook(() =>
    useStreamReader(env, streamId, 'wrun_test', key, 'completed')
  );
}

function emptyStreamResponse(done: boolean): StreamResponse {
  return {
    body: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    cursor: null,
    done,
  };
}

describe('useStreamReader payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('crypto', webcrypto);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it.each(
    ENCRYPTION_MODES
  )('recognizes an unframed %s abort packet as encrypted', async (mode) => {
    mockStreamResponse(await encryptedPacket(mode));
    const { result } = renderReader();

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    expect(result.current.error).toContain('Click Decrypt');
    expect(result.current.chunks).toEqual([]);
  });

  it.each(
    ENCRYPTION_MODES.flatMap((mode) => [
      { mode, framed: false },
      { mode, framed: true },
    ])
  )('decrypts a $mode packet (framed: $framed)', async ({ mode, framed }) => {
    const packet = await encryptedPacket(mode);
    mockStreamResponse(framed ? frame(packet) : packet);
    const { result } = renderReader(
      RUN_KEY,
      framed ? 'strm_test_user' : 'strm_test_system_abort'
    );

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.chunks.map(({ value }) => value)).toEqual([
      ABORT_PACKET,
    ]);
  });

  it.each([
    'x',
    'ab',
    'encrypted text',
    'encp is plain text',
    'devl is plain text',
  ])('keeps legacy user text readable: %s', async (text) => {
    mockStreamResponse(new TextEncoder().encode(`${text}\nnext line`));
    const { result } = renderReader(undefined, 'strm_test_user');
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.chunks.map(({ value }) => value)).toEqual([
      text,
      'next line',
    ]);
  });

  it('hydrates an unframed plaintext serialized abort packet', async () => {
    mockStreamResponse(serializeAbortPacket());
    const { result } = renderReader();

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    expect(result.current.chunks.map(({ value }) => value)).toEqual([
      ABORT_PACKET,
    ]);
  });

  it('continues to read legacy JSON lines and plain text', async () => {
    mockStreamResponse(
      new TextEncoder().encode('{"index":1}\nplain text\n{"index":3}')
    );
    const { result } = renderReader();

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    expect(result.current.chunks.map(({ value }) => value)).toEqual([
      { index: 1 },
      'plain text',
      { index: 3 },
    ]);
  });
});

describe('useStreamReader status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10],
    [0xff, 0xd8, 0xff, 0xe0],
    [...new TextEncoder().encode('GIF89a')],
    [...new TextEncoder().encode('RIFF1234WEBP')],
  ])('preserves raw image bytes across network chunks: %j', async (...header) => {
    const payload = Uint8Array.from([...header, 10, 0xff, 0, 1, 2, 3, 4, 5]);
    vi.mocked(readStream).mockResolvedValue({
      body: new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < payload.length; offset += 2)
            controller.enqueue(payload.slice(offset, offset + 2));
          controller.close();
        },
      }),
      cursor: null,
      done: true,
    });
    const { result } = renderHook(() =>
      useStreamReader(env, 'image', 'run-1', null, 'completed')
    );
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.chunks.map(({ value }) => value)).toEqual([payload]);
  });

  it('refreshes one growing image from the start while polling', async () => {
    const partial = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
    ]);
    const complete = Uint8Array.from([...partial, 10, 0xff, 5, 6]);
    const response = (bytes: Uint8Array, done: boolean): StreamResponse => ({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      cursor: 'storage-cursor',
      done,
    });
    vi.mocked(readStream)
      .mockResolvedValueOnce(response(partial, false))
      .mockResolvedValueOnce(response(complete, true));
    const { result } = renderHook(() =>
      useStreamReader(env, 'image', 'run-1', null, 'running')
    );
    await waitFor(() =>
      expect(result.current.chunks.map(({ value }) => value)).toEqual([partial])
    );
    const id = result.current.chunks[0].id;
    await waitFor(
      () =>
        expect(result.current.chunks.map(({ value }) => value)).toEqual([
          complete,
        ]),
      { timeout: 5000 }
    );
    expect(result.current.chunks[0].id).toBe(id);
    expect(vi.mocked(readStream).mock.calls[1][4]).toBeUndefined();
    expect(result.current.isLive).toBe(false);
  });

  it('reads a serialized frame shorter than the longest image signature', async () => {
    const payload = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      Uint8Array.from(new TextEncoder().encode('[0]'))
    ) as Uint8Array;
    const framed = new Uint8Array(4 + payload.length);
    new DataView(framed.buffer).setUint32(0, payload.length, false);
    framed.set(payload, 4);
    vi.mocked(readStream).mockResolvedValue({
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(framed);
          controller.close();
        },
      }),
      cursor: null,
      done: true,
    });
    const { result } = renderHook(() =>
      useStreamReader(env, 'stream', 'run-1', null, 'completed')
    );
    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));
    expect(result.current.chunks.map(({ value }) => value)).toEqual([0]);
  });

  it('does not report live while the initial request is loading', async () => {
    let resolveRead: (response: StreamResponse) => void = () => {};
    vi.mocked(readStream).mockReturnValue(
      new Promise((resolve) => {
        resolveRead = resolve;
      })
    );

    const { result, unmount } = renderHook(() =>
      useStreamReader(env, 'stream-1', 'run-1', null, 'running')
    );

    expect(result.current.isInitialLoading).toBe(true);
    expect(result.current.isLive).toBe(false);

    resolveRead(emptyStreamResponse(false));

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });
    expect(result.current.isLive).toBe(true);

    unmount();
  });

  it('does not report a completed stream as live', async () => {
    vi.mocked(readStream).mockResolvedValue(emptyStreamResponse(true));

    const { result } = renderHook(() =>
      useStreamReader(env, 'stream-1', 'run-1', null, 'running')
    );

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });
    expect(result.current.isLive).toBe(false);
  });

  it('does not report an open stream as live after the run completes', async () => {
    vi.mocked(readStream).mockResolvedValue(emptyStreamResponse(false));

    const { result } = renderHook(() =>
      useStreamReader(env, 'stream-1', 'run-1', null, 'completed')
    );

    await waitFor(() => {
      expect(result.current.isInitialLoading).toBe(false);
    });
    expect(result.current.isLive).toBe(false);
  });
});
