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

// How many chunk boundaries inside one read's buffer may be tried as the end
// of a legacy packet, on top of the attempt each pause in the transport gets.
const MAX_INTERIOR_DECODE_ATTEMPTS = 8;

// Captured when the module loads so a caller's fake timers cannot hold a
// packet back.
const nextEventLoopTurn: (resume: () => void) => void =
  typeof setImmediate === 'function'
    ? setImmediate
    : (resume) => setTimeout(resume, 0);

/**
 * Resolve `false` once everything the transport has already received is
 * readable: a read of buffered data settles in microtasks, and a turn of the
 * event loop runs after the I/O callbacks that deliver what has arrived.
 */
function transportPaused(): Promise<false> {
  return new Promise((resolve) => nextEventLoopTurn(() => resolve(false)));
}

/** The bytes read so far, in one buffer that grows by doubling. */
class PacketBytes {
  private bytes = new Uint8Array(1024);
  size = 0;

  append(chunk: Uint8Array): void {
    const size = this.size + chunk.length;
    if (size > MAX_PACKET_SIZE + HEADER_SIZE) {
      throw new StreamError('Abort stream packet exceeds maximum size');
    }
    if (size > this.bytes.length) {
      const grown = new Uint8Array(Math.max(size, this.bytes.length * 2));
      grown.set(this.bytes.subarray(0, this.size));
      this.bytes = grown;
    }
    this.bytes.set(chunk, this.size);
    this.size = size;
  }

  /** A copy, so a returned packet never aliases the buffer. */
  copy(start: number, end: number): Uint8Array {
    return this.bytes.slice(start, end);
  }

  /** The frame length, or `undefined` when the bytes start a legacy packet. */
  frameLength(): number | undefined {
    const header = this.bytes.subarray(0, HEADER_SIZE);
    if (peekFormatPrefix(header)) return undefined;
    const length = new DataView(header.buffer).getUint32(0, false);
    if (length < HEADER_SIZE || length > MAX_PACKET_SIZE) {
      throw new StreamError('Invalid abort stream frame length');
    }
    return length;
  }
}

/**
 * Read one abort packet independently of transport chunk boundaries.
 * New packets have the usual big-endian length envelope; older writers send
 * a format-prefixed packet directly, whose length nothing on the wire states.
 * Without a decoder, only EOF establishes the end of an unframed packet.
 *
 * With a decoder, a legacy packet ends at a chunk boundary where the bytes
 * before it decode, so a complete one is delivered without the separate
 * best-effort close and without being held back by a packet written behind
 * it. An attempt on an encrypted packet is a round trip to the crypto thread pool,
 * so attempts follow the transport rather than the reads: the reader keeps
 * buffering while more data is already readable and decodes when the next
 * read is still pending a turn of the event loop later, or has ended or
 * failed. Each such pause costs one attempt on everything buffered; when
 * that fails, the chunk boundaries inside the buffer are tried in order, at
 * most {@link MAX_INTERIOR_DECODE_ATTEMPTS} of them per call; a packet that
 * ends at a later boundary of a buffer with more data behind it is not
 * recognised, and the read continues as it does for a malformed packet.
 * A packet whose chunks are all readable at once therefore costs one decode
 * however many chunks it has, and one that trickles in costs one decode per
 * event-loop turn in which data arrived.
 *
 * After a legacy packet is returned the reader may have a read outstanding
 * and may have consumed chunks that followed the packet. The caller must
 * cancel the reader and must not read from it again.
 */
export async function readAbortStreamPacket(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  tryDecode?: (packet: Uint8Array) => Promise<void>
): Promise<Uint8Array | undefined> {
  const buffer = new PacketBytes();
  let packetLength: number | undefined;
  let raw = false;
  // Chunk boundaries not yet tried as the end of a legacy packet.
  let interior: number[] = [];
  let interiorAttempts = MAX_INTERIOR_DECODE_ATTEMPTS;

  async function decodes(end: number): Promise<Uint8Array | undefined> {
    const candidate = buffer.copy(0, end);
    try {
      await tryDecode?.(candidate);
      return candidate;
    } catch {
      // A split serialized/encrypted packet cannot decode yet.
      return undefined;
    }
  }

  /** The packet ending at the pause, or failing that at an earlier chunk. */
  async function decodeAtPause(): Promise<Uint8Array | undefined> {
    const ends = [buffer.size, ...interior.filter((end) => end < buffer.size)];
    interior = [];
    for (const end of ends) {
      const packet = await decodes(end);
      if (packet) return packet;
      if (end !== buffer.size) interiorAttempts--;
    }
    return undefined;
  }

  // The next chunk that carries bytes, or the end of the stream. A transport
  // may flush zero-length chunks, which say nothing about a packet: they are
  // neither data to wait behind nor a reason to decode again.
  async function readChunk(): ReturnType<typeof reader.read> {
    for (;;) {
      const result = await reader.read();
      if (result.done || result.value.length) return result;
    }
  }

  let next: ReturnType<typeof reader.read> | undefined;
  for (;;) {
    const { value, done } = await (next ?? readChunk());
    next = undefined;
    if (done) {
      if (buffer.size === 0) return undefined;
      // Nothing decoded: a malformed packet falls back, best effort, to
      // everything that was read.
      if (raw) return buffer.copy(0, buffer.size);
      throw new StreamError('Abort stream ended with an incomplete frame');
    }
    buffer.append(value);
    if (buffer.size < HEADER_SIZE) continue;
    if (packetLength === undefined && !raw) {
      packetLength = buffer.frameLength();
      raw = packetLength === undefined;
    }
    if (packetLength !== undefined) {
      if (buffer.size < HEADER_SIZE + packetLength) continue;
      return buffer.copy(HEADER_SIZE, HEADER_SIZE + packetLength);
    }
    if (!tryDecode) continue;
    if (interior.length < interiorAttempts) interior.push(buffer.size);
    // Start the next read first. When it yields more data before the
    // transport pauses, take that data without decoding. A read that ends or
    // fails leaves what is buffered as all there will be, so that is decoded
    // before the loop sees the outcome.
    const read = readChunk();
    // A read still pending when a packet decodes is settled by the caller's
    // cancel; its failure then has no one to report to.
    read.catch(() => {});
    next = read;
    const moreBuffered = await Promise.race([
      read.then(
        (result) => !result.done,
        () => false
      ),
      transportPaused(),
    ]);
    if (moreBuffered) continue;
    const packet = await decodeAtPause();
    if (packet) return packet;
  }
}
