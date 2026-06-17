import { afterEach, describe, expect, it } from 'vitest';
import { getRunCapabilities } from '../capabilities.js';
import { importKey } from '../encryption.js';
import {
  dehydrateStepError,
  hydrateStepError,
  hydrateStepReturnValue,
} from '../serialization.js';
import {
  hydrateData,
  hydrateDataWithKey,
  isCompressedData,
} from '../serialization-format.js';
import * as clientModule from './client.js';
import {
  COMPRESSION_MIN_BYTES,
  type CompressionStats,
  compress,
  decompress,
  isCompressed,
} from './compression.js';
import { decrypt } from './encryption.js';
import {
  decodeFormatPrefix,
  encodeWithFormatPrefix,
  peekFormatPrefix,
} from './format.js';
import * as stepModule from './step.js';
import { SerializationFormat } from './types.js';

const textEncoder = new TextEncoder();

/** A large, highly compressible value (repetitive JSON-ish content). */
function makeCompressibleValue(items = 200) {
  return {
    users: Array.from({ length: items }, (_, i) => ({
      id: `user_${i}`,
      name: `Test User Number ${i}`,
      email: `test.user.${i}@example.com`,
      role: i % 3 === 0 ? 'admin' : 'member',
      createdAt: '2026-01-15T10:30:00.000Z',
      preferences: { theme: 'dark', locale: 'en-US', notifications: true },
    })),
  };
}

function makeKey() {
  return importKey(crypto.getRandomValues(new Uint8Array(32)));
}

describe('compression layer (compress/decompress)', () => {
  it('round-trips a compressible payload through compress/decompress', async () => {
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;

    const compressed = await compress(original, true);
    expect(compressed).toBeInstanceOf(Uint8Array);
    expect(isCompressed(compressed)).toBe(true);
    expect((compressed as Uint8Array).length).toBeLessThan(original.length);

    const decompressed = (await decompress(compressed)) as Uint8Array;
    expect(decompressed).toEqual(original);
  });

  it('passes small payloads through unchanged', async () => {
    const small = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode('"hello"')
    ) as Uint8Array;
    expect(small.length).toBeLessThan(COMPRESSION_MIN_BYTES);

    const result = await compress(small, true);
    expect(result).toBe(small);
    expect(isCompressed(result)).toBe(false);
  });

  it('keeps the original when compression does not help (incompressible data)', async () => {
    // Random bytes are incompressible — gzip output would be larger.
    const random = crypto.getRandomValues(new Uint8Array(4096));
    const prefixed = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      random
    ) as Uint8Array;

    const result = await compress(prefixed, true);
    expect(result).toBe(prefixed);
    expect(isCompressed(result)).toBe(false);
  });

  it('does not compress when disabled', async () => {
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;

    const result = await compress(original, false);
    expect(result).toBe(original);
  });

  it('decompress passes non-compressed and non-binary data through', async () => {
    const plain = textEncoder.encode('devl"hello"');
    expect(await decompress(plain)).toBe(plain);
    const legacy = [1, 2, 3];
    expect(await decompress(legacy)).toBe(legacy);
  });
});

