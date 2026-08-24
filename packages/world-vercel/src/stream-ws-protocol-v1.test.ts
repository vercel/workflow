import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/workflow-stream-ws-v1.json';
import { decodeFrames } from './frames.js';
import {
  encodeStreamWsWriteRequest,
  STREAM_WS_PROTOCOL_V1,
  StreamWsReplyMetaSchema,
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

async function decodeOne(raw: Uint8Array) {
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
      'd2bbd72c24d18ff11263610dcae968c54273eff2133fa4fb9303ef181834e508'
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
      if (frame.direction === 'client_to_server') {
        const requestMeta = StreamWsWriteRequestMetaSchema.parse(decoded.meta);
        expect(encodeStreamWsWriteRequest(requestMeta, decoded.body)).toEqual(
          raw
        );
      } else {
        expect(StreamWsReplyMetaSchema.parse(decoded.meta)).toEqual(frame.meta);
      }
    }
  });

  it('encodes a stream write in the shared binary envelope', async () => {
    const body = new Uint8Array([0x01, 0x02]);
    const raw = encodeStreamWsWriteRequest(
      { type: 'stream_write', reqId: 1 },
      body
    );

    await expect(decodeOne(raw)).resolves.toEqual({
      meta: { type: 'stream_write', reqId: 1 },
      body,
    });
  });

  it('accepts only nonnegative integral request ids', () => {
    expect(
      StreamWsWriteRequestMetaSchema.safeParse({
        type: 'stream_write',
        reqId: -1,
      }).success
    ).toBe(false);
    expect(
      StreamWsWriteRequestMetaSchema.safeParse({
        type: 'stream_write',
        reqId: 1.5,
      }).success
    ).toBe(false);
  });

  it('accepts successful and error replies with their required status fields', () => {
    expect(
      StreamWsReplyMetaSchema.parse({
        type: 'stream_write_ack',
        reqId: 1,
        status: 200,
        nextIndex: 8,
      })
    ).toEqual({
      type: 'stream_write_ack',
      reqId: 1,
      status: 200,
      nextIndex: 8,
    });
    expect(
      StreamWsReplyMetaSchema.parse({
        type: 'error',
        reqId: 1,
        status: 400,
      })
    ).toEqual({ type: 'error', reqId: 1, status: 400 });
    expect(
      StreamWsReplyMetaSchema.safeParse({
        type: 'stream_write_ack',
        reqId: 1,
        status: 200,
      }).success
    ).toBe(false);
    expect(
      StreamWsReplyMetaSchema.safeParse({
        type: 'stream_write_ack',
        reqId: 1,
        status: 400,
        nextIndex: 8,
      }).success
    ).toBe(false);
  });
});
