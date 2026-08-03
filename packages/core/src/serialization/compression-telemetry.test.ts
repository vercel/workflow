/**
 * Verifies that the dehydrate/hydrate wrappers emit compression telemetry
 * onto the active span. The telemetry module is mocked so `getActiveSpan`
 * returns a fake span whose `setAttributes` calls are captured.
 */
import { describe, expect, it, vi } from 'vitest';

const { recordedAttributes } = vi.hoisted(() => ({
  recordedAttributes: [] as Array<Record<string, unknown>>,
}));

vi.mock('../telemetry.js', () => ({
  getActiveSpan: vi.fn(async () => ({
    setAttributes: (attrs: Record<string, unknown>) => {
      recordedAttributes.push(attrs);
    },
  })),
}));

import {
  dehydrateStepReturnValue,
  hydrateStepReturnValue,
} from '../serialization.js';

function makeCompressibleValue(items = 200) {
  return {
    users: Array.from({ length: items }, (_, i) => ({
      id: `user_${i}`,
      name: `Test User Number ${i}`,
      email: `test.user.${i}@example.com`,
      role: i % 3 === 0 ? 'admin' : 'member',
    })),
  };
}

/** The most recently recorded span attributes; throws if none were set. */
function lastAttrs(): Record<string, unknown> {
  const attrs = recordedAttributes[recordedAttributes.length - 1];
  if (!attrs) throw new Error('expected compression attributes to be recorded');
  return attrs;
}

describe('compression telemetry attributes', () => {
  it('records write-path attributes with savings when compressed', async () => {
    recordedAttributes.length = 0;
    const value = makeCompressibleValue();

    const data = await dehydrateStepReturnValue(
      value,
      'wrun_test',
      undefined,
      [],
      globalThis,
      false,
      false,
      true // compression enabled
    );

    const attrs = lastAttrs();
    expect(attrs['workflow.serialization.operation']).toBe('serialize');
    expect(attrs['workflow.serialization.compressed']).toBe(true);
    // zstd is the preferred codec when node:zlib has it (Node >= 22.15).
    expect(attrs['workflow.serialization.codec']).toBe('zstd');
    expect(attrs['workflow.serialization.uncompressed_bytes']).toBeGreaterThan(
      attrs['workflow.serialization.stored_bytes'] as number
    );
    const ratio = attrs['workflow.serialization.compression_ratio'] as number;
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);

    // Read path records the inflate with the same logical size.
    recordedAttributes.length = 0;
    const result = await hydrateStepReturnValue(data, 'wrun_test', undefined);
    expect(result).toEqual(value);
    const readAttrs = lastAttrs();
    expect(readAttrs['workflow.serialization.operation']).toBe('deserialize');
    expect(readAttrs['workflow.serialization.compressed']).toBe(true);
    expect(readAttrs['workflow.serialization.uncompressed_bytes']).toBe(
      attrs['workflow.serialization.uncompressed_bytes']
    );
  });

  it('records compressed=false (no ratio) when compression is disabled', async () => {
    recordedAttributes.length = 0;
    await dehydrateStepReturnValue(
      makeCompressibleValue(),
      'wrun_test',
      undefined,
      [],
      globalThis,
      false,
      false,
      false // compression disabled
    );

    const attrs = lastAttrs();
    expect(attrs['workflow.serialization.operation']).toBe('serialize');
    expect(attrs['workflow.serialization.compressed']).toBe(false);
    expect(attrs['workflow.serialization.codec']).toBe('none');
    expect(attrs['workflow.serialization.compression_ratio']).toBeUndefined();
    expect(attrs['workflow.serialization.stored_bytes']).toBe(
      attrs['workflow.serialization.uncompressed_bytes']
    );
  });
});
