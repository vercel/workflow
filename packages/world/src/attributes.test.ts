import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTE_KEY_MAX_LENGTH,
  ATTRIBUTE_MAX_PER_RUN,
  AttributeChangeSchema,
  AttributeChangesSchema,
  AttributeKeySchema,
  AttributeValidationError,
  AttributeValueSchema,
  applyAttributeChanges,
  validateAttributeChanges,
} from './attributes.js';

describe('attribute schemas', () => {
  it('accepts a normal key', () => {
    expect(AttributeKeySchema.safeParse('phase').success).toBe(true);
  });

  it('rejects empty keys', () => {
    expect(AttributeKeySchema.safeParse('').success).toBe(false);
  });

  it('rejects keys over the length cap', () => {
    expect(
      AttributeKeySchema.safeParse('k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH + 1))
        .success
    ).toBe(false);
  });

  it('accepts keys exactly at the length cap', () => {
    expect(
      AttributeKeySchema.safeParse('k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH)).success
    ).toBe(true);
  });

  it('accepts null (unset)', () => {
    expect(AttributeValueSchema.safeParse(null).success).toBe(true);
  });

  it('accepts a normal string', () => {
    expect(AttributeValueSchema.safeParse('hello').success).toBe(true);
  });

  it('rejects values over the byte cap', () => {
    expect(AttributeValueSchema.safeParse('a'.repeat(257)).success).toBe(false);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 4-byte UTF-8 emoji; 64 of them = 256 bytes exactly (at the cap)
    const at = '💥'.repeat(64);
    expect(AttributeValueSchema.safeParse(at).success).toBe(true);
    const over = '💥'.repeat(65); // 260 bytes, over
    expect(AttributeValueSchema.safeParse(over).success).toBe(false);
  });

  it('validates complete changes and batches', () => {
    expect(
      AttributeChangeSchema.safeParse({ key: 'phase', value: 'running' })
        .success
    ).toBe(true);
    expect(
      AttributeChangeSchema.safeParse({ key: '', value: 'running' }).success
    ).toBe(false);
    expect(
      AttributeChangesSchema.safeParse([
        { key: 'phase', value: 'running' },
        { key: 'phase', value: 'done' },
      ]).success
    ).toBe(false);
  });

  it('rejects batches over the per-run cap', () => {
    const changes = Array.from(
      { length: ATTRIBUTE_MAX_PER_RUN + 1 },
      (_, i) => ({ key: `k${i}`, value: 'v' })
    );
    expect(AttributeChangesSchema.safeParse(changes).success).toBe(false);
  });

  it('leaves reserved-key policy to the contextual validator', () => {
    expect(
      AttributeChangesSchema.safeParse([
        { key: '$framework.kind', value: 'agent' },
      ]).success
    ).toBe(true);
  });
});

describe('validateAttributeChanges', () => {
  it('accepts a small batch of valid changes', () => {
    expect(() =>
      validateAttributeChanges([
        { key: 'phase', value: 'init' },
        { key: 'stale', value: null },
      ])
    ).not.toThrow();
  });

  it('rejects duplicate keys within a single batch', () => {
    expect(() =>
      validateAttributeChanges([
        { key: 'phase', value: 'init' },
        { key: 'phase', value: 'done' },
      ])
    ).toThrow(AttributeValidationError);
  });

  it('rejects when post-merge count exceeds the per-run cap', () => {
    const changes = Array.from({ length: ATTRIBUTE_MAX_PER_RUN }, (_, i) => ({
      key: `k${i}`,
      value: 'v',
    }));
    expect(() =>
      validateAttributeChanges(changes, { existingKeys: ['preexisting'] })
    ).toThrow(AttributeValidationError);
  });

  it('does not let an unknown deletion offset a new attribute', () => {
    const changes: Array<{ key: string; value: string | null }> = Array.from(
      { length: ATTRIBUTE_MAX_PER_RUN + 1 },
      (_, i) => ({ key: `k${i}`, value: 'v' })
    );
    changes.push({ key: 'not-known-to-exist', value: null });

    expect(() => validateAttributeChanges(changes)).toThrow(
      AttributeValidationError
    );
  });

  it('does not count upserts on already-present keys against the cap', () => {
    // 64 keys already exist; the call updates one of them. Post-merge
    // size is still 64 so the cap must accept it.
    const existingKeys = Array.from(
      { length: ATTRIBUTE_MAX_PER_RUN },
      (_, i) => `k${i}`
    );
    expect(() =>
      validateAttributeChanges([{ key: 'k0', value: 'updated' }], {
        existingKeys,
      })
    ).not.toThrow();
  });

  it('rejects reserved-prefix keys in a batch by default', () => {
    expect(() =>
      validateAttributeChanges([
        { key: 'phase', value: 'init' },
        { key: '$framework.kind', value: 'agent' },
      ])
    ).toThrow(AttributeValidationError);
  });

  it('accepts reserved-prefix keys when allowReservedAttributes is set', () => {
    expect(() =>
      validateAttributeChanges(
        [
          { key: 'phase', value: 'init' },
          { key: '$framework.kind', value: 'agent' },
        ],
        { allowReservedAttributes: true }
      )
    ).not.toThrow();
  });
});

describe('applyAttributeChanges', () => {
  it('upserts new keys', () => {
    expect(
      applyAttributeChanges({ a: '1' }, [{ key: 'b', value: '2' }])
    ).toEqual({ a: '1', b: '2' });
  });

  it('overwrites existing keys', () => {
    expect(
      applyAttributeChanges({ a: '1' }, [{ key: 'a', value: '2' }])
    ).toEqual({ a: '2' });
  });

  it('removes keys when value is null', () => {
    expect(
      applyAttributeChanges({ a: '1', b: '2' }, [{ key: 'a', value: null }])
    ).toEqual({ b: '2' });
  });

  it('applies set and unset in a single batch', () => {
    expect(
      applyAttributeChanges({ a: '1', stale: 'x' }, [
        { key: 'stale', value: null },
        { key: 'fresh', value: 'yes' },
      ])
    ).toEqual({ a: '1', fresh: 'yes' });
  });

  it('returns a new object (does not mutate input)', () => {
    const before = { a: '1' };
    const after = applyAttributeChanges(before, [{ key: 'b', value: '2' }]);
    expect(before).toEqual({ a: '1' });
    expect(after).not.toBe(before);
  });

  it('treats undefined existing as the empty record', () => {
    expect(
      applyAttributeChanges(undefined, [{ key: 'a', value: '1' }])
    ).toEqual({ a: '1' });
  });
});
