import { describe, expect, it } from 'vitest';
import { encodeFrame } from './frames.js';
import {
  DEFAULT_WS_MAX_MESSAGE_BYTES,
  decodeFrame,
  encodeWsFrameMessages,
  splitEncodedFrame,
  WsPartAssembler,
  WsPartProtocolError,
  wsMaxMessageBytes,
} from './ws-parts.js';

const LIMIT = 2048;

function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

function body(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

const META = { reqId: 7, type: 'event_ack', status: 200, eventId: 'evnt_1' };

function roundTrip(messages: Uint8Array[]) {
  const assembler = new WsPartAssembler();
  const out = [];
  for (const message of messages) {
    const frame = assembler.accept(decodeFrame(message));
    if (frame) out.push(frame);
  }
  return { frames: out, open: assembler.openFrames };
}

function wholeFrameSize(bodySize: number): number {
  return encodeFrame(META, new Uint8Array(bodySize)).byteLength;
}

describe('encodeWsFrameMessages', () => {
  it('sends a frame at or under the limit as one unchanged message', () => {
    const fits = LIMIT - wholeFrameSize(0);
    const b = body(fits);
    const messages = encodeWsFrameMessages(META, b, LIMIT);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual(encodeFrame(META, b));
    expect(messages[0]?.byteLength).toBe(LIMIT);
  });

  it.each([
    ['one byte over', 1],
    ['exactly two limits', LIMIT * 2],
    ['three limits plus 7', LIMIT * 3 + 7],
    ['many parts', LIMIT * 40 + 123],
  ])('splits and rebuilds a frame %s', (_label, extra) => {
    const b = body(LIMIT - wholeFrameSize(0) + extra);
    const messages = encodeWsFrameMessages(META, b, LIMIT);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const message of messages) {
      expect(message.byteLength).toBeLessThanOrEqual(LIMIT);
    }

    const decoded = messages.map((m) => decodeFrame(m));
    expect(decoded[0]?.meta).toEqual({
      ...META,
      partIndex: 0,
      partCount: messages.length,
    });
    decoded.slice(1).forEach((part, i) => {
      expect(part.meta).toEqual({
        type: 'part',
        reqId: 7,
        partIndex: i + 1,
        partCount: messages.length,
      });
    });

    const { frames, open } = roundTrip(messages);
    expect(open).toBe(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta).toEqual(META);
    expect(frames[0]?.body).toEqual(b);
  });

  it('splits an already-encoded frame the same way', () => {
    const b = body(LIMIT * 3);
    expect(splitEncodedFrame(encodeFrame(META, b), LIMIT)).toEqual(
      encodeWsFrameMessages(META, b, LIMIT)
    );
    const small = encodeFrame(META, body(10));
    expect(splitEncodedFrame(small, LIMIT)).toEqual([small]);
  });

  it('refuses to split an oversized frame without a reqId', () => {
    expect(() =>
      encodeWsFrameMessages({ type: 'drain' }, body(LIMIT * 2), LIMIT)
    ).toThrow(/no reqId/);
  });
});

