/**
 * Encoding of the per-run VM snapshots the QuickJS engine persists through
 * `world.experimental_snapshots` (compress, then encrypt on save; the inverse
 * on load), and the checks a stored snapshot must pass before its heap is
 * handed to the engine.
 *
 * A snapshot is executable state: bytecode, closures and pending
 * continuations that run with access to every host callback. So a load
 * treats storage as untrusted input:
 *
 * - The restore-relevant metadata is sealed INSIDE the encrypted payload,
 *   bound to the run id, and must equal the metadata the World returned.
 *   With an encryption key that makes the pairing authenticated: bytes from
 *   one snapshot can't be combined with another's metadata (a wrong cursor
 *   silently replays from the wrong log position), and nothing
 *   restore-relevant can be edited in the plaintext envelope. Without a key
 *   the same check still catches torn or mismatched writes.
 * - A run that has an encryption key only accepts encrypted snapshots, so a
 *   plaintext blob written to storage can't bypass encryption.
 * - Decompression is capped, so a small compressed blob can't inflate
 *   without bound.
 * - Numeric fields that drive host-side work before the VM exists (the PRNG
 *   fast-forward runs `rngDraws` synchronous draws) are bounded.
 */

import type { SnapshotMetadata } from '@workflow/world';
import {
  compress,
  DecompressedSizeLimitError,
  decompress,
} from '../serialization/compression.js';
import {
  decrypt as decryptSerializedData,
  encrypt as encryptSerializedData,
  type RunPayloadKeys,
} from '../serialization/encryption.js';
import { isEncrypted } from '../serialization/format.js';

/**
 * Plaintext size ceiling for persisted VM snapshots. A heap beyond this
 * costs more to store, encrypt and decompress than the replay it saves.
 * Captures over it are not saved, and loads refuse to inflate past it.
 */
export const MAX_SNAPSHOT_PLAINTEXT_BYTES = 32 * 1024 * 1024;

/**
 * Upper bound on `rngDraws` accepted from a stored snapshot. The restore
 * fast-forwards the run's PRNG that many draws synchronously before the VM
 * exists (about 70 ns per draw), so an unbounded value is a hang. A run that
 * legitimately drew more than this restores by full replay instead.
 */
export const MAX_SNAPSHOT_RNG_DRAWS = 10_000_000;

const FRAME_MAGIC = [0x57, 0x51, 0x53, 0x46]; // "WQSF"
const FRAME_HEADER_LEN = 8;
/** Room for the frame header and sealed metadata on top of the heap. */
const MAX_FRAME_OVERHEAD_BYTES = 64 * 1024;

/** Why a stored snapshot was not restored. */
export type SnapshotRejectReason =
  | 'unencrypted'
  | 'undecryptable'
  | 'too_large'
  | 'malformed'
  | 'metadata_mismatch'
  | 'out_of_bounds';

export class SnapshotRejectedError extends Error {
  constructor(
    readonly reason: SnapshotRejectReason,
    message: string
  ) {
    super(message);
    this.name = 'SnapshotRejectedError';
  }
}

/**
 * The metadata fields a restore depends on, in a fixed order, bound to the
 * run. Absent optional fields serialize as `null` so both sides agree.
 */
function canonicalSealedMetadata(
  runId: string,
  metadata: SnapshotMetadata
): string {
  return JSON.stringify([
    runId,
    metadata.eventsCursor ?? null,
    metadata.eventCount ?? null,
    metadata.rngDraws ?? null,
    metadata.lastUlid ?? null,
    metadata.serdeRootPtr ?? null,
    metadata.clockMs ?? null,
    metadata.engineVersion ?? null,
    metadata.formatVersion ?? null,
  ]);
}

/**
 * Bounds on metadata values the runtime acts on before it can validate the
 * heap itself. Checked on the World-supplied metadata before any decrypt or
 * decompress work, so an out-of-range value costs nothing.
 */
export function checkSnapshotMetadataBounds(
  metadata: SnapshotMetadata
): string | undefined {
  const { rngDraws, serdeRootPtr, eventCount } = metadata;
  if (
    rngDraws !== undefined &&
    (!Number.isSafeInteger(rngDraws) ||
      rngDraws < 0 ||
      rngDraws > MAX_SNAPSHOT_RNG_DRAWS)
  ) {
    return `rngDraws ${rngDraws} is outside [0, ${MAX_SNAPSHOT_RNG_DRAWS}]`;
  }
  if (
    serdeRootPtr !== undefined &&
    (!Number.isSafeInteger(serdeRootPtr) ||
      serdeRootPtr < 0 ||
      serdeRootPtr > 0xffffffff)
  ) {
    return `serdeRootPtr ${serdeRootPtr} is not a 32-bit address`;
  }
  if (
    eventCount !== undefined &&
    (!Number.isSafeInteger(eventCount) || eventCount < 0)
  ) {
    return `eventCount ${eventCount} is not a non-negative integer`;
  }
  return undefined;
}

