import { FatalError } from '@workflow/errors';
import {
  ATTRIBUTE_KEY_MAX_LENGTH,
  ATTRIBUTE_MAX_PER_RUN,
  ATTRIBUTE_VALUE_MAX_BYTES,
  type EventOfType,
} from '@workflow/world';
import { describe, expect, it } from 'vitest';
import { normalizeAttributeChanges } from './attribute-changes.js';

describe('normalizeAttributeChanges', () => {
  it.each<{
    writer: EventOfType<'attr_set'>['eventData']['writer'];
    options: { allowReservedAttributes?: boolean };
  }>([
    { writer: { type: 'workflow' }, options: {} },
    {
      writer: { type: 'workflow' },
      options: { allowReservedAttributes: false },
    },
    {
      writer: { type: 'workflow' },
      options: { allowReservedAttributes: true },
    },
    {
      writer: { type: 'step', stepId: 'step_actual_id', attempt: 12 },
      options: {},
    },
  ])('counts $writer and $options only for attr_set', ({ writer, options }) => {
    const changes = Array.from({ length: 30 }, (_, i) => ({
      key: `k${i}`.padEnd(240, 'k'),
      value: i === 1 ? 'x'.repeat(128) : '',
    }));
    const eventData = {
      changes,
      writer,
      ...(options.allowReservedAttributes
        ? { allowReservedAttributes: true }
        : {}),
    };
    changes[0].value = 'x'.repeat(
      8192 - Buffer.byteLength(JSON.stringify(eventData))
    );
    const attrs = Object.fromEntries(
      changes.map(({ key, value }) => [key, value])
    );
    expect(normalizeAttributeChanges(attrs, options, writer)).toEqual(changes);

    attrs[changes[0].key] += 'x';
    // Initial run attributes have no writer and retain only per-attribute limits.
    const initialChanges = normalizeAttributeChanges(attrs, options);
    expect(
      Buffer.byteLength(
        JSON.stringify({ ...eventData, changes: initialChanges })
      )
    ).toBe(8193);
    expect(() => normalizeAttributeChanges(attrs, options, writer)).toThrow(
      FatalError
    );
    expect(() => normalizeAttributeChanges(attrs, options, writer)).toThrow(
      /8192.*8193.*Split/
    );
  });

  it('converts a record into ordered changes, mapping undefined to null', () => {
    expect(
      normalizeAttributeChanges({ phase: 'init', stale: undefined })
    ).toEqual([
      { key: 'phase', value: 'init' },
      { key: 'stale', value: null },
    ]);
  });

  it('returns an empty array for an empty record', () => {
    expect(normalizeAttributeChanges({})).toEqual([]);
  });

  describe('non-object inputs', () => {
    it.each([
      ['null', null, /got null/],
      ['an array', ['phase', 'init'], /got array/],
      ['a string', 'phase=init', /got string/],
      ['a number', 42, /got number/],
    ])('rejects %s with a FatalError naming the type', (_label, input, re) => {
      let caught: unknown;
      try {
        normalizeAttributeChanges(input as any);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FatalError);
      expect((caught as Error).message).toMatch(re);
      expect((caught as Error).message).toContain(
        'setAttributes requires a plain object'
      );
    });
  });

  describe('validation failures wrap as FatalError with actionable messages', () => {
    it('rejects keys over the length cap, naming the limit', () => {
      let caught: unknown;
      try {
        normalizeAttributeChanges({
          ['k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH + 1)]: 'v',
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FatalError);
      expect((caught as Error).message).toContain(
        `exceeds limit ${ATTRIBUTE_KEY_MAX_LENGTH}`
      );
    });

    it('rejects values over the byte cap, naming the limit', () => {
      let caught: unknown;
      try {
        // 'é' is 2 UTF-8 bytes, so 200 of them exceed the 256-byte cap
        // while staying well under it in character count — the message
        // must make clear the limit is in bytes.
        normalizeAttributeChanges({ note: 'é'.repeat(200) });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FatalError);
      expect((caught as Error).message).toContain(
        `exceeds limit ${ATTRIBUTE_VALUE_MAX_BYTES}`
      );
      expect((caught as Error).message).toContain('byte length 400');
    });

    it('rejects reserved-prefix keys with guidance toward the opt-in', () => {
      let caught: unknown;
      try {
        normalizeAttributeChanges({ $system: 'x' });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FatalError);
      expect((caught as Error).message).toContain('reserved prefix');
      expect((caught as Error).message).toContain('allowReservedAttributes');
    });

    it('accepts reserved-prefix keys with the opt-in flag', () => {
      expect(
        normalizeAttributeChanges(
          { '$agent.kind': 'durable' },
          { allowReservedAttributes: true }
        )
      ).toEqual([{ key: '$agent.kind', value: 'durable' }]);
    });

    it('rejects a single batch over the per-run cap, naming the limit', () => {
      const big: Record<string, string> = {};
      for (let i = 0; i <= ATTRIBUTE_MAX_PER_RUN; i++) {
        big[`key_${i}`] = 'v';
      }
      let caught: unknown;
      try {
        normalizeAttributeChanges(big);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(FatalError);
      expect((caught as Error).message).toContain(
        `exceed limit ${ATTRIBUTE_MAX_PER_RUN}`
      );
    });

    it('accepts a batch exactly at the per-run cap', () => {
      const atCap: Record<string, string> = {};
      for (let i = 0; i < ATTRIBUTE_MAX_PER_RUN; i++) {
        atCap[`key_${i}`] = 'v';
      }
      expect(normalizeAttributeChanges(atCap)).toHaveLength(
        ATTRIBUTE_MAX_PER_RUN
      );
    });

    it('accepts boundary-length keys and values', () => {
      const key = 'k'.repeat(ATTRIBUTE_KEY_MAX_LENGTH);
      const value = 'v'.repeat(ATTRIBUTE_VALUE_MAX_BYTES);
      expect(normalizeAttributeChanges({ [key]: value })).toEqual([
        { key, value },
      ]);
    });
  });
});
