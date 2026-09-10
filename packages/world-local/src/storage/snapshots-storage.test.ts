import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotsStorage } from './snapshots-storage.js';

describe('snapshots storage (world-local)', () => {
  let testDir: string;
  let snapshots: ReturnType<typeof createSnapshotsStorage>;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snapshots-test-'));
    snapshots = createSnapshotsStorage(testDir);
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('returns null when no snapshot exists', async () => {
    expect(await snapshots.load('wrun_missing')).toBeNull();
  });

  it('round-trips snapshot bytes and metadata', async () => {
    const data = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const createdAt = new Date('2025-06-01T12:00:00Z');
    await snapshots.save('wrun_a', data, {
      eventsCursor: 'evnt_123',
      createdAt,
    });

    const loaded = await snapshots.load('wrun_a');
    expect(loaded).not.toBeNull();
    expect(new Uint8Array(loaded!.data)).toEqual(data);
    expect(loaded!.metadata.eventsCursor).toBe('evnt_123');
    expect(+loaded!.metadata.createdAt).toBe(+createdAt);
  });

  it('overwrites the previous snapshot on save', async () => {
    await snapshots.save('wrun_a', new Uint8Array([1]), {
      eventsCursor: null,
      createdAt: new Date(),
    });
    await snapshots.save('wrun_a', new Uint8Array([9, 9]), {
      eventsCursor: 'evnt_9',
      createdAt: new Date(),
    });

    const loaded = await snapshots.load('wrun_a');
    expect(new Uint8Array(loaded!.data)).toEqual(new Uint8Array([9, 9]));
    expect(loaded!.metadata.eventsCursor).toBe('evnt_9');
  });

  it('supports a null events cursor', async () => {
    await snapshots.save('wrun_b', new Uint8Array([7]), {
      eventsCursor: null,
      createdAt: new Date(),
    });
    const loaded = await snapshots.load('wrun_b');
    expect(loaded!.metadata.eventsCursor).toBeNull();
  });

  it('delete removes the snapshot (idempotent)', async () => {
    await snapshots.save('wrun_c', new Uint8Array([1]), {
      eventsCursor: null,
      createdAt: new Date(),
    });
    await snapshots.delete('wrun_c');
    expect(await snapshots.load('wrun_c')).toBeNull();
    // Deleting again is a no-op.
    await snapshots.delete('wrun_c');
  });

  it('stores metadata and bytes in ONE file (atomic pairing — no torn save)', async () => {
    await snapshots.save('wrun_atomic', new Uint8Array([1, 2, 3]), {
      eventsCursor: 'evnt_x',
      createdAt: new Date(),
    });
    const files = await fs.readdir(path.join(testDir, 'snapshots'));
    expect(files).toEqual(['wrun_atomic.snapshot']);
  });

  it('treats a corrupt envelope file as a miss instead of returning torn state', async () => {
    await snapshots.save('wrun_corrupt', new Uint8Array([1, 2, 3]), {
      eventsCursor: 'evnt_x',
      createdAt: new Date(),
    });
    await fs.writeFile(
      path.join(testDir, 'snapshots', 'wrun_corrupt.snapshot'),
      Buffer.from([0xde, 0xad])
    );
    expect(await snapshots.load('wrun_corrupt')).toBeNull();
  });

  it('rejects path-traversal runIds on every operation', async () => {
    const hostile = [
      '../escape',
      '..',
      'a/b',
      'a\\b',
      'nul\0byte',
      '.hidden',
      'dotted.name',
      '',
    ];
    const metadata = { eventsCursor: null, createdAt: new Date() };
    for (const runId of hostile) {
      await expect(
        snapshots.save(runId, new Uint8Array([1]), metadata)
      ).rejects.toThrow(/unsafe|invalid/i);
      await expect(snapshots.load(runId)).rejects.toThrow(/unsafe|invalid/i);
      await expect(snapshots.delete(runId)).rejects.toThrow(/unsafe|invalid/i);
    }
  });
});
