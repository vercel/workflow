import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/workflow-stream-ws-v1.json';
import { type DecodedFrame, decodeFrames } from './frames.js';
import {
  encodeStreamWsCloseRequest,
  encodeStreamWsWriteRequest,
  getStreamWsProtocolV1Url,
  parseStreamWsReply,
  STREAM_WS_PROTOCOL_V1,
  StreamWriterIdSchema,
  StreamWsCloseRequestMetaSchema,
  StreamWsRequestMetaSchema,
  StreamWsWriteRequestMetaSchema,
} from './stream-ws-protocol-v1.js';

type FixtureFrame = {
  direction: 'client_to_server' | 'server_to_client';
  meta: Record<string, unknown>;
  bodyHex: string;
  frameHex: string;
};

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function decodeOne(raw: Uint8Array): Promise<DecodedFrame> {
  for await (const frame of decodeFrames(
    (async function* () {
      yield raw;
    })()
  )) {
    return frame;
  }
  throw new Error('frame contained no envelope');
}

describe('workflow-stream-ws/v1 contract', () => {
  it('uses a protocol name independent from REST and workflow spec versions', () => {
    expect(STREAM_WS_PROTOCOL_V1).toBe('workflow-stream-ws/v1');
  });

  it('matches workflow-server’s canonical fixture byte-for-byte', async () => {
    const fixtureBytes = await readFile(
      new URL('./__fixtures__/workflow-stream-ws-v1.json', import.meta.url)
    );
    expect(createHash('sha256').update(fixtureBytes).digest('hex')).toBe(
      'deaa70651a43039322eb0eb5700c8daaa1cb8efbd8c9f5cbf25f671a78b0e38d'
    );

    expect(fixture.protocol).toBe(STREAM_WS_PROTOCOL_V1);
    expect(fixture.version).toBe(1);
    for (const frame of fixture.frames as FixtureFrame[]) {
      const raw = fromHex(frame.frameHex);
      const decoded = await decodeOne(raw);
      expect(decoded).toEqual({
        meta: frame.meta,
        body: fromHex(frame.bodyHex),
      });

      const type = decoded.meta.type;
      if (type === 'write') {
        const meta = StreamWsWriteRequestMetaSchema.parse(decoded.meta);
        const chunks = decodeMultiChunks(decoded.body);
        expect(encodeStreamWsWriteRequest(meta, chunks)).toEqual(raw);
      } else if (type === 'close') {
        expect(
          encodeStreamWsCloseRequest(
            StreamWsCloseRequestMetaSchema.parse(decoded.meta)
          )
        ).toEqual(raw);
      } else {
        expect(parseStreamWsReply(decoded.meta, decoded.body)).toEqual(
          frame.meta
        );
      }
    }
  });

  it('encodes writes with the existing multi-chunk body format', async () => {
    const raw = encodeStreamWsWriteRequest(
      { type: 'write', reqId: 1, chunkSeq: 4, numChunks: 2 },
      ['hi', new Uint8Array([0x01, 0x02])]
    );

    const decoded = await decodeOne(raw);
    expect(decoded.meta).toEqual({
      type: 'write',
      reqId: 1,
      chunkSeq: 4,
      numChunks: 2,
    });
    expect(decodeMultiChunks(decoded.body)).toEqual([
      new TextEncoder().encode('hi'),
      new Uint8Array([0x01, 0x02]),
    ]);
  });

  it('requires metadata numChunks to match the encoded chunks', () => {
    expect(() =>
      encodeStreamWsWriteRequest(
        { type: 'write', reqId: 1, chunkSeq: 0, numChunks: 2 },
        ['only one']
      )
    ).toThrow('declares 2 chunks but received 1');
  });

  it('encodes close with an empty body', async () => {
    await expect(
      decodeOne(encodeStreamWsCloseRequest({ type: 'close', reqId: 2 }))
    ).resolves.toEqual({
      meta: { type: 'close', reqId: 2 },
      body: new Uint8Array(),
    });
  });

  it('ignores unknown fields on known frame types', () => {
    expect(
      StreamWsRequestMetaSchema.parse({
        type: 'write',
        reqId: 1,
        chunkSeq: 0,
        numChunks: 1,
        futureField: true,
      })
    ).toEqual({ type: 'write', reqId: 1, chunkSeq: 0, numChunks: 1 });
    expect(
      parseStreamWsReply(
        { type: 'write_ack', reqId: 1, futureField: true },
        new Uint8Array()
      )
    ).toEqual({ type: 'write_ack', reqId: 1 });
  });

  it('accepts correlated and connection-fatal errors', () => {
    expect(
      parseStreamWsReply(
        { type: 'error', reqId: 1, status: -7, message: 'bad write' },
        new Uint8Array()
      )
    ).toEqual({ type: 'error', reqId: 1, status: -7, message: 'bad write' });
    expect(
      parseStreamWsReply({ type: 'error', status: 9000 }, new Uint8Array())
    ).toEqual({ type: 'error', status: 9000 });
  });

  it('rejects response bodies and unknown frame types', () => {
    expect(() =>
      parseStreamWsReply({ type: 'write_ack', reqId: 1 }, new Uint8Array([1]))
    ).toThrow('reply body must be empty');
    expect(
      StreamWsRequestMetaSchema.safeParse({ type: 'future', reqId: 1 }).success
    ).toBe(false);
  });

  it('validates request counters as nonnegative integers', () => {
    expect(
      StreamWsWriteRequestMetaSchema.safeParse({
        type: 'write',
        reqId: -1,
        chunkSeq: 0,
        numChunks: 1,
      }).success
    ).toBe(false);
    expect(
      StreamWsWriteRequestMetaSchema.safeParse({
        type: 'write',
        reqId: 1,
        chunkSeq: 1.5,
        numChunks: 1,
      }).success
    ).toBe(false);
    expect(
      StreamWsWriteRequestMetaSchema.safeParse({
        type: 'write',
        reqId: 1,
        chunkSeq: 0,
        numChunks: 0,
      }).success
    ).toBe(false);
  });

  it('validates and encodes the observational writer id', () => {
    const writerId = 'wrtr_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(StreamWriterIdSchema.parse(writerId)).toBe(writerId);
    expect(
      getStreamWsProtocolV1Url(
        'https://example.test/api/',
        'run/1',
        'stream name',
        writerId
      ).toString()
    ).toBe(
      'wss://example.test/api/websockets/v1/runs/run%2F1/streams/stream%20name?writerId=wrtr_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    );
    expect(StreamWriterIdSchema.safeParse(writerId.toLowerCase()).success).toBe(
      false
    );
  });
});

function decodeMultiChunks(body: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < body.byteLength) {
    if (body.byteLength - offset < 4) throw new Error('truncated chunk length');
    const length = new DataView(
      body.buffer,
      body.byteOffset + offset,
      4
    ).getUint32(0, false);
    offset += 4;
    if (body.byteLength - offset < length) throw new Error('truncated chunk');
    chunks.push(body.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}
