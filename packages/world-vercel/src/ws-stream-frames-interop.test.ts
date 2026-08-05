import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/ws-stream-frames.json';
import { decodeFrames, encodeFrame } from './frames.js';

function fromHex(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function decodeOne(raw: Uint8Array) {
  const source = (async function* () {
    yield raw;
  })();
  for await (const frame of decodeFrames(source)) return frame;
  throw new Error('fixture contained no frame');
}

describe('workflow-server WS stream frame fixture', () => {
  it.each(
    fixture.frames
  )('decodes and reproduces $direction $meta.type byte-for-byte', async ({
    meta,
    bodyHex,
    frameHex,
  }) => {
    const decoded = await decodeOne(fromHex(frameHex));
    expect(decoded.meta).toEqual(meta);
    expect(decoded.body).toEqual(fromHex(bodyHex));
    expect(encodeFrame(meta, fromHex(bodyHex))).toEqual(fromHex(frameHex));
  });
});
