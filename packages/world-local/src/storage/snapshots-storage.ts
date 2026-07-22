import fs from 'node:fs/promises';
import path from 'node:path';
import type { SnapshotMetadata } from '@workflow/world';
import { SnapshotMetadataSchema } from '@workflow/world';
import { ensureDir, readBuffer, readJSON, write, writeJSON } from '../fs.js';

/**
 * Create the snapshots sub-storage for a local World implementation.
 *
 * Snapshots are stored as two files per run:
 *   {basedir}/snapshots/{runId}.bin    — opaque VM snapshot bytes
 *   {basedir}/snapshots/{runId}.json   — metadata (eventsCursor, createdAt)
 *
 * Compression and encryption are handled by `@workflow/core`'s snapshot
 * entrypoint (`compress → encrypt → save`); this world layer stores the
 * resulting bytes verbatim.
 */
export function createSnapshotsStorage(basedir: string) {
  const snapshotsDir = path.join(basedir, 'snapshots');

  function dataPath(runId: string): string {
    return path.join(snapshotsDir, `${runId}.bin`);
  }
  function metadataPath(runId: string): string {
    return path.join(snapshotsDir, `${runId}.json`);
  }

  return {
    async save(
      runId: string,
      data: Uint8Array,
      metadata: SnapshotMetadata
    ): Promise<void> {
      await ensureDir(snapshotsDir);
      await Promise.all([
        write(dataPath(runId), Buffer.from(data), { overwrite: true }),
        writeJSON(metadataPath(runId), metadata, { overwrite: true }),
      ]);
    },

    async load(
      runId: string
    ): Promise<{ data: Uint8Array; metadata: SnapshotMetadata } | null> {
      const metadata = await readJSON(
        metadataPath(runId),
        SnapshotMetadataSchema
      );
      if (!metadata) return null;

      try {
        const dataBuf = await readBuffer(dataPath(runId));
        const data = new Uint8Array(
          dataBuf.buffer,
          dataBuf.byteOffset,
          dataBuf.byteLength
        );
        return { data, metadata };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return null;
        }
        throw error;
      }
    },

    async delete(runId: string): Promise<void> {
      await Promise.all([
        fs.rm(dataPath(runId), { force: true }),
        fs.rm(metadataPath(runId), { force: true }),
      ]);
    },
  };
}