/**
 * Encode a captured heap for storage: frame it with its sealed metadata,
 * compress, then encrypt (ciphertext doesn't compress, so compression comes
 * first). Returns the bytes to hand to `experimental_snapshots.save`.
 */
export async function sealSnapshot(params: {
  runId: string;
  heap: Uint8Array;
  metadata: SnapshotMetadata;
  encryptionKey: RunPayloadKeys | undefined;
}): Promise<Uint8Array> {
  const sealed = new TextEncoder().encode(
    canonicalSealedMetadata(params.runId, params.metadata)
  );
  const frame = new Uint8Array(
    FRAME_HEADER_LEN + sealed.length + params.heap.length
  );
  frame.set(FRAME_MAGIC, 0);
  new DataView(frame.buffer).setUint32(4, sealed.length, true);
  frame.set(sealed, FRAME_HEADER_LEN);
  frame.set(params.heap, FRAME_HEADER_LEN + sealed.length);

  const compressed = (await compress(frame, true, undefined, {
    preferAsync: true,
  })) as Uint8Array;
  return (await encryptSerializedData(
    compressed,
    params.encryptionKey
  )) as Uint8Array;
}

/**
 * Decode stored snapshot bytes back to the heap image, enforcing every
 * check in the module doc. Throws {@link SnapshotRejectedError}; the caller
 * treats that as a miss and falls back to full replay.
 */
export async function openSnapshot(params: {
  runId: string;
  stored: Uint8Array;
  metadata: SnapshotMetadata;
  encryptionKey: RunPayloadKeys | undefined;
}): Promise<Uint8Array> {
  const { runId, stored, metadata, encryptionKey } = params;
  if (encryptionKey && !isEncrypted(stored)) {
    throw new SnapshotRejectedError(
      'unencrypted',
      'snapshot is not encrypted but the run has an encryption key'
    );
  }
  let decrypted: unknown;
  try {
    decrypted = await decryptSerializedData(stored, encryptionKey);
  } catch (err) {
    throw new SnapshotRejectedError(
      'undecryptable',
      `snapshot could not be decrypted: ${(err as Error)?.message}`
    );
  }
  let frame: unknown;
  try {
    frame = await decompress(decrypted, undefined, {
      maxOutputBytes: MAX_SNAPSHOT_PLAINTEXT_BYTES + MAX_FRAME_OVERHEAD_BYTES,
    });
  } catch (err) {
    if (err instanceof DecompressedSizeLimitError) {
      throw new SnapshotRejectedError(
        'too_large',
        `snapshot inflates past ${err.maxOutputBytes} bytes`
      );
    }
    throw new SnapshotRejectedError(
      'malformed',
      `snapshot could not be decompressed: ${(err as Error)?.message}`
    );
  }
  if (!(frame instanceof Uint8Array) || frame.length < FRAME_HEADER_LEN) {
    throw new SnapshotRejectedError('malformed', 'snapshot frame is truncated');
  }
  for (let i = 0; i < FRAME_MAGIC.length; i++) {
    if (frame[i] !== FRAME_MAGIC[i]) {
      throw new SnapshotRejectedError(
        'malformed',
        'snapshot frame has an unknown header'
      );
    }
  }
  const sealedLen = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength
  ).getUint32(4, true);
  if (FRAME_HEADER_LEN + sealedLen > frame.length) {
    throw new SnapshotRejectedError('malformed', 'snapshot frame is truncated');
  }
  const sealed = new TextDecoder().decode(
    frame.subarray(FRAME_HEADER_LEN, FRAME_HEADER_LEN + sealedLen)
  );
  if (sealed !== canonicalSealedMetadata(runId, metadata)) {
    throw new SnapshotRejectedError(
      'metadata_mismatch',
      'snapshot metadata does not match the metadata sealed with its bytes'
    );
  }
  return frame.subarray(FRAME_HEADER_LEN + sealedLen);
}
