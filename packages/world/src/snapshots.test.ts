import { describe, expect, it } from 'vitest';
import {
  decodeSnapshotEnvelope,
  encodeSnapshotEnvelope,
  type SnapshotMetadata,
} from './snapshots.js';

const metadata: SnapshotMetadata = {
  eventsCursor: 'evnt_01ABC',
  createdAt: new Date('2025-06-01T12:00:00.000Z'),
};

describe('snapshot envelope', () => {
  it('round-trips metadata and data through one blob', () => {
    const data = new Uint8Array(4096).map((_, i) => i % 251);
    const envelope = encodeSnapshotEnvelope(metadata, data);
    const decoded = decodeSnapshotEnvelope(envelope);
    expect(decoded).not.toBeNull();
    expect(decoded!.metadata.eventsCursor).toBe('evnt_01ABC');
    expect(decoded!.metadata.createdAt).toEqual(metadata.createdAt);
    expect(Buffer.from(decoded!.data)).toEqual(Buffer.from(data));
  });

  it('round-trips a null events cursor (no truthiness coercion)', () => {
    const envelope = encodeSnapshotEnvelope(
      { ...metadata, eventsCursor: null },
      new Uint8Array([1])
    );
    const decoded = decodeSnapshotEnvelope(envelope);
    expect(decoded!.metadata.eventsCursor).toBeNull();
  });

  it('round-trips metadata fields this schema does not know about (forward compat)', () => {
    // The envelope carries the WHOLE metadata object — fields added by a
    // NEWER schema must survive a decode by this one, or adding metadata
    // would silently drop it through older storage layers.
    const rich = {
      ...metadata,
      eventCount: 42,
      rngDraws: 7,
      formatVersion: 2,
    } as SnapshotMetadata;
    const decoded = decodeSnapshotEnvelope(
      encodeSnapshotEnvelope(rich, new Uint8Array([9]))
    );
    expect(decoded!.metadata).toMatchObject({ eventsCursor: 'evnt_01ABC' });
    expect((decoded!.metadata as Record<string, unknown>).eventCount).toBe(42);
    expect((decoded!.metadata as Record<string, unknown>).rngDraws).toBe(7);
  });

  it('returns null for non-envelope bytes (legacy/foreign blob)', () => {
    expect(decodeSnapshotEnvelope(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeSnapshotEnvelope(new Uint8Array(64).fill(0xab))).toBeNull();
    expect(decodeSnapshotEnvelope(new Uint8Array(0))).toBeNull();
  });

  it('returns null for an unknown envelope version', () => {
    const envelope = encodeSnapshotEnvelope(metadata, new Uint8Array([1]));
    envelope[4] = 99;
    expect(decodeSnapshotEnvelope(envelope)).toBeNull();
  });

  it('returns null for a truncated envelope', () => {
    const envelope = encodeSnapshotEnvelope(metadata, new Uint8Array(100));
    // Cut into the metadata region.
    expect(decodeSnapshotEnvelope(envelope.subarray(0, 12))).toBeNull();
  });

  it('returns null for schema-invalid metadata', () => {
    const bad = encodeSnapshotEnvelope(
      { eventsCursor: 123, createdAt: 'not-a-date' } as never,
      new Uint8Array([1])
    );
    expect(decodeSnapshotEnvelope(bad)).toBeNull();
  });

  it('decodes from a non-zero byteOffset view', () => {
    const envelope = encodeSnapshotEnvelope(metadata, new Uint8Array([7, 8]));
    const padded = new Uint8Array(envelope.length + 16);
    padded.set(envelope, 16);
    const view = padded.subarray(16);
    const decoded = decodeSnapshotEnvelope(view);
    expect(decoded).not.toBeNull();
    expect(Array.from(decoded!.data)).toEqual([7, 8]);
  });
});
