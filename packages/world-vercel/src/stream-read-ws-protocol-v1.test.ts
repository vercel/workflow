import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/workflow-stream-read-ws-v1.json';
import { decodeFrames } from './frames.js';
import {
  encodeStreamReadWsControl,
  getStreamReadWsProtocolV1Url,
  parseStreamReadWsServerFrame,
  STREAM_READ_WS_PROTOCOL_V1,
  StreamReadWsClientMetaSchema,
  StreamReadWsReaderIdSchema,
} from './stream-read-ws-protocol-v1.js';

type FixtureFrame = {
  direction: 'client_to_server' | 'server_to_client';
  meta: Record<string, unknown>;
  bodyHex: string;
  frameHex: string;
};
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

async function decodeOne(raw: Uint8Array) {
  for await (const frame of decodeFrames(
    (async function* () {
      yield raw;
    })()
  )) {
    return frame;
  }
  throw new Error('no frame');
}

describe('workflow-stream-read-ws/v1 contract', () => {
  it('matches the canonical server fixture byte-for-byte', async () => {
    const rawFixture = await readFile(
      new URL('./__fixtures__/workflow-stream-read-ws-v1.json', import.meta.url)
    );
    expect(createHash('sha256').update(rawFixture).digest('hex')).toBe(
      '9e4517cee0b36fccefac9344a53e7e63534676313a09059d1246c3bad51fb821'
    );
    expect(fixture.protocol).toBe(STREAM_READ_WS_PROTOCOL_V1);

    for (const item of fixture.frames as FixtureFrame[]) {
      const raw = bytes(item.frameHex);
      const decoded = await decodeOne(raw);
      expect(decoded).toEqual({ meta: item.meta, body: bytes(item.bodyHex) });
      if (item.direction === 'client_to_server') {
        expect(
          encodeStreamReadWsControl(
            StreamReadWsClientMetaSchema.parse(decoded.meta)
          )
        ).toEqual(raw);
      } else {
        expect(
          parseStreamReadWsServerFrame(decoded.meta, decoded.body).meta
        ).toEqual(item.meta);
      }
    }
  });

  it('builds the independent reader endpoint', () => {
    const readerId = 'read_01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect(StreamReadWsReaderIdSchema.parse(readerId)).toBe(readerId);
    expect(
      getStreamReadWsProtocolV1Url(
        'https://example.test/api',
        'run/1',
        'stream name',
        -5,
        readerId
      ).toString()
    ).toBe(
      'wss://example.test/api/websockets/v1/runs/run%2F1/stream-reads/stream%20name?startIndex=-5&readerId=read_01ARZ3NDEKTSV4RRFFQ69G5FAV'
    );
  });

  it('enforces body and terminal invariants', () => {
    expect(() =>
      parseStreamReadWsServerFrame(
        { type: 'eof', finalIndex: 2, nextIndex: 4 },
        new Uint8Array()
      )
    ).toThrow('nextIndex');
    expect(() =>
      parseStreamReadWsServerFrame(
        { type: 'opened', requestedStartIndex: 1, resolvedStartIndex: 2 },
        new Uint8Array()
      )
    ).toThrow('resolves to itself');
    expect(() =>
      parseStreamReadWsServerFrame(
        { type: 'opened', requestedStartIndex: 0, resolvedStartIndex: 0 },
        new Uint8Array([1])
      )
    ).toThrow('body must be empty');
  });
});
