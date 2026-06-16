/**
 * Regression test for the o11y read path on *unencrypted* compressed
 * payloads (e.g. local-world spec-5 runs). Compression is applied before
 * optional encryption, so an unencrypted run still stores `zstd`/`gzip`
 * payloads. The browser sync `hydrateResourceIO` can't decode those, so the
 * web app routes hydration through the async `hydrateResourceIOWithKey`,
 * which must inflate compressed fields even when no key is given.
 */
import { dehydrateStepReturnValue } from '@workflow/core/serialization';
import { describe, expect, it } from 'vitest';
import { hydrateResourceIOWithKey } from '../src/lib/hydration.js';

function makeCompressibleValue() {
  return {
    users: Array.from({ length: 200 }, (_, i) => ({
      id: `user_${i}`,
      email: `user.${i}@example.com`,
      role: i % 3 === 0 ? 'admin' : 'member',
    })),
  };
}

/** Serialize an unencrypted payload, with compression on or off. */
function serialize(value: unknown, compression: boolean) {
  return dehydrateStepReturnValue(
    value,
    'wrun_test',
    undefined, // no encryption key
    [],
    globalThis,
    false, // v1Compat
    false, // framedByteStreams
    compression
  );
}

describe('hydrateResourceIOWithKey on unencrypted compressed payloads', () => {
  it('inflates a compressed input field with no encryption key', async () => {
    const value = makeCompressibleValue();
    const compressed = await serialize(value, true);
    expect(compressed).toBeInstanceOf(Uint8Array);

    const hydrated = await hydrateResourceIOWithKey(
      { input: compressed },
      undefined
    );
    expect(hydrated.input).toEqual(value);
  });

  it('passes through an uncompressed field unchanged', async () => {
    const value = { ok: true, n: 1 };
    const uncompressed = await serialize(value, false);
    const hydrated = await hydrateResourceIOWithKey(
      { output: uncompressed },
      undefined
    );
    expect(hydrated.output).toEqual(value);
  });
});