describe('CompressionStats telemetry sink', () => {
  function devlBytes(json: string): Uint8Array {
    return encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(json)
    ) as Uint8Array;
  }

  it('records a kept compression on the write path', async () => {
    const original = devlBytes(JSON.stringify(makeCompressibleValue()));
    const stats: CompressionStats = {};
    const compressed = await compress(original, true, stats);

    expect(stats.recorded).toBe(true);
    expect(stats.compressed).toBe(true);
    expect(stats.uncompressedBytes).toBe(original.length);
    expect(stats.storedBytes).toBe((compressed as Uint8Array).length);
    expect(stats.storedBytes!).toBeLessThan(stats.uncompressedBytes!);
  });

  it('records compressed=false for incompressible data (kept original)', async () => {
    const random = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      crypto.getRandomValues(new Uint8Array(4096))
    ) as Uint8Array;
    const stats: CompressionStats = {};
    const result = await compress(random, true, stats);

    expect(result).toBe(random);
    expect(stats.recorded).toBe(true);
    expect(stats.compressed).toBe(false);
    expect(stats.uncompressedBytes).toBe(random.length);
    expect(stats.storedBytes).toBe(random.length);
  });

  it('records compressed=false for below-threshold payloads', async () => {
    const small = devlBytes('"hi"');
    expect(small.length).toBeLessThan(COMPRESSION_MIN_BYTES);
    const stats: CompressionStats = {};
    await compress(small, true, stats);

    expect(stats.recorded).toBe(true);
    expect(stats.compressed).toBe(false);
    expect(stats.uncompressedBytes).toBe(small.length);
    expect(stats.storedBytes).toBe(small.length);
  });

  it('records the uncompressed baseline even when compression is disabled', async () => {
    const original = devlBytes(JSON.stringify(makeCompressibleValue()));
    const stats: CompressionStats = {};
    await compress(original, false, stats);

    expect(stats.recorded).toBe(true);
    expect(stats.compressed).toBe(false);
    expect(stats.uncompressedBytes).toBe(original.length);
    expect(stats.storedBytes).toBe(original.length);
  });

  it('does not record for non-binary (legacy) data', async () => {
    const stats: CompressionStats = {};
    await compress({ not: 'binary' }, true, stats);
    expect(stats.recorded).toBeFalsy();
  });

  it('records the inflate on the read path', async () => {
    const original = devlBytes(JSON.stringify(makeCompressibleValue()));
    const compressed = (await compress(original, true)) as Uint8Array;

    const stats: CompressionStats = {};
    const inflated = (await decompress(compressed, stats)) as Uint8Array;

    expect(inflated).toEqual(original);
    expect(stats.recorded).toBe(true);
    expect(stats.compressed).toBe(true);
    expect(stats.storedBytes).toBe(compressed.length);
    expect(stats.uncompressedBytes).toBe(original.length);
    expect(stats.storedBytes!).toBeLessThan(stats.uncompressedBytes!);
  });

  it('records compressed=false when reading uncompressed data', async () => {
    const plain = devlBytes('"hello"');
    const stats: CompressionStats = {};
    await decompress(plain, stats);

    expect(stats.recorded).toBe(true);
    expect(stats.compressed).toBe(false);
    expect(stats.uncompressedBytes).toBe(plain.length);
    expect(stats.storedBytes).toBe(plain.length);
  });

  it('round-trips stats through the step mode serializer (write + read)', async () => {
    const value = makeCompressibleValue();
    const writeStats: CompressionStats = {};
    const data = await stepModule.serialize(value, undefined, {
      compression: true,
      compressionStats: writeStats,
    });
    expect(writeStats.compressed).toBe(true);

    const readStats: CompressionStats = {};
    const result = await stepModule.deserialize(data, undefined, {
      compressionStats: readStats,
    });
    expect(result).toEqual(value);
    expect(readStats.compressed).toBe(true);
    expect(readStats.uncompressedBytes).toBe(writeStats.uncompressedBytes);
  });
});

describe('WORKFLOW_DISABLE_COMPRESSION kill switch', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_DISABLE_COMPRESSION;
  });

  it('disables write-side compression', async () => {
    process.env.WORKFLOW_DISABLE_COMPRESSION = '1';
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;

    const result = await compress(original, true);
    expect(result).toBe(original);
  });

  it('does not affect reads of already-compressed data', async () => {
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;
    const compressed = await compress(original, true);
    expect(isCompressed(compressed)).toBe(true);

    process.env.WORKFLOW_DISABLE_COMPRESSION = '1';
    const decompressed = (await decompress(compressed)) as Uint8Array;
    expect(decompressed).toEqual(original);
  });
});

