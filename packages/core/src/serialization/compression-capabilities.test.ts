import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@workflow/world/serialization-compression.js', () => ({
  decompressSerializedDataSync: vi.fn(),
  getNativeCompressionCodec: vi.fn(() => undefined),
}));

import { compress } from './compression.js';

afterEach(() => {
  delete process.env.WORKFLOW_COMPRESSION_CODEC;
  vi.unstubAllGlobals();
});

it('does not write portable gzip without a matching reader', async () => {
  process.env.WORKFLOW_COMPRESSION_CODEC = 'gzip';
  const CompressionStream = vi.fn();
  vi.stubGlobal('CompressionStream', CompressionStream);
  vi.stubGlobal('DecompressionStream', undefined);

  const data = new Uint8Array(2048);

  await expect(compress(data, true)).resolves.toBe(data);
  expect(CompressionStream).not.toHaveBeenCalled();
});
