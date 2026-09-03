import { WorkflowWorldError } from '@workflow/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64, deriveRunKeyPair } from '../sealed-box.js';
import { deriveRunPayloadKeys } from '../serialization/encryption.js';
import { getSerializeStream } from '../serialization.js';
import { getWorldLazy } from './get-world-lazy.js';
import {
  createStandaloneStreamId,
  getStandaloneStream,
  standaloneStreamIdFor,
} from './standalone-stream.js';

vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

const id = 'stnd_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const material = new Uint8Array(32).fill(0x41);

async function encryption(deployment = 'dpl_local', keyMaterial = material) {
  return {
    v: 1 as const,
    s: 'dpl' as const,
    d: deployment,
    k: bytesToBase64((await deriveRunKeyPair(keyMaterial)).publicKey),
  };
}

function world(overrides: Record<string, unknown> = {}) {
  return {
    createStandaloneStreamId: vi.fn(() => id),
    standaloneStreamIdFor: vi.fn(async () => id),
    getDeploymentId: vi.fn(async () => 'dpl_local'),
    getEncryptionKeyForRun: vi.fn(async () => material),
    standaloneStreams: {
      write: vi.fn(async () => {}),
      writeMulti: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      get: vi.fn(),
      getChunks: vi.fn(),
      getInfo: vi.fn(),
      delete: vi.fn(async () => {}),
    },
    ...overrides,
  } as any;
}