describe('mode serializers with compression', () => {
  it('step serialize/deserialize round-trips with compression enabled', async () => {
    const value = makeCompressibleValue();

    const compressed = await stepModule.serialize(value, undefined, {
      compression: true,
    });
    // zstd is the preferred codec when available (node:zlib >= 22.15).
    expect(peekFormatPrefix(compressed)).toBe(SerializationFormat.ZSTD);

    const uncompressed = await stepModule.serialize(value, undefined, {});
    expect(peekFormatPrefix(uncompressed)).toBe(SerializationFormat.DEVALUE_V1);
    expect((compressed as Uint8Array).length).toBeLessThan(
      (uncompressed as Uint8Array).length
    );

    const result = await stepModule.deserialize(compressed, undefined, {});
    expect(result).toEqual(value);
  });

  it('client serialize/deserialize round-trips with compression enabled', async () => {
    const value = makeCompressibleValue();
    const data = await clientModule.serialize(value, undefined, {
      compression: true,
    });
    expect(peekFormatPrefix(data)).toBe(SerializationFormat.ZSTD);
    const result = await clientModule.deserialize(data, undefined, {});
    expect(result).toEqual(value);
  });

  it('nests compression inside encryption: encr(zstd(devl))', async () => {
    const key = await makeKey();
    const value = makeCompressibleValue();

    const data = await stepModule.serialize(value, key, {
      compression: true,
    });
    // Outer layer must be encryption (encrypted bytes don't compress)
    expect(peekFormatPrefix(data)).toBe(SerializationFormat.ENCRYPTED);

    // White-box: the decrypted inner payload carries the codec prefix
    const inner = await decrypt(data, key);
    expect(peekFormatPrefix(inner)).toBe(SerializationFormat.ZSTD);
    const { payload: deflated } = decodeFormatPrefix(inner);
    expect(deflated.length).toBeGreaterThan(0);

    // Full round-trip through the public API
    const result = await stepModule.deserialize(data, key, {});
    expect(result).toEqual(value);
  });

  it('deserializes uncompressed data written without compression (backwards compat)', async () => {
    const value = makeCompressibleValue();
    const data = await stepModule.serialize(value, undefined, {});
    expect(peekFormatPrefix(data)).toBe(SerializationFormat.DEVALUE_V1);
    const result = await stepModule.deserialize(data, undefined, {});
    expect(result).toEqual(value);
  });

  it('hydrateStepReturnValue (workflow replay path) decompresses step outputs', async () => {
    const value = makeCompressibleValue();
    const data = await stepModule.serialize(value, undefined, {
      compression: true,
    });
    const result = await hydrateStepReturnValue(data, 'wrun_test', undefined);
    expect(result).toEqual(value);
  });

  it('small values stay uncompressed even with compression enabled', async () => {
    const data = await stepModule.serialize({ ok: true }, undefined, {
      compression: true,
    });
    expect(peekFormatPrefix(data)).toBe(SerializationFormat.DEVALUE_V1);
  });
});

