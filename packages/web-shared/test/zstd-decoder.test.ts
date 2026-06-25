/**
 * Compatibility test for the browser zstd decode path: payloads written by
 * the SDK's `node:zlib` zstd codec must decode via the `@tootallnate/zstd-wasm`
 * decoder the web o11y uses. If these ever disagree, the dashboard can't read
 * compressed runs — so this locks the cross-codec contract in.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';
import { decompressBytes } from '@tootallnate/zstd-wasm';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

let wasmModule: WebAssembly.Module;

beforeAll(async () => {
  const wasmPath = require.resolve('@tootallnate/zstd-wasm/zstd.wasm');
  wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
});

function zstd(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(
    zlib.zstdCompressSync(bytes, {
      params: { [zlib.constants.ZSTD_c_compressionLevel]: 3 },
    })
  );
}

describe('zstd WASM decoder ↔ node:zlib zstd compatibility', () => {
  it('decodes a payload compressed by the SDK codec', async () => {
    const original = new TextEncoder().encode(
      JSON.stringify({
        // Repetitive + varied content, like a real serialized payload.
        users: Array.from({ length: 300 }, (_, i) => ({
          id: `user_${i}`,
          email: `user.${i}@example.com`,
          role: i % 3 === 0 ? 'admin' : 'member',
        })),
      })
    );
    const compressed = zstd(original);
    expect(compressed.length).toBeLessThan(original.length);

    const decoded = await decompressBytes(wasmModule, compressed);
    expect(new Uint8Array(decoded)).toEqual(original);
  });

  it('round-trips an empty and a tiny payload', async () => {
    for (const s of ['', '{}', 'x']) {
      const original = new TextEncoder().encode(s);
      const decoded = await decompressBytes(wasmModule, zstd(original));
      expect(new Uint8Array(decoded)).toEqual(original);
    }
  });
});
