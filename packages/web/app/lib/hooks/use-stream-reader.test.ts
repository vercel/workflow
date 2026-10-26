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

function renderReader(key?: Uint8Array) {
  return renderHook(() =>
    useStreamReader(
      env,
      'strm_test_system_abort',
      'wrun_test',
      key,
      'completed'
    )
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
    const { result } = renderReader(RUN_KEY);

    await waitFor(() => expect(result.current.isInitialLoading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.chunks.map(({ value }) => value)).toEqual([
      ABORT_PACKET,
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
