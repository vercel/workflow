import { StreamError } from '@workflow/errors';
import { peekFormatPrefix } from './format.js';

const HEADER_SIZE = 4;
// Match the existing object/byte stream frame limit.
const MAX_PACKET_SIZE = 100_000_000;

/** Wrap an already serialized (and possibly encrypted) abort packet. */
export function frameAbortStreamPayload(payload: Uint8Array): Uint8Array {
  if (payload.length < HEADER_SIZE || payload.length > MAX_PACKET_SIZE) {
    throw new StreamError('Invalid abort stream packet length');
  }
  const frame = new Uint8Array(HEADER_SIZE + payload.length);
  new DataView(frame.buffer).setUint32(0, payload.length, false);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

/**
 * Read one abort packet independently of transport chunk boundaries.
 * New packets have the usual big-endian length envelope; older writers send
 * a format-prefixed packet directly. Try decoding those after each read so a
 * complete legacy packet does not depend on the separate best-effort close.
 * Without a decoder, only EOF establishes the end of an unframed packet.
 */
export async function readAbortStreamPacket(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  tryDecode?: (packet: Uint8Array) => Promise<void>
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  const header = new Uint8Array(HEADER_SIZE);
  let size = 0;
  let packetLength: number | undefined;
  let raw = false;

  function packet(offset: number, length: number): Uint8Array {
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    return bytes.subarray(offset, offset + length);
  }

  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      if (size === 0) return undefined;
      if (raw) return packet(0, size);
      throw new StreamError('Abort stream ended with an incomplete frame');
    }
    if (!value.length) continue;
    if (size < HEADER_SIZE) {
      header.set(value.subarray(0, HEADER_SIZE - size), size);
    }
    chunks.push(value);
    size += value.length;
    if (size > MAX_PACKET_SIZE + HEADER_SIZE) {
      throw new StreamError('Abort stream packet exceeds maximum size');
    }
    if (size < HEADER_SIZE) continue;
    if (packetLength === undefined && !raw) {
      if (peekFormatPrefix(header)) {
        raw = true;
      } else {
        packetLength = new DataView(header.buffer).getUint32(0, false);
        if (packetLength < HEADER_SIZE || packetLength > MAX_PACKET_SIZE) {
          throw new StreamError('Invalid abort stream frame length');
        }
      }
    }
    if (packetLength !== undefined && size >= HEADER_SIZE + packetLength) {
      return packet(HEADER_SIZE, packetLength);
    }
    if (raw && tryDecode) {
      const candidate = packet(0, size);
      try {
        await tryDecode(candidate);
        return candidate;
      } catch {
        // A split serialized/encrypted packet cannot decode yet. Keep reading;
        // EOF retains the previous best-effort fallback for malformed packets.
      }
    }
  }
}
