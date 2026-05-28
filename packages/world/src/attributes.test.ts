import { describe, expect, it } from 'vitest';
import {
  applyAttributeChanges,
  ATTRIBUTE_KEY_MAX_LENGTH,
  ATTRIBUTE_MAX_PER_RUN,
  AttributeValidationError,
  validateAttributeChanges,
  validateAttributeKey,
  validateAttributeValue,
} from './attributes.js';

describe('validateAttributeKey', () => {
  it('accepts a normal key', () => {
    expect(validateAttributeKey('phase')).toBeNull();
  });

  it('rejects empty keys', () => {
    expect(validateAttributeKey('')).toBeInstanceOf(AttributeValidationError);
  });

  it('rejects keys over the length cap', () => {
    expect(
      validateAttributeKey('k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH + 1))
    ).toBeInstanceOf(AttributeValidationError);
  });

  it('accepts keys exactly at the length cap', () => {
    expect(
      validateAttributeKey('k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH))
    ).toBeNull();
  });

  it('rejects keys starting with the reserved prefix by default', () => {
    expect(validateAttributeKey('$internal')).toBeInstanceOf(
      AttributeValidationError
    );
  });

  it('accepts reserved-prefix keys when allowReservedAttributes is set', () => {
    expect(
      validateAttributeKey('$internal', { allowReservedAttributes: true })
    ).toBeNull();
  });

  it('still rejects reserved-prefix keys when allowReservedAttributes is explicitly false', () => {
    expect(
      validateAttributeKey('$internal', { allowReservedAttributes: false })
    ).toBeInstanceOf(AttributeValidationError);
  });
});

describe('validateAttributeValue', () => {
  it('accepts null (unset)', () => {
    expect(validateAttributeValue(null)).toBeNull();
  });

  it('accepts a normal string', () => {
    expect(validateAttributeValue('hello')).toBeNull();
  });

  it('rejects values over the byte cap', () => {
    expect(validateAttributeValue('a'.repeat(257))).toBeInstanceOf(
      AttributeValidationError
    );
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 4-byte UTF-8 emoji; 64 of them = 256 bytes exactly (at the cap)
    const at = '💥'.repeat(64);
    expect(validateAttributeValue(at)).toBeNull();
    const over = '💥'.repeat(65); // 260 bytes, over
    expect(validateAttributeValue(over)).toBeInstanceOf(
      AttributeValidationError
    );
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