describe('WsPartAssembler', () => {
  const split = (reqId: number, size: number) =>
    encodeWsFrameMessages({ ...META, reqId }, body(size), LIMIT).map((m) =>
      decodeFrame(m)
    );

  it('passes a whole frame straight through', () => {
    const frame = { meta: META, body: body(3) };
    expect(new WsPartAssembler().accept(frame)).toBe(frame);
  });

  it('rebuilds interleaved frames by reqId', () => {
    const a = split(1, LIMIT * 3);
    const b = split(2, LIMIT * 2);
    const order = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) order.push(at(a, i));
      if (b[i]) order.push(at(b, i));
    }
    const assembler = new WsPartAssembler();
    const done = order.flatMap((part) => {
      const frame = assembler.accept(part);
      return frame ? [frame] : [];
    });
    expect(done.map((f) => f.meta.reqId)).toEqual([2, 1]);
    expect(done[0]?.body).toEqual(body(LIMIT * 2));
    expect(done[1]?.body).toEqual(body(LIMIT * 3));
    expect(assembler.openFrames).toBe(0);
  });

  it('rejects a continuation with no open frame', () => {
    const parts = split(1, LIMIT * 2);
    expect(() => new WsPartAssembler().accept(at(parts, 1))).toThrow(
      /no open frame/
    );
  });

  it('rejects a second first part for an open reqId', () => {
    const parts = split(1, LIMIT * 2);
    const assembler = new WsPartAssembler();
    assembler.accept(at(parts, 0));
    expect(() => assembler.accept(at(parts, 0))).toThrow(WsPartProtocolError);
  });

  it('rejects a skipped or repeated partIndex', () => {
    const parts = split(1, LIMIT * 3);
    const skip = new WsPartAssembler();
    skip.accept(at(parts, 0));
    expect(() => skip.accept(at(parts, 2))).toThrow(/expected 1/);

    const repeat = new WsPartAssembler();
    repeat.accept(at(parts, 0));
    repeat.accept(at(parts, 1));
    expect(() => repeat.accept(at(parts, 1))).toThrow(/expected 2/);
  });

  it('rejects a changed partCount', () => {
    const parts = split(1, LIMIT * 3);
    const assembler = new WsPartAssembler();
    assembler.accept(at(parts, 0));
    const changed = {
      meta: { ...at(parts, 1).meta, partCount: 99 },
      body: at(parts, 1).body,
    };
    expect(() => assembler.accept(changed)).toThrow(/partCount/);
  });

  it('rejects a continuation with extra fields', () => {
    const parts = split(1, LIMIT * 2);
    const assembler = new WsPartAssembler();
    assembler.accept(at(parts, 0));
    const extra = {
      meta: { ...at(parts, 1).meta, status: 200 },
      body: at(parts, 1).body,
    };
    expect(() => assembler.accept(extra)).toThrow(/exactly/);
  });

  it('rejects a first part that does not start at 0 or claims one part', () => {
    const assembler = new WsPartAssembler();
    expect(() =>
      assembler.accept({
        meta: { ...META, partIndex: 1, partCount: 3 },
        body: body(1),
      })
    ).toThrow(/expected 0/);
    expect(() =>
      assembler.accept({
        meta: { ...META, partIndex: 0, partCount: 1 },
        body: body(1),
      })
    ).toThrow(/partCount/);
  });

  it('rejects a frame over the size cap', () => {
    const parts = split(1, LIMIT * 4);
    const assembler = new WsPartAssembler(LIMIT * 2);
    expect(() => {
      for (const part of parts) assembler.accept(part);
    }).toThrow(/exceeds/);
    expect(assembler.openFrames).toBe(0);
  });
});

describe('wsMaxMessageBytes', () => {
  it('defaults to 12 MiB', () => {
    expect(wsMaxMessageBytes(undefined)).toBe(DEFAULT_WS_MAX_MESSAGE_BYTES);
    expect(DEFAULT_WS_MAX_MESSAGE_BYTES).toBe(12 * 1024 * 1024);
  });

  it('reads a positive integer and ignores anything else', () => {
    expect(wsMaxMessageBytes('4194304')).toBe(4194304);
    expect(wsMaxMessageBytes('abc')).toBe(DEFAULT_WS_MAX_MESSAGE_BYTES);
    expect(wsMaxMessageBytes('10')).toBe(DEFAULT_WS_MAX_MESSAGE_BYTES);
    expect(wsMaxMessageBytes('')).toBe(DEFAULT_WS_MAX_MESSAGE_BYTES);
  });
});

/**
 * Byte-for-byte fixture shared with the backend's own part tests: if either
 * side's part encoding changes, both copies of this test must change
 * together.
 */
const GOLDEN_MESSAGES = [
  '00000048b90006657265714964056474797065696576656e745f61636b6673746174757318c8676576656e7449646765766e745f30316970617274496e646578006970617274436f756e74060000000f000102030405060708090a0b0c0d0e',
  '0000002ab9000464747970656470617274657265714964056970617274496e646578016970617274436f756e74060000002c0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a',
  '0000002ab9000464747970656470617274657265714964056970617274496e646578026970617274436f756e74060000002c3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60616263646566',
  '0000002ab9000464747970656470617274657265714964056970617274496e646578036970617274436f756e74060000002c6768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f909192',
  '0000002ab9000464747970656470617274657265714964056970617274496e646578046970617274436f756e74060000002c939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbe',
  '0000002ab9000464747970656470617274657265714964056970617274496e646578056970617274436f756e740600000009bfc0c1c2c3c4c5c6c7',
];

describe('golden fixture', () => {
  const meta = { reqId: 5, type: 'event_ack', status: 200, eventId: 'evnt_01' };
  const goldenBody = Uint8Array.from({ length: 200 }, (_, i) => i);

  it('encodes the shared fixture exactly', () => {
    const messages = encodeWsFrameMessages(meta, goldenBody, 96);
    expect(messages.map((m) => Buffer.from(m).toString('hex'))).toEqual(
      GOLDEN_MESSAGES
    );
  });

  it('rebuilds the shared fixture', () => {
    const assembler = new WsPartAssembler();
    const frames = GOLDEN_MESSAGES.flatMap((hex) => {
      const frame = assembler.accept(decodeFrame(Buffer.from(hex, 'hex')));
      return frame ? [frame] : [];
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta).toEqual(meta);
    expect(frames[0]?.body).toEqual(goldenBody);
  });
});