describe('standalone streams', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates random and stable ID generation to the World', async () => {
    const mock = world();
    vi.mocked(getWorldLazy).mockResolvedValue(mock);
    await expect(createStandaloneStreamId()).resolves.toBe(id);
    await expect(
      standaloneStreamIdFor({ name: 'chat', region: 'sfo1' })
    ).resolves.toBe(id);
    expect(mock.standaloneStreamIdFor).toHaveBeenCalledWith({
      name: 'chat',
      region: 'sfo1',
    });
  });

  it('fails clearly when the World does not support standalone streams', async () => {
    vi.mocked(getWorldLazy).mockResolvedValue({} as any);
    await expect(createStandaloneStreamId()).rejects.toThrow(
      'Standalone streams are not supported by the configured World'
    );
    await expect(getStandaloneStream(id).getInfo()).rejects.toThrow(
      'Standalone streams are not supported by the configured World'
    );
  });

  it('anchors an unwritten stream locally and writes symmetric frames', async () => {
    const mock = world();
    mock.standaloneStreams.getInfo.mockResolvedValue({
      tailIndex: -1,
      earliestIndex: 0,
      done: false,
      encryption: null,
      retentionDays: null,
    });
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writable = await getStandaloneStream<string>(id).getWritable();
    const writer = writable.getWriter();
    await writer.write('first');
    await writer.close();

    expect(mock.standaloneStreams.write).toHaveBeenCalledWith(
      id,
      expect.any(Uint8Array),
      { encryption: await encryption() }
    );
    expect(mock.standaloneStreams.close).toHaveBeenCalledWith(id);
    expect(
      new TextDecoder().decode(mock.standaloneStreams.write.mock.calls[0][1])
    ).toContain('encr');
  });

  it('surfaces buffered transport failures from the host writable', async () => {
    const mock = world();
    mock.standaloneStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: false,
      encryption: await encryption(),
      retentionDays: 30,
    });
    mock.standaloneStreams.write.mockRejectedValue(new Error('append failed'));
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writer = (
      await getStandaloneStream<string>(id).getWritable()
    ).getWriter();
    await writer.write('first');
    await expect(writer.close()).rejects.toThrow('append failed');
  });

  it('refreshes the encryption, re-encrypts, and retries a rejected write', async () => {
    const streamId = 'stnd_01ARZ3NDEKTSV4RRFFQ69G5FAY';
    const foreignMaterial = new Uint8Array(32).fill(0x22);
    const foreignEncryption = await encryption('dpl_foreign', foreignMaterial);
    const mock = world();
    mock.standaloneStreams.getInfo
      .mockResolvedValueOnce({
        tailIndex: -1,
        earliestIndex: 0,
        done: false,
        encryption: null,
        retentionDays: null,
      })
      .mockResolvedValue({
        tailIndex: -1,
        earliestIndex: 0,
        done: false,
        encryption: foreignEncryption,
        retentionDays: 30,
      });
    mock.standaloneStreams.write
      .mockRejectedValueOnce(
        new WorkflowWorldError('mismatch', {
          status: 409,
          code: 'stream_encryption_mismatch',
        })
      )
      .mockResolvedValue(undefined);
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writer = (
      await getStandaloneStream<string>(streamId).getWritable()
    ).getWriter();
    await writer.write('first');
    await writer.close();

    expect(mock.standaloneStreams.write).toHaveBeenCalledTimes(2);
    expect(mock.standaloneStreams.write.mock.calls[1][2]).toEqual({
      encryption: foreignEncryption,
    });
    expect(
      new TextDecoder().decode(mock.standaloneStreams.write.mock.calls[1][1])
    ).toContain('encp');
  });

  it('resolves a foreign anchor key lazily and decrypts framed data', async () => {
    const streamId = 'stnd_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const foreignMaterial = new Uint8Array(32).fill(0x32);
    const keys = await deriveRunPayloadKeys(foreignMaterial);
    const serializer = getSerializeStream({}, keys);
    const framePromise = new Response(serializer.readable).bytes();
    const serializerWriter = serializer.writable.getWriter();
    await serializerWriter.write('from standalone stream');
    await serializerWriter.close();
    const frame = await framePromise;

    const mock = world({
      getDeploymentId: vi.fn(async () => 'dpl_reader'),
      getEncryptionKeyForRun: vi.fn(async () => foreignMaterial),
    });
    mock.standaloneStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: true,
      encryption: await encryption('dpl_anchor', foreignMaterial),
      retentionDays: 30,
    });
    mock.standaloneStreams.get.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(frame);
          controller.close();
        },
      })
    );
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const reader = getStandaloneStream<string>(streamId)
      .getReadable()
      .getReader();
    await expect(reader.read()).resolves.toEqual({
      value: 'from standalone stream',
      done: false,
    });
    await expect(reader.read()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(mock.getEncryptionKeyForRun).toHaveBeenCalledWith(streamId, {
      deploymentId: 'dpl_anchor',
    });
  });

  it('forces the run-key API when local reader material does not match', async () => {
    const streamId = 'stnd_01ARZ3NDEKTSV4RRFFQ69G5FAZ';
    const rotatedMaterial = new Uint8Array(32).fill(7);
    const rotatedKeys = await deriveRunPayloadKeys(rotatedMaterial);
    const serializer = getSerializeStream({}, rotatedKeys);
    const framePromise = new Response(serializer.readable).bytes();
    const serializerWriter = serializer.writable.getWriter();
    await serializerWriter.write('rotated');
    await serializerWriter.close();
    const frame = await framePromise;

    const getEncryptionKeyForRun = vi.fn(
      async (_id: string, context: Record<string, unknown>) =>
        context.forceRemote ? rotatedMaterial : material
    );
    const mock = world({ getEncryptionKeyForRun });
    mock.standaloneStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: true,
      encryption: await encryption('dpl_local', rotatedMaterial),
      retentionDays: 30,
    });
    mock.standaloneStreams.get.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(frame);
          controller.close();
        },
      })
    );
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const reader = getStandaloneStream<string>(streamId)
      .getReadable()
      .getReader();
    await expect(reader.read()).resolves.toMatchObject({ value: 'rotated' });
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(streamId, {
      deploymentId: 'dpl_local',
      forceRemote: true,
    });
  });

  it('falls back to sealing when local BYOK material does not match', async () => {
    const streamId = 'stnd_01ARZ3NDEKTSV4RRFFQ69G5FB0';
    const foreignEncryption = await encryption(
      'dpl_local',
      new Uint8Array(32).fill(7)
    );
    const mock = world();
    mock.standaloneStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: false,
      encryption: foreignEncryption,
      retentionDays: 30,
    });
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writer = (
      await getStandaloneStream<string>(streamId).getWritable()
    ).getWriter();
    await writer.write('sealed');
    await writer.close();

    expect(
      new TextDecoder().decode(mock.standaloneStreams.write.mock.calls[0][1])
    ).toContain('encp');
  });
});
