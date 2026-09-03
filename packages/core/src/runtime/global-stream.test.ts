import { WorkflowWorldError } from '@workflow/errors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToBase64, deriveRunKeyPair } from '../sealed-box.js';
import { deriveRunPayloadKeys } from '../serialization/encryption.js';
import { getSerializeStream } from '../serialization.js';
import { getWorldLazy } from './get-world-lazy.js';
import {
  createGlobalStreamId,
  getGlobalStream,
  globalStreamIdFor,
} from './global-stream.js';

vi.mock('./get-world-lazy.js', () => ({ getWorldLazy: vi.fn() }));

const id = 'gstr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const material = new Uint8Array(32).fill(0x41);

async function envelope(deployment = 'dpl_local', keyMaterial = material) {
  return {
    v: 1 as const,
    s: 'dpl' as const,
    d: deployment,
    k: bytesToBase64((await deriveRunKeyPair(keyMaterial)).publicKey),
  };
}

function world(overrides: Record<string, unknown> = {}) {
  return {
    createGlobalStreamId: vi.fn(() => id),
    globalStreamIdFor: vi.fn(async () => id),
    getDeploymentId: vi.fn(async () => 'dpl_local'),
    getEncryptionKeyForRun: vi.fn(async () => material),
    globalStreams: {
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

describe('global streams', () => {
  beforeEach(() => vi.clearAllMocks());

  it('delegates random and stable ID generation to the World', async () => {
    const mock = world();
    vi.mocked(getWorldLazy).mockResolvedValue(mock);
    await expect(createGlobalStreamId()).resolves.toBe(id);
    await expect(
      globalStreamIdFor({ name: 'chat', region: 'sfo1' })
    ).resolves.toBe(id);
    expect(mock.globalStreamIdFor).toHaveBeenCalledWith({
      name: 'chat',
      region: 'sfo1',
    });
  });

  it('fails clearly when the World does not support global streams', async () => {
    vi.mocked(getWorldLazy).mockResolvedValue({} as any);
    await expect(createGlobalStreamId()).rejects.toThrow(
      'Global streams are not supported by the configured World'
    );
    await expect(getGlobalStream(id).getInfo()).rejects.toThrow(
      'Global streams are not supported by the configured World'
    );
  });

  it('anchors an unwritten stream locally and writes symmetric frames', async () => {
    const mock = world();
    mock.globalStreams.getInfo.mockResolvedValue({
      tailIndex: -1,
      earliestIndex: 0,
      done: false,
      encryption: null,
      retentionDays: null,
    });
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writable = await getGlobalStream<string>(id).getWritable();
    const writer = writable.getWriter();
    await writer.write('first');
    await writer.close();

    expect(mock.globalStreams.write).toHaveBeenCalledWith(
      id,
      expect.any(Uint8Array),
      { envelope: await envelope() }
    );
    expect(mock.globalStreams.close).toHaveBeenCalledWith(id);
    expect(
      new TextDecoder().decode(mock.globalStreams.write.mock.calls[0][1])
    ).toContain('encr');
  });

  it('surfaces buffered transport failures from the host writable', async () => {
    const mock = world();
    mock.globalStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: false,
      encryption: await envelope(),
      retentionDays: 30,
    });
    mock.globalStreams.write.mockRejectedValue(new Error('append failed'));
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writer = (
      await getGlobalStream<string>(id).getWritable()
    ).getWriter();
    await writer.write('first');
    await expect(writer.close()).rejects.toThrow('append failed');
  });

  it('refreshes the envelope, re-encrypts, and retries a rejected write', async () => {
    const streamId = 'gstr_01ARZ3NDEKTSV4RRFFQ69G5FAY';
    const foreignMaterial = new Uint8Array(32).fill(0x22);
    const foreignEnvelope = await envelope('dpl_foreign', foreignMaterial);
    const mock = world();
    mock.globalStreams.getInfo
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
        encryption: foreignEnvelope,
        retentionDays: 30,
      });
    mock.globalStreams.write
      .mockRejectedValueOnce(
        new WorkflowWorldError('mismatch', {
          status: 409,
          code: 'stream_encryption_mismatch',
        })
      )
      .mockResolvedValue(undefined);
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writer = (
      await getGlobalStream<string>(streamId).getWritable()
    ).getWriter();
    await writer.write('first');
    await writer.close();

    expect(mock.globalStreams.write).toHaveBeenCalledTimes(2);
    expect(mock.globalStreams.write.mock.calls[1][2]).toEqual({
      envelope: foreignEnvelope,
    });
    expect(
      new TextDecoder().decode(mock.globalStreams.write.mock.calls[1][1])
    ).toContain('encp');
  });

  it('resolves a foreign anchor key lazily and decrypts framed data', async () => {
    const streamId = 'gstr_01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const foreignMaterial = new Uint8Array(32).fill(0x32);
    const keys = await deriveRunPayloadKeys(foreignMaterial);
    const serializer = getSerializeStream({}, keys);
    const framePromise = new Response(serializer.readable).bytes();
    const serializerWriter = serializer.writable.getWriter();
    await serializerWriter.write('from global stream');
    await serializerWriter.close();
    const frame = await framePromise;

    const mock = world({
      getDeploymentId: vi.fn(async () => 'dpl_reader'),
      getEncryptionKeyForRun: vi.fn(async () => foreignMaterial),
    });
    mock.globalStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: true,
      encryption: await envelope('dpl_anchor', foreignMaterial),
      retentionDays: 30,
    });
    mock.globalStreams.get.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(frame);
          controller.close();
        },
      })
    );
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const reader = getGlobalStream<string>(streamId).getReadable().getReader();
    await expect(reader.read()).resolves.toEqual({
      value: 'from global stream',
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
    const streamId = 'gstr_01ARZ3NDEKTSV4RRFFQ69G5FAZ';
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
    mock.globalStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: true,
      encryption: await envelope('dpl_local', rotatedMaterial),
      retentionDays: 30,
    });
    mock.globalStreams.get.mockResolvedValue(
      new ReadableStream({
        start(controller) {
          controller.enqueue(frame);
          controller.close();
        },
      })
    );
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const reader = getGlobalStream<string>(streamId).getReadable().getReader();
    await expect(reader.read()).resolves.toMatchObject({ value: 'rotated' });
    expect(getEncryptionKeyForRun).toHaveBeenCalledWith(streamId, {
      deploymentId: 'dpl_local',
      forceRemote: true,
    });
  });

  it('falls back to sealing when local BYOK material does not match', async () => {
    const streamId = 'gstr_01ARZ3NDEKTSV4RRFFQ69G5FB0';
    const foreignEnvelope = await envelope(
      'dpl_local',
      new Uint8Array(32).fill(7)
    );
    const mock = world();
    mock.globalStreams.getInfo.mockResolvedValue({
      tailIndex: 0,
      earliestIndex: 0,
      done: false,
      encryption: foreignEnvelope,
      retentionDays: 30,
    });
    vi.mocked(getWorldLazy).mockResolvedValue(mock);

    const writer = (
      await getGlobalStream<string>(streamId).getWritable()
    ).getWriter();
    await writer.write('sealed');
    await writer.close();

    expect(
      new TextDecoder().decode(mock.globalStreams.write.mock.calls[0][1])
    ).toContain('encp');
  });
});
