import fs from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotMetadata } from '@workflow/world';
import {
  decodeSnapshotEnvelope,
  encodeSnapshotEnvelope,
} from '@workflow/world';
import {
  assertSafeEntityId,
  ensureDir,
  readBuffer,
  resolveWithinBase,
  write,
} from '../fs.js';

/**
 * Create the snapshots sub-storage for a local World implementation.
 *
 * Snapshots are stored as ONE file per run:
 *   {basedir}/snapshots/{runId}.snapshot — snapshot envelope (metadata +
 *   opaque VM snapshot bytes; see `encodeSnapshotEnvelope`)
 *
 * A single file matters: `write()` is atomic per file (temp + rename),
 * but two files (bytes + metadata) written separately can tear — a crash
 * between the renames, or a concurrent `load` interleaving them, pairs a
 * heap image from one suspension with an `eventsCursor` from another,
 * and the restore silently replays from the wrong log position. The
 * envelope makes the pairing structurally atomic.
 *
 * Compression and encryption are handled by `@workflow/core`'s snapshot
 * entrypoint (`compress → encrypt → save`); this world layer stores the
 * resulting bytes verbatim.
 */
export function createSnapshotsStorage(basedir: string) {
  const snapshotsDir = path.join(basedir, 'snapshots');

  // `runId` arrives from the request body: validate it before it touches a
  // filesystem path (primary defense — rejects `../`, `/`, `\`, NUL, `.`),
  // and contain the join under the snapshots dir (defense in depth), the
  // same two-layer scheme the other world-local storages use.
  function envelopePath(runId: string): string {
    assertSafeEntityId('runId', runId);
    return resolveWithinBase(snapshotsDir, `${runId}.snapshot`);
  }

  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      await ensureDir(snapshotsDir);
      await write(
        envelopePath(runId),
        Buffer.from(encodeSnapshotEnvelope(metadata, data)),
        { overwrite: true }
      );
    },

    async load(
      runId: string
    ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null> {
      let envelope: Buffer;
      try {
        envelope = await readBuffer(envelopePath(runId));
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
      // Anything that fails to decode (truncated, corrupt, unknown
      // version, schema-invalid metadata) is a clean miss — the caller
      // falls back to full replay, never to fabricated metadata.
      return decodeSnapshotEnvelope(
        new Uint8Array(
          envelope.buffer,
          envelope.byteOffset,
          envelope.byteLength
        )
      );
    },

    async delete(runId: string): Promise<void> {
      // `force: true` — idempotent by contract (terminal-state cleanup
      // retries, and runs that never snapshotted delete too).
      await fs.rm(envelopePath(runId), { force: true });
    },
  };
}