describe('codec selection (zstd preferred, gzip fallback)', () => {
  afterEach(() => {
    delete process.env.WORKFLOW_COMPRESSION_CODEC;
  });

  it('prefers zstd by default and reports it in stats', async () => {
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;
    const stats: CompressionStats = {};
    const compressed = await compress(original, true, stats);
    expect(isCompressed(compressed)).toBe(true);
    expect(peekFormatPrefix(compressed)).toBe(SerializationFormat.ZSTD);
    expect(stats.codec).toBe('zstd');
  });

  it('WORKFLOW_COMPRESSION_CODEC=gzip forces the portable codec', async () => {
    process.env.WORKFLOW_COMPRESSION_CODEC = 'gzip';
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;
    const stats: CompressionStats = {};
    const compressed = await compress(original, true, stats);
    expect(peekFormatPrefix(compressed)).toBe(SerializationFormat.GZIP);
    expect(stats.codec).toBe('gzip');

    // Read path still inflates gzip and reports the codec.
    const readStats: CompressionStats = {};
    const inflated = (await decompress(compressed, readStats)) as Uint8Array;
    expect(inflated).toEqual(original);
    expect(readStats.codec).toBe('gzip');
  });

  it('decompress handles both zstd and gzip prefixes (mixed log)', async () => {
    const original = encodeWithFormatPrefix(
      SerializationFormat.DEVALUE_V1,
      textEncoder.encode(JSON.stringify(makeCompressibleValue()))
    ) as Uint8Array;

    const zstd = (await compress(original, true)) as Uint8Array;
    expect(peekFormatPrefix(zstd)).toBe(SerializationFormat.ZSTD);

    process.env.WORKFLOW_COMPRESSION_CODEC = 'gzip';
    const gzip = (await compress(original, true)) as Uint8Array;
    expect(peekFormatPrefix(gzip)).toBe(SerializationFormat.GZIP);
    delete process.env.WORKFLOW_COMPRESSION_CODEC;

    // Both decode regardless of the current write-side codec setting.
    expect(await decompress(zstd)).toEqual(original);
    expect(await decompress(gzip)).toEqual(original);
  });
});

describe('dehydrateStepError with compression', () => {
  it('compresses large errors and round-trips through hydrateStepError', async () => {
    const error = new Error('boom');
    // Inflate the stack to push the payload over the compression threshold
    error.stack = `Error: boom\n${'    at someVeryLongFunctionName (/app/node_modules/some-package/dist/index.js:123:45)\n'.repeat(50)}`;

    const data = await dehydrateStepError(
      error,
      'wrun_test',
      undefined,
      [],
      globalThis,
      true
    );
    expect(peekFormatPrefix(data)).toBe(SerializationFormat.ZSTD);

    const hydrated = (await hydrateStepError(
      data,
      'wrun_test',
      undefined
    )) as Error;
    expect(hydrated).toBeInstanceOf(Error);
    expect(hydrated.message).toBe('boom');
    expect(hydrated.stack).toBe(error.stack);
  });
});

describe('o11y hydration of compressed payloads', () => {
  it('hydrateData (sync, Node) decompresses gzip payloads', async () => {
    const value = makeCompressibleValue();
    const data = await stepModule.serialize(value, undefined, {
      compression: true,
    });
    expect(isCompressedData(data)).toBe(true);
    const hydrated = hydrateData(data, {});
    expect(hydrated).toEqual(value);
  });

  it('hydrateDataWithKey decompresses encrypted + compressed payloads', async () => {
    const key = await makeKey();
    const value = makeCompressibleValue();
    const data = await stepModule.serialize(value, key, {
      compression: true,
    });
    const hydrated = await hydrateDataWithKey(data, {}, key);
    expect(hydrated).toEqual(value);
  });

  it('hydrateDataWithKey decompresses unencrypted compressed payloads', async () => {
    const value = makeCompressibleValue();
    const data = await stepModule.serialize(value, undefined, {
      compression: true,
    });
    const hydrated = await hydrateDataWithKey(data, {}, undefined);
    expect(hydrated).toEqual(value);
  });
});

describe('run capabilities for compression codecs', () => {
  // gzip and zstd co-ship, so both are gated on the same min version.
  for (const fmt of [
    SerializationFormat.GZIP,
    SerializationFormat.ZSTD,
  ] as const) {
    it(`supports ${fmt} for core versions >= 5.0.0-beta.16`, () => {
      expect(
        getRunCapabilities('5.0.0-beta.16').supportedFormats.has(fmt)
      ).toBe(true);
    });

    it(`does not support ${fmt} for older core versions`, () => {
      for (const version of ['5.0.0-beta.15', '4.2.1', '4.0.0']) {
        expect(getRunCapabilities(version).supportedFormats.has(fmt)).toBe(
          false
        );
      }
    });

    it(`assumes no ${fmt} support when the version is unknown`, () => {
      expect(getRunCapabilities(undefined).supportedFormats.has(fmt)).toBe(
        false
      );
    });
  }
});
